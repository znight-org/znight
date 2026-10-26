/**
 * File downloads (`HttpResponse.file()`): files on disk (sent as lazily read, file-backed `Blob`s:
 * `fs.openAsBlob()`) or `Blob` objects, with `Content-Length`, `Content-Type`, `Last-Modified` /
 * `ETag`, conditional requests (304 / 412), single byte ranges (206 / 416) and RFC 6266
 * `Content-Disposition` headers.
 */
import type { HeaderValue } from './exceptions.ts'

import { openAsBlob } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HttpException, NotFoundException } from './exceptions.ts'
import { contentTypeFor, OCTET_STREAM } from './mime.ts'
import { emptyRecord } from './utils.ts'

/** How a file is presented to the client (`Content-Disposition`). */
export type ContentDispositionType = 'attachment' | 'inline'

/** Options of `HttpResponse.file()`. */
export interface FileResponseOptions {
  /**
   * Name proposed to the client in `Content-Disposition` (any Unicode name; path separators are
   * removed). Setting it makes the response an `attachment` unless `disposition` says otherwise.
   */
  readonly filename?: string
  /**
   * Media type of the response. Default: the type of the `Blob`, else looked up from the extension
   * of `filename` / of the path (small built-in table, text types with `charset=utf-8`), else
   * `application/octet-stream`.
   */
  readonly contentType?: string
  /**
   * `attachment` (download) or `inline` (displayed by the browser). Default: `attachment` when
   * `filename` is set, otherwise no `Content-Disposition` header. Without `filename`, the file name
   * (path basename, `File.name`) is used.
   */
  readonly disposition?: ContentDispositionType
  /**
   * Directory the path is resolved in. The resolved file (symbolic links followed) must stay inside
   * it: `..` segments, absolute paths and links escaping the directory answer 404. Always set it
   * when the path comes from the request.
   */
  readonly root?: string
  /**
   * With `root`: whether files or directories whose name starts with a dot (`.env`, `.git/config`)
   * may be sent. Default: `'deny'` (404).
   */
  readonly dotfiles?: 'allow' | 'deny'
}

/**
 * The body of `HttpResponse.file()`: a file on disk or a `Blob`, resolved by the pipeline when the
 * response is sent (stat, conditional request, range).
 */
export class FileBody {
  /** Path (`string` / `file:` URL) or `Blob` / `File`. */
  readonly source: string | URL | Blob
  readonly options: FileResponseOptions

  constructor(source: string | URL | Blob, options: FileResponseOptions = {}) {
    if (typeof source !== 'string' && !(source instanceof URL) && !(source instanceof Blob)) {
      throw new TypeError('HttpResponse.file() expects a path (string or file: URL), a Blob or a File')
    }
    if (source instanceof URL && source.protocol !== 'file:') {
      throw new TypeError(`HttpResponse.file() expects a file: URL (received ${source.protocol})`)
    }
    const disposition = options.disposition
    if (disposition !== undefined && disposition !== 'attachment' && disposition !== 'inline') {
      throw new TypeError(`Invalid disposition ${JSON.stringify(disposition)} (expected "attachment" or "inline")`)
    }
    if (options.dotfiles !== undefined && options.dotfiles !== 'allow' && options.dotfiles !== 'deny') {
      throw new TypeError(`Invalid dotfiles ${JSON.stringify(options.dotfiles)} (expected "allow" or "deny")`)
    }
    this.source = source
    this.options = options
  }
}

/** Whether `value` is a {@link FileBody}. */
export function isFileBody(value: unknown): value is FileBody {
  return value instanceof FileBody
}

/** The request facts a file response depends on. */
export interface FileRequest {
  readonly method: string
  readonly headers: Readonly<Record<string, string | undefined>>
}

/** A resolved file response (before route headers and status precedence). */
export interface ResolvedFile {
  /** 200, 206 (range) or 304 (not modified). */
  readonly status: 200 | 206 | 304
  readonly headers: Record<string, HeaderValue>
  /**
   * The bytes to send, as a `Blob` (file-backed for files on disk: read lazily, sent with its size;
   * `sendfile` on Bun); `null` for 304, HEAD requests and empty files.
   */
  readonly body: Blob | null
}

/** Attempts to open a file whose size changes between `stat` and `openAsBlob` (concurrent writes). */
const OPEN_ATTEMPTS = 3

