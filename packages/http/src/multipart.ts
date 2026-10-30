/**
 * Streaming `multipart/form-data` parser (RFC 7578, RFC 2046), shared by every adapter so that
 * uploads behave the same on Node.js and Bun.
 *
 * The Web-standard `Request.formData()` is not used: it buffers the whole body before parsing, has
 * no per-part limits, and its results differ between runtimes (default part type, `filename*`,
 * escaped quotes, LF line endings, parts without name). This parser reads the body as it arrives
 * and enforces the upload rules of the route (expected fields, file count, size and media type) on
 * the fly, so an invalid upload is rejected as soon as the offending part shows up. Files are
 * buffered in memory as standard `File` objects, within the limits.
 *
 * Status codes: malformed bodies, unexpected file fields and several files for a single-file field
 * → 400; a file, a field, too many files or too many parts → 413; a refused media type → 415. Errors
 * raised while the body is being read carry `connection: close` (the rest of the body is discarded).
 */
import type { HttpExceptionOptions } from './exceptions.ts'
import type { QueryRecord } from './query.ts'

import { Buffer } from 'node:buffer'

import { BadRequestException, issue, PayloadTooLargeException, UnsupportedMediaTypeException } from './exceptions.ts'
import { matchesMediaType, mediaTypeEssence, OCTET_STREAM } from './mime.ts'
import { formatByteSize } from './size.ts'
import { emptyRecord } from './utils.ts'

/** Constraints of the files received by one upload parameter (`@UploadedFile` / `@UploadedFiles`). */
export interface FileRule {
  /** Field name; `undefined`: the files of every field. */
  readonly field: string | undefined
  /** `@UploadedFiles` (an array) rather than `@UploadedFile` (a single file). */
  readonly multiple: boolean
  /** Maximum size of each file, in bytes. */
  readonly maxSize: number
  /** Maximum number of files (1 for a single file). */
  readonly maxFiles: number
  /** Accepted media types (`image/png`, `image/*`); `undefined`: any. */
  readonly mimeTypes: readonly string[] | undefined
}

/** How a multipart body is read. */
export interface MultipartPolicy {
  /**
   * Upload rules of the route (files are only accepted in their fields: a file in another field is
   * rejected with 400, unless a rule has no field). Without rules, every file is accepted without
   * limit (but the body limit).
   */
  readonly rules: readonly FileRule[]
  /** Maximum number of parts (text fields and files). */
  readonly maxParts: number
  /** Maximum size of a text field, in bytes. */
  readonly maxFieldSize: number
}

/** A parsed multipart body. */
export interface MultipartResult {
  /** Text fields (repeated names → arrays), without prototype. */
  readonly fields: QueryRecord
  /** Files by field name, without prototype. */
  readonly files: Record<string, File[]>
  /** Every file, in body order. */
  readonly list: readonly File[]
  /** Every entry, in body order. */
  readonly entries: readonly (readonly [string, string | File])[]
}

/** Default maximum size of the headers of one part. */
const MAX_HEADER_SIZE = 16 * 1024
/** Maximum transport padding (spaces) after a boundary delimiter. */
const MAX_PADDING = 256
/** Errors raised while the body is still being read ask the client to close the connection. */
const CLOSE: HttpExceptionOptions = Object.freeze({ headers: Object.freeze({ connection: 'close' }) })

const CR = 13
const LF = 10
const DASH = 45
const SPACE = 32
const TAB = 9
const HEADER_END = Buffer.from('\r\n\r\n')
const EMPTY: Buffer = Buffer.alloc(0)
const DECODER = new TextDecoder()

const PRINTABLE = /^[\u0020-\u007e]*$/

/**
 * A received file. Its `type` is the media type declared by the client, lower-cased (empty when it
 * contains characters outside printable ASCII), identical on every runtime (Bun's `File` adds
 * `;charset=utf-8` to some text types).
 */
function createFile(chunks: Uint8Array[], name: string, type: string): File {
  const file = new File(chunks, name, { type })
  const normalized = PRINTABLE.test(type) ? type.toLowerCase() : ''
  if (file.type !== normalized) Object.defineProperty(file, 'type', { value: normalized, configurable: true })
  return file
}

/** Description of a part, from its headers. */
export interface PartInfo {
  readonly name: string
  /** `undefined` for text fields. */
  readonly filename: string | undefined
  readonly contentType: string | undefined
}

