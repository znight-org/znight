import { BadRequestException, UnsupportedMediaTypeException } from './exceptions.ts'
import { parseQuery } from './query.ts'
import { errorMessage } from './utils.ts'

/** The part of `TextDecoder` used here (the global type is not declared without the DOM lib). */
interface Decoder {
  readonly encoding: string
  decode(input: Uint8Array): string
}

const UTF8: Decoder = new TextDecoder('utf-8', { fatal: true })

/** A parsed `content-type` header. */
export interface MediaType {
  /** Lower-case `type/subtype` without parameters. */
  readonly type: string
  /** Lower-case `charset` parameter, when present. */
  readonly charset: string | undefined
}

/** Parses a `content-type` header value (`application/json; charset=utf-8`). */
export function parseMediaType(header: string | undefined): MediaType | undefined {
  if (header === undefined) return undefined
  const separator = header.indexOf(';')
  const type = (separator === -1 ? header : header.slice(0, separator)).trim().toLowerCase()
  if (type === '') return undefined
  let charset: string | undefined
  if (separator !== -1) {
    for (const parameter of header.slice(separator + 1).split(';')) {
      const equals = parameter.indexOf('=')
      if (equals === -1) continue
      if (parameter.slice(0, equals).trim().toLowerCase() !== 'charset') continue
      charset = parameter
        .slice(equals + 1)
        .trim()
        .replace(/^"|"$/g, '')
        .toLowerCase()
    }
  }
  return { type, charset }
}

/** Whether `type` is a JSON media type (`application/json`, `application/problem+json`...). */
export function isJsonType(type: string): boolean {
  return type === 'application/json' || type.endsWith('+json')
}

/**
 * Parses a request body according to its `content-type`:
 *
 * | Content type                          | Result                               |
 * | ------------------------------------- | ------------------------------------ |
 * | empty body                            | `undefined`                          |
 * | `application/json`, `*\/*+json`        | parsed JSON (400 when malformed)     |
 * | `text/*`                              | string (charset honoured)            |
 * | `application/x-www-form-urlencoded`   | record (repeated keys → arrays)      |
 * | `multipart/form-data`                 | `FormData` (files as `File`)         |
 * | anything else, or no content type     | `Uint8Array`                         |
 *
 * A `content-encoding` other than `identity` is rejected with 415 (decompression is not supported).
 */
export async function parseBody(
  bytes: Uint8Array,
  contentType: string | undefined,
  contentEncoding?: string | undefined,
): Promise<unknown> {
  if (bytes.byteLength === 0) return undefined
  if (contentEncoding !== undefined) {
    const encoding = contentEncoding.trim().toLowerCase()
    if (encoding !== '' && encoding !== 'identity') {
      throw new UnsupportedMediaTypeException(`Unsupported content encoding "${encoding}"`)
    }
  }
  const media = parseMediaType(contentType)
  if (media === undefined) return bytes
  if (isJsonType(media.type)) {
    if (media.charset !== undefined && media.charset !== 'utf-8' && media.charset !== 'utf8') {
      throw new UnsupportedMediaTypeException(`Unsupported charset "${media.charset}" for JSON (use utf-8)`)
    }
    const text = decode(bytes, UTF8, 'JSON')
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new BadRequestException(`Invalid JSON body: ${errorMessage(error)}`)
    }
  }
  if (media.type.startsWith('text/')) return decode(bytes, decoderFor(media.charset), 'text')
  if (media.type === 'application/x-www-form-urlencoded') return parseQuery(decode(bytes, UTF8, 'form'))
  if (media.type === 'multipart/form-data') {
    try {
      return await new Response(bytes, { headers: { 'content-type': contentType as string } }).formData()
    } catch (error) {
      throw new BadRequestException(`Invalid multipart body: ${errorMessage(error)}`)
    }
  }
  return bytes
}

function decoderFor(charset: string | undefined): Decoder {
  if (charset === undefined || charset === 'utf-8' || charset === 'utf8') return UTF8
  try {
    return new TextDecoder(charset as 'utf-8', { fatal: true })
  } catch {
    throw new UnsupportedMediaTypeException(`Unsupported charset "${charset}"`)
  }
}

function decode(bytes: Uint8Array, decoder: Decoder, what: string): string {
  try {
    return decoder.decode(bytes)
  } catch {
    throw new BadRequestException(`Invalid ${what} body: malformed ${decoder.encoding} data`)
  }
}