/**
 * Resolves a file response for a request: opens the file, evaluates the preconditions
 * (`If-Match`, `If-Unmodified-Since` → 412; `If-None-Match`, `If-Modified-Since` → 304) and the
 * `Range` header (single range, honouring `If-Range`; 416 when unsatisfiable).
 *
 * @throws NotFoundException (404) when the file does not exist, is not a regular file or escapes `root`;
 *   HttpException 412 / 416.
 */
export function resolveFile(file: FileBody, request: FileRequest): Promise<ResolvedFile> {
  if (!(file.source instanceof Blob)) return resolvePath(file, request)
  try {
    return Promise.resolve(resolveBlob(file, file.source, request))
  } catch (error) {
    return Promise.reject(error)
  }
}

async function resolvePath(file: FileBody, request: FileRequest): Promise<ResolvedFile> {
  const target = await locate(file.source as string | URL, file.options.root, file.options.dotfiles !== 'allow')
  for (let attempt = 1; ; attempt++) {
    let stats: Awaited<ReturnType<typeof stat>>
    try {
      stats = await stat(target)
    } catch (error) {
      throw notFound(error)
    }
    if (!stats.isFile()) throw new NotFoundException('File not found')
    const name = basename(target)
    const plan = planResponse(
      {
        size: stats.size,
        lastModified: stats.mtimeMs,
        contentType: contentTypeOf(file.options, undefined, name),
        disposition: dispositionOf(file.options, name),
      },
      request,
    )
    if (plan.body === undefined) return { ...plan, body: null }
    let blob: Blob
    try {
      blob = await openAsBlob(target)
    } catch (error) {
      throw notFound(error)
    }
    // the file was replaced or written to since `stat`: describe the new content
    if (blob.size !== stats.size) {
      if (attempt < OPEN_ATTEMPTS) continue
      throw new Error(`The file ${name} keeps changing while being sent`)
    }
    return { ...plan, body: slice(blob, plan.body) }
  }
}

function resolveBlob(file: FileBody, blob: Blob, request: FileRequest): ResolvedFile {
  const name = blob instanceof File && blob.name !== '' ? blob.name : undefined
  const info: Representation = {
    size: blob.size,
    lastModified: blob instanceof File ? blob.lastModified : undefined,
    contentType: contentTypeOf(file.options, blob.type, name),
    disposition: dispositionOf(file.options, name),
  }
  const plan = planResponse(info, request)
  return { ...plan, body: plan.body === undefined ? null : slice(blob, plan.body) }
}

/** The bytes `start..end` (inclusive) of a blob (the blob itself when complete). */
function slice(blob: Blob, { start, end }: ByteRange): Blob {
  return start === 0 && end === blob.size - 1 ? blob : blob.slice(start, end + 1)
}

/** Resolves the path to open, enforcing `root` (and hiding dotfiles inside it). */
async function locate(source: string | URL, root: string | undefined, hideDotfiles: boolean): Promise<string> {
  const path = source instanceof URL ? fileURLToPath(source) : source
  if (path === '' || path.includes('\0')) throw new NotFoundException('File not found')
  if (root === undefined) return resolve(path)
  const base = resolve(root)
  const target = resolve(base, path)
  if (!isInside(base, target, hideDotfiles)) throw new NotFoundException('File not found')
  // symbolic links: the real file must be inside the real root
  let realBase: string
  let realTarget: string
  try {
    ;[realBase, realTarget] = await Promise.all([realpath(base), realpath(target)])
  } catch (error) {
    throw notFound(error)
  }
  if (!isInside(realBase, realTarget, hideDotfiles)) throw new NotFoundException('File not found')
  return realTarget
}

function isInside(base: string, target: string, hideDotfiles: boolean): boolean {
  const path = relative(base, target)
  if (path === '' || isAbsolute(path)) return false
  const segments = path.split(/[\\/]/)
  if (segments[0] === '..') return false
  return !hideDotfiles || !segments.some(segment => segment.startsWith('.'))
}

const MISSING = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'ENAMETOOLONG', 'ELOOP', 'ERR_INVALID_ARG_VALUE'])

function notFound(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && MISSING.has(code)
    ? new NotFoundException('File not found', undefined, { cause: error })
    : error
}

// -------------------------------------------------------------------------------------------------
// Representation metadata, preconditions and ranges
// -------------------------------------------------------------------------------------------------

interface Representation {
  readonly size: number
  /** Milliseconds since the epoch, when known. */
  readonly lastModified: number | undefined
  readonly contentType: string
  readonly disposition: string | undefined
}