/** Receives the content of one part. */
export interface PartSink {
  data(chunk: Uint8Array): void
  end(): void
}

/** Receives the parts found by {@link MultipartParser}. */
export interface PartHandler {
  start(part: PartInfo): PartSink
}

type State = 'preamble' | 'delimiter' | 'headers' | 'body' | 'done'

/**
 * Incremental parser: feed it with {@link write} as chunks arrive, then call {@link end}. Errors
 * (malformed body, limits enforced by the handler) are thrown synchronously from `write`/`end`.
 */
export class MultipartParser {
  readonly #delimiter: Buffer
  readonly #handler: PartHandler
  readonly #maxHeaderSize: number
  /** The body is conceptually prefixed with CRLF so that every delimiter is `CRLF--boundary`. */
  #buffer: Buffer = Buffer.from('\r\n')
  #state: State = 'preamble'
  #sink: PartSink | undefined
  /** Bytes of the header block already searched for its end (avoids rescanning on every chunk). */
  #scanned = 0

  constructor(boundary: string, handler: PartHandler, maxHeaderSize: number = MAX_HEADER_SIZE) {
    this.#delimiter = Buffer.from(`\r\n--${boundary}`, 'latin1')
    this.#handler = handler
    this.#maxHeaderSize = maxHeaderSize
  }

  /** `true` once the closing delimiter was read (what follows is the epilogue, ignored). */
  get done(): boolean {
    return this.#state === 'done'
  }

  write(chunk: Uint8Array): void {
    if (this.#state === 'done' || chunk.byteLength === 0) return
    const view = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    this.#buffer = this.#buffer.length === 0 ? view : Buffer.concat([this.#buffer, view])
    this.#process()
  }

  end(): void {
    if (this.#state !== 'done') throw malformed('unexpected end of the body (missing closing boundary)')
  }

  #process(): void {
    for (;;) {
      switch (this.#state) {
        case 'preamble': {
          const index = this.#buffer.indexOf(this.#delimiter)
          if (index === -1) {
            this.#keepTail()
            return
          }
          this.#buffer = this.#buffer.subarray(index + this.#delimiter.length)
          this.#state = 'delimiter'
          break
        }
        case 'delimiter':
          if (!this.#afterDelimiter()) return
          break
        case 'headers':
          if (!this.#headers()) return
          break
        case 'body':
          if (!this.#body()) return
          break
        default:
          return
      }
    }
  }

  /** After a delimiter: `--` (closing delimiter) or optional padding then CRLF (next part). */
  #afterDelimiter(): boolean {
    const buffer = this.#buffer
    if (buffer.length < 2) return false
    if (buffer[0] === DASH && buffer[1] === DASH) {
      this.#state = 'done'
      this.#buffer = EMPTY
      return false
    }
    let index = 0
    while (index < buffer.length && (buffer[index] === SPACE || buffer[index] === TAB)) index++
    if (index > MAX_PADDING) throw malformed('invalid boundary delimiter')
    if (index + 1 >= buffer.length) return false
    if (buffer[index] !== CR || buffer[index + 1] !== LF) throw malformed('invalid boundary delimiter')
    this.#buffer = buffer.subarray(index + 2)
    this.#state = 'headers'
    return true
  }

  #headers(): boolean {
    const buffer = this.#buffer
    if (buffer.length < 2) return false
    let end: number
    let next: number
    if (buffer[0] === CR && buffer[1] === LF) {
      end = 0
      next = 2
    } else {
      end = buffer.indexOf(HEADER_END, Math.max(0, this.#scanned - (HEADER_END.length - 1)))
      if (end === -1) {
        if (buffer.length > this.#maxHeaderSize) throw malformed('the headers of a part are too large')
        this.#scanned = buffer.length
        return false
      }
      if (end > this.#maxHeaderSize) throw malformed('the headers of a part are too large')
      next = end + 4
    }
    const part = parsePartHeaders(buffer.toString('utf8', 0, end))
    this.#scanned = 0
    this.#buffer = buffer.subarray(next)
    this.#sink = this.#handler.start(part)
    this.#state = 'body'
    return true
  }

  #body(): boolean {
    const buffer = this.#buffer
    const sink = this.#sink as PartSink
    const index = buffer.indexOf(this.#delimiter)
    if (index === -1) {
      // keep what may be the beginning of a delimiter
      const safe = buffer.length - (this.#delimiter.length - 1)
      if (safe > 0) {
        sink.data(buffer.subarray(0, safe))
        this.#buffer = buffer.subarray(safe)
      }
      return false
    }
    if (index > 0) sink.data(buffer.subarray(0, index))
    this.#sink = undefined
    sink.end()
    this.#buffer = buffer.subarray(index + this.#delimiter.length)
    this.#state = 'delimiter'
    return true
  }

  #keepTail(): void {
    const keep = this.#delimiter.length - 1
    if (this.#buffer.length > keep) this.#buffer = this.#buffer.subarray(this.#buffer.length - keep)
  }
}

// -------------------------------------------------------------------------------------------------
// Headers
// -------------------------------------------------------------------------------------------------

function parsePartHeaders(block: string): PartInfo {
  let disposition: string | undefined
  let contentType: string | undefined
  let current: 'content-disposition' | 'content-type' | undefined
  if (block !== '') {
    for (const line of block.split('\r\n')) {
      if (line.startsWith(' ') || line.startsWith('\t')) {
        // obsolete line folding: continuation of the previous header
        if (current === 'content-disposition') disposition = `${disposition ?? ''} ${line.trim()}`
        else if (current === 'content-type') contentType = `${contentType ?? ''} ${line.trim()}`
        continue
      }
      const colon = line.indexOf(':')
      if (colon <= 0) throw malformed('invalid part header')
      const name = line.slice(0, colon).trim().toLowerCase()
      const value = line.slice(colon + 1).trim()
      current = undefined
      if (name === 'content-disposition' && disposition === undefined) {
        disposition = value
        current = name
      } else if (name === 'content-type' && contentType === undefined) {
        contentType = value
        current = name
      }
    }
  }
  if (disposition === undefined) throw malformed('a part has no Content-Disposition header')
  const { type, params } = parseParameters(disposition)
  if (type !== 'form-data') throw malformed('a part is not "form-data"')
  const name = params.get('name')
  if (name === undefined) throw malformed('a part has no name')
  const extended = params.get('filename*')
  const plain = params.get('filename')
  const filename = (extended === undefined ? undefined : decodeExtendedValue(extended)) ?? plain
  return {
    name: decodeFormName(name),
    filename: filename === undefined ? undefined : decodeFormName(filename),
    contentType: contentType === '' ? undefined : contentType,
  }
}

/**
 * Parses `value; key=token; key="quoted \" string"` (Content-Disposition, Content-Type). Keys are
 * lower-cased; the first occurrence of a key wins.
 */
export function parseParameters(value: string): { readonly type: string; readonly params: Map<string, string> } {
  const params = new Map<string, string>()
  let index = value.indexOf(';')
  const type = (index === -1 ? value : value.slice(0, index)).trim().toLowerCase()
  while (index !== -1 && index < value.length) {
    index++ // skip ';'
    while (index < value.length && isSpace(value.charCodeAt(index))) index++
    if (index >= value.length) break
    if (value[index] === ';') continue // empty parameter
    const equals = value.indexOf('=', index)
    if (equals === -1) throw malformed(`invalid parameter in ${JSON.stringify(truncate(value))}`)
    const key = value.slice(index, equals).trim().toLowerCase()
    index = equals + 1
    while (index < value.length && isSpace(value.charCodeAt(index))) index++
    let parameter: string
    if (value[index] === '"') {
      parameter = ''
      index++
      for (;;) {
        if (index >= value.length) throw malformed('unterminated quoted string in a part header')
        const char = value[index] as string
        if (char === '"') {
          index++
          break
        }
        if (char === '\\' && (value[index + 1] === '"' || value[index + 1] === '\\')) {
          parameter += value[index + 1]
          index += 2
          continue
        }
        parameter += char
        index++
      }
      while (index < value.length && isSpace(value.charCodeAt(index))) index++
      if (index < value.length && value[index] !== ';') throw malformed('invalid quoted string in a part header')
    } else {
      const next = value.indexOf(';', index)
      parameter = (next === -1 ? value.slice(index) : value.slice(index, next)).trim()
      index = next === -1 ? value.length : next
    }
    if (key !== '' && !params.has(key)) params.set(key, parameter)
    if (index >= value.length) break
  }
  return { type, params }
}

function isSpace(code: number): boolean {
  return code === SPACE || code === TAB
}

/** Names and filenames: browsers escape `"`, CR and LF as `%22`, `%0D` and `%0A` (HTML standard). */
function decodeFormName(value: string): string {
  return value.includes('%')
    ? value.replace(/%(22|0D|0A)/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    : value
}

/** RFC 5987 `charset'language'percent-encoded` (`filename*`); `undefined` when it cannot be decoded. */
function decodeExtendedValue(value: string): string | undefined {
  const match = /^([\w!#$%&+^`{}~-]+)'[\w-]*'(.*)$/.exec(value)
  if (match === null) return undefined
  const charset = (match[1] as string).toLowerCase()
  const encoded = match[2] as string
  try {
    if (charset === 'utf-8') return decodeURIComponent(encoded)
    if (charset === 'iso-8859-1') {
      return encoded.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    }
  } catch {
    return undefined
  }
  return undefined
}

/** The `boundary` parameter of a `multipart/form-data` content type (400 when missing or invalid). */
export function multipartBoundary(contentType: string): string {
  let boundary: string | undefined
  try {
    boundary = parseParameters(contentType).params.get('boundary')
  } catch {
    boundary = undefined
  }
  if (boundary === undefined || boundary === '') throw malformed('missing boundary in the content type')
  // RFC 2046: 1 to 70 printable ASCII characters
  if (boundary.length > 70 || [...boundary].some(char => char < ' ' || char > '~')) {
    throw malformed('invalid boundary in the content type')
  }
  return boundary
}

// -------------------------------------------------------------------------------------------------
// Collecting fields and files
// -------------------------------------------------------------------------------------------------

/** Applies a {@link MultipartPolicy} to the parts and collects fields and files. */
class Collector implements PartHandler {
  readonly fields: QueryRecord = emptyRecord()
  readonly files: Record<string, File[]> = emptyRecord()
  readonly list: File[] = []
  readonly entries: (readonly [string, string | File])[] = []
  readonly #policy: MultipartPolicy
  readonly #named: ReadonlyMap<string, FileRule>
  readonly #any: FileRule | undefined
  readonly #counts = new Map<FileRule, number>()
  #parts = 0

  constructor(policy: MultipartPolicy) {
    this.#policy = policy
    const named = new Map<string, FileRule>()
    let any: FileRule | undefined
    for (const rule of policy.rules) {
      if (rule.field === undefined) any = rule
      else named.set(rule.field, rule)
    }
    this.#named = named
    this.#any = any
  }

  start(part: PartInfo): PartSink {
    this.#parts++
    if (this.#parts > this.#policy.maxParts) {
      throw new PayloadTooLargeException(
        `Too many parts in the multipart body (at most ${this.#policy.maxParts})`,
        { maxParts: this.#policy.maxParts },
        CLOSE,
      )
    }
    return part.filename === undefined ? this.#field(part.name) : this.#file(part, part.filename)
  }

  #field(name: string): PartSink {
    const limit = this.#policy.maxFieldSize
    const chunks: Uint8Array[] = []
    let size = 0
    return {
      data: chunk => {
        size += chunk.byteLength
        if (size > limit) {
          throw new PayloadTooLargeException(
            `Field ${JSON.stringify(truncate(name))} exceeds the maximum size of ${formatByteSize(limit)}`,
            { field: name, maxSize: limit },
            CLOSE,
          )
        }
        chunks.push(chunk)
      },
      end: () => {
        const value = DECODER.decode(chunks.length === 1 ? (chunks[0] as Uint8Array) : Buffer.concat(chunks))
        const existing = this.fields[name]
        if (existing === undefined) this.fields[name] = value
        else if (typeof existing === 'string') this.fields[name] = [existing, value]
        else existing.push(value)
        this.entries.push([name, value])
      },
    }
  }

  #file(part: PartInfo, filename: string): PartSink {
    const type = part.contentType === undefined ? OCTET_STREAM : part.contentType
    const name = part.name
    let rules: readonly FileRule[] = []
    let admitted = false
    // an empty <input type="file"> is sent as an empty part without filename: it is not a file
    const admit = (): void => {
      admitted = true
      rules = this.#admit(name, type)
    }
    if (filename !== '') admit()
    const chunks: Uint8Array[] = []
    let size = 0
    return {
      data: chunk => {
        if (!admitted) admit()
        size += chunk.byteLength
        for (const rule of rules) {
          if (size > rule.maxSize) {
            throw new PayloadTooLargeException(
              `File in field ${JSON.stringify(truncate(name))} exceeds the maximum size of ${formatByteSize(rule.maxSize)}`,
              { field: name, maxSize: rule.maxSize },
              CLOSE,
            )
          }
        }
        chunks.push(chunk)
      },
      end: () => {
        if (!admitted) return
        const file = createFile(chunks, filename, type)
        const list = this.files[name]
        if (list === undefined) this.files[name] = [file]
        else list.push(file)
        this.list.push(file)
        this.entries.push([name, file])
      },
    }
  }

  /** Rules applying to a file of `field` (400 for an unexpected field), with count and type checks. */
  #admit(field: string, type: string): readonly FileRule[] {
    if (this.#policy.rules.length === 0) return []
    const rules: FileRule[] = []
    const named = this.#named.get(field)
    if (named !== undefined) rules.push(named)
    if (this.#any !== undefined) rules.push(this.#any)
    if (rules.length === 0) {
      const expected = [...this.#named.keys()]
      throw new BadRequestException(
        `Unexpected file field ${JSON.stringify(truncate(field))}`,
        issue(field, `Unexpected file field (expected ${expected.join(', ')})`),
        CLOSE,
      )
    }
    for (const rule of rules) {
      const count = (this.#counts.get(rule) ?? 0) + 1
      this.#counts.set(rule, count)
      if (count > rule.maxFiles) {
        const where = rule.field === undefined ? '' : ` in field ${JSON.stringify(truncate(rule.field))}`
        if (!rule.multiple) {
          throw new BadRequestException(`Expected a single file${where}`, issue(field, 'Expected a single file'), CLOSE)
        }
        throw new PayloadTooLargeException(
          `Too many files${where} (at most ${rule.maxFiles})`,
          { field, maxFiles: rule.maxFiles },
          CLOSE,
        )
      }
      if (rule.mimeTypes !== undefined && !matchesMediaType(type, rule.mimeTypes)) {
        throw new UnsupportedMediaTypeException(
          `Unsupported file type ${JSON.stringify(truncate(mediaTypeEssence(type)))} in field ${JSON.stringify(truncate(field))} (accepted: ${rule.mimeTypes.join(', ')})`,
          { field, type: mediaTypeEssence(type), accepted: rule.mimeTypes },
          CLOSE,
        )
      }
    }
    return rules
  }

  result(): MultipartResult {
    return { fields: this.fields, files: this.files, list: this.list, entries: this.entries }
  }
}

/**
 * Reads a multipart body from `stream` with `policy`. The stream is cancelled on error (the rest of
 * the body is discarded).
 *
 * @throws BadRequestException (400) for a malformed body, too many parts / files or an unexpected
 *   file field; PayloadTooLargeException (413) for a file or field above its limit;
 *   UnsupportedMediaTypeException (415) for a file of a refused type.
 */
export async function readMultipart(
  stream: ReadableStream<Uint8Array>,
  contentType: string,
  policy: MultipartPolicy,
): Promise<MultipartResult> {
  const reader = stream.getReader()
  try {
    const collector = new Collector(policy)
    const parser = new MultipartParser(multipartBoundary(contentType), collector)
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parser.write(value)
    }
    parser.end()
    return collector.result()
  } catch (error) {
    await reader.cancel(error).catch(() => undefined)
    throw error
  }
}

/** Parses a buffered multipart body (see {@link readMultipart}). */
export function parseMultipart(bytes: Uint8Array, contentType: string, policy: MultipartPolicy): MultipartResult {
  const collector = new Collector(policy)
  const parser = new MultipartParser(multipartBoundary(contentType), collector)
  parser.write(bytes)
  parser.end()
  return collector.result()
}

/** Converts a parse result to a `FormData` (entries in body order). */
export function toFormData(result: MultipartResult): FormData {
  const form = new FormData()
  for (const [name, value] of result.entries) form.append(name, value)
  return form
}

function malformed(reason: string): BadRequestException {
  return new BadRequestException(`Invalid multipart body: ${reason}`, undefined, CLOSE)
}

function truncate(value: string): string {
  return value.length > 100 ? `${value.slice(0, 100)}…` : value
}