interface Plan {
  readonly status: 200 | 206 | 304
  readonly headers: Record<string, HeaderValue>
  /** Inclusive byte range to send; `undefined`: no body (304, HEAD, empty file). */
  readonly body: { readonly start: number; readonly end: number } | undefined
}

function planResponse(info: Representation, request: FileRequest): Plan {
  const validators = emptyRecord<HeaderValue>()
  const etag = info.lastModified === undefined ? undefined : entityTag(info.size, info.lastModified)
  const seconds = info.lastModified === undefined ? undefined : Math.floor(info.lastModified / 1000)
  if (etag !== undefined) validators['etag'] = etag
  if (seconds !== undefined) validators['last-modified'] = new Date(seconds * 1000).toUTCString()

  const precondition = evaluatePreconditions(request, etag, seconds)
  if (precondition === 412) throw new HttpException(412, 'Precondition Failed', undefined, { headers: validators })
  if (precondition === 304) return { status: 304, headers: validators, body: undefined }

  const headers = emptyRecord<HeaderValue>()
  headers['content-type'] = info.contentType
  if (info.disposition !== undefined) headers['content-disposition'] = info.disposition
  headers['accept-ranges'] = 'bytes'
  Object.assign(headers, validators)

  const range = request.method === 'GET' ? requestedRange(request.headers, info.size, etag, seconds) : undefined
  if (range === 'unsatisfiable') {
    throw new HttpException(416, `Range Not Satisfiable (size: ${info.size} bytes)`, undefined, {
      headers: { 'content-range': `bytes */${info.size}`, 'accept-ranges': 'bytes' },
    })
  }
  if (range !== undefined) {
    headers['content-range'] = `bytes ${range.start}-${range.end}/${info.size}`
    headers['content-length'] = String(range.end - range.start + 1)
    return { status: 206, headers, body: request.method === 'HEAD' ? undefined : range }
  }
  headers['content-length'] = String(info.size)
  const body = request.method === 'HEAD' || info.size === 0 ? undefined : { start: 0, end: info.size - 1 }
  return { status: 200, headers, body }
}

/** Strong entity tag from the size and modification time (like nginx: `"<mtime>-<size>"`, hex). */
function entityTag(size: number, lastModified: number): string {
  return `"${Math.floor(lastModified).toString(16)}-${size.toString(16)}"`
}

/** RFC 9110 §13.2.2: 412, 304 or `undefined` (proceed). */
function evaluatePreconditions(
  request: FileRequest,
  etag: string | undefined,
  seconds: number | undefined,
): 304 | 412 | undefined {
  const headers = request.headers
  const safe = request.method === 'GET' || request.method === 'HEAD'
  const ifMatch = headers['if-match']
  if (ifMatch === undefined) {
    const since = httpDate(headers['if-unmodified-since'])
    if (since !== undefined && seconds !== undefined && seconds > since) return 412
  } else {
    if (!matchesEntityTag(ifMatch, etag, true)) return 412
  }
  const ifNoneMatch = headers['if-none-match']
  if (ifNoneMatch !== undefined) {
    if (matchesEntityTag(ifNoneMatch, etag, false)) return safe ? 304 : 412
  } else if (safe) {
    const since = httpDate(headers['if-modified-since'])
    if (since !== undefined && seconds !== undefined && seconds <= since) return 304
  }
  return undefined
}

/** Whether an `If-Match` / `If-None-Match` list matches `etag` (`*` matches any existing file). */
function matchesEntityTag(header: string, etag: string | undefined, strong: boolean): boolean {
  if (header.trim() === '*') return true
  if (etag === undefined) return false
  for (const raw of header.split(',')) {
    const candidate = raw.trim()
    if (candidate === '') continue
    if (strong) {
      if (candidate === etag) return true
    } else if (stripWeak(candidate) === stripWeak(etag)) {
      return true
    }
  }
  return false
}

function stripWeak(tag: string): string {
  return tag.startsWith('W/') ? tag.slice(2) : tag
}

/** Seconds of an HTTP date, `undefined` when absent or invalid. */
function httpDate(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const time = Date.parse(value)
  return Number.isNaN(time) ? undefined : Math.floor(time / 1000)
}

/** The range to send for a `Range` header (with `If-Range`), `undefined` for the whole file. */
function requestedRange(
  headers: Readonly<Record<string, string | undefined>>,
  size: number,
  etag: string | undefined,
  seconds: number | undefined,
): ByteRange | 'unsatisfiable' | undefined {
  const header = headers['range']
  if (header === undefined) return undefined
  const ifRange = headers['if-range']?.trim()
  if (ifRange !== undefined) {
    const isTag = ifRange.startsWith('"') || ifRange.startsWith('W/')
    // an entity tag must match strongly; a date must be the exact modification date
    const fresh = isTag
      ? etag !== undefined && ifRange === etag
      : seconds !== undefined && httpDate(ifRange) === seconds
    if (!fresh) return undefined
  }
  return parseRange(header, size)
}

/** An inclusive byte range. */
export interface ByteRange {
  readonly start: number
  readonly end: number
}

/**
 * Parses a `Range` header for a representation of `size` bytes. Only a single `bytes` range is
 * honoured: other units, several ranges and malformed values return `undefined` (the whole
 * representation is sent, as RFC 9110 allows); a valid range starting after the end returns
 * `'unsatisfiable'` (416).
 */
export function parseRange(header: string, size: number): ByteRange | 'unsatisfiable' | undefined {
  const equals = header.indexOf('=')
  if (equals === -1 || header.slice(0, equals).trim().toLowerCase() !== 'bytes') return undefined
  const spec = header.slice(equals + 1)
  if (spec.includes(',')) return undefined
  const match = /^\s*(\d*)\s*-\s*(\d*)\s*$/.exec(spec)
  if (match === null) return undefined
  const [, first = '', last = ''] = match
  if (first === '' && last === '') return undefined
  if (first === '') {
    const suffix = Number(last)
    if (!Number.isSafeInteger(suffix)) return undefined
    if (suffix === 0 || size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(first)
  if (!Number.isSafeInteger(start)) return undefined
  if (last === '') return start >= size ? 'unsatisfiable' : { start, end: size - 1 }
  const end = Number(last)
  if (!Number.isSafeInteger(end) || end < start) return undefined
  return start >= size ? 'unsatisfiable' : { start, end: Math.min(end, size - 1) }
}

// -------------------------------------------------------------------------------------------------
// Headers
// -------------------------------------------------------------------------------------------------

function contentTypeOf(options: FileResponseOptions, blobType: string | undefined, name: string | undefined): string {
  if (options.contentType !== undefined) return options.contentType
  if (blobType !== undefined && blobType !== '') return blobType
  return (
    (options.filename === undefined ? undefined : contentTypeFor(options.filename)) ??
    (name === undefined ? undefined : contentTypeFor(name)) ??
    OCTET_STREAM
  )
}

function dispositionOf(options: FileResponseOptions, name: string | undefined): string | undefined {
  const type = options.disposition ?? (options.filename === undefined ? undefined : 'attachment')
  if (type === undefined) return undefined
  return contentDisposition(options.filename ?? name, type)
}

/** Characters that need no percent-encoding in an RFC 8187 `ext-value` (`attr-char`). */
const ATTR_CHAR = /^[A-Za-z0-9!#$&+\-.^_`|~]$/

/**
 * Builds a `Content-Disposition` header value (RFC 6266): `attachment; filename="report.pdf"`, with
 * an RFC 8187 / 5987 `filename*` parameter for names that are not plain ASCII
 * (`attachment; filename="r_sum_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`). Directory parts and
 * control characters of `filename` are removed.
 */
export function contentDisposition(filename?: string, type: ContentDispositionType = 'attachment'): string {
  if (type !== 'attachment' && type !== 'inline') {
    throw new TypeError(`Invalid disposition ${JSON.stringify(type)} (expected "attachment" or "inline")`)
  }
  if (filename === undefined) return type
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are removed on purpose
  const name = filename.replace(/^.*[\\/]/, '').replace(/[\u0000-\u001f\u007f]/g, '')
  if (name === '') return type
  const fallback = name.replace(/[^\u0020-\u007e]/g, '_').replace(/%/g, '_')
  let value = `${type}; filename="${fallback.replace(/["\\]/g, '\\$&')}"`
  if (fallback !== name) value += `; filename*=UTF-8''${encodeExtValue(name)}`
  return value
}

function encodeExtValue(value: string): string {
  let result = ''
  for (const byte of new TextEncoder().encode(value)) {
    const char = String.fromCharCode(byte)
    result += byte < 0x80 && ATTR_CHAR.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return result
}
