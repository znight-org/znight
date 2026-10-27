import type { HeaderValue } from './exceptions.ts'

import { type ContentDispositionType, contentDisposition, FileBody, type FileResponseOptions } from './files.ts'
import { contentTypeFor, OCTET_STREAM } from './mime.ts'
import { isValidStatus } from './status.ts'
import { isStreamSource, type StreamSource, toByteStream } from './stream.ts'

/** Options of {@link HttpResponse.stream}. */
export interface StreamResponseOptions {
  /** Media type. Default: from the extension of `filename`, else `application/octet-stream`. */
  readonly contentType?: string
  /** Name proposed to the client (`Content-Disposition: attachment` unless `disposition` says otherwise). */
  readonly filename?: string
  /** `attachment` or `inline`. Default: `attachment` when `filename` is set, otherwise no header. */
  readonly disposition?: ContentDispositionType
}

/** Options of {@link HttpResponse}. */
export interface HttpResponseInit {
  /** Status code. Default: the route default (`@HttpCode`, 201 for POST, 204 without body, 200). */
  readonly status?: number
  /** Response headers (names are case-insensitive; arrays send the header several times). */
  readonly headers?: Readonly<Record<string, HeaderValue>>
}

/** Redirect statuses accepted by {@link HttpResponse.redirect}. */
export type RedirectStatus = 301 | 302 | 303 | 307 | 308

/**
 * A handler result carrying a status and headers next to the body. The body is serialised with the
 * usual rules (objects → JSON, strings → text, bytes and streams → octet-stream).
 *
 * ```ts
 * @Post('/')
 * async create(@Body(CreateUser) input: CreateUser): Promise<HttpResponse<User>> {
 *   const user = await this.users.create(input)
 *   return HttpResponse.created(user, `/users/${user.id}`)
 * }
 * ```
 *
 * Status precedence: `@HttpCode` > `HttpResponse.status` > route default.
 */
export class HttpResponse<T = unknown> {
  readonly body: T
  readonly status: number | undefined
  readonly headers: Readonly<Record<string, HeaderValue>>

  constructor(body: T, init: HttpResponseInit = {}) {
    if (init.status !== undefined && !isValidStatus(init.status)) {
      throw new RangeError(`Invalid HTTP status ${String(init.status)} (expected an integer between 100 and 599)`)
    }
    this.body = body
    this.status = init.status
    this.headers = init.headers ?? {}
  }

  /** `200 OK` with `body`. */
  static ok<T>(body: T, headers?: Readonly<Record<string, HeaderValue>>): HttpResponse<T> {
    return new HttpResponse(body, headers === undefined ? { status: 200 } : { status: 200, headers })
  }

  /**
   * `201 Created`, with a `location` header when given. With a body, the response is typed with it
   * (`Promise<HttpResponse<BookResponse>>` type-checks).
   */
  static created(): HttpResponse<undefined>
  static created<T>(body: T, location?: string): HttpResponse<T>
  static created<T>(body?: T, location?: string): HttpResponse<T | undefined> {
    return new HttpResponse(body, location === undefined ? { status: 201 } : { status: 201, headers: { location } })
  }

  /** `202 Accepted`, typed with its body when there is one. */
  static accepted(): HttpResponse<undefined>
  static accepted<T>(body: T): HttpResponse<T>
  static accepted<T>(body?: T): HttpResponse<T | undefined> {
    return new HttpResponse(body, { status: 202 })
  }

  /** `204 No Content`. */
  static noContent(): HttpResponse<undefined> {
    return new HttpResponse(undefined, { status: 204 })
  }

  /** A redirect (`302 Found` by default) to `location`. */
  static redirect(location: string, status: RedirectStatus = 302): HttpResponse<undefined> {
    return new HttpResponse(undefined, { status, headers: { location } })
  }

  /**
   * Sends a file from disk (`string` path or `file:` URL) or a `Blob` / `File`, streamed with
   * `Content-Length`, `Content-Type` (from the extension, see `contentTypeFor`), `Last-Modified`,
   * `ETag` and `Accept-Ranges`. Conditional requests answer 304 / 412 and single byte ranges 206
   * (416 when unsatisfiable). A missing file answers 404.
   *
   * ```ts
   * @Get('/reports/:name')
   * download(@Param('name') name: string) {
   *   // `root` confines the path: '../../etc/passwd' answers 404
   *   return HttpResponse.file(name, { root: REPORTS_DIR, filename: `rapport ${name}` })
   * }
   * ```
   *
   * Never pass a path built from the request without `root`.
   */
  static file(file: string | URL | Blob, options?: FileResponseOptions): HttpResponse<FileBody> {
    return new HttpResponse(new FileBody(file, options))
  }

  /**
   * Streams a Web `ReadableStream`, a Node.js `Readable` or an async iterable (async generator) of
   * `Uint8Array` / `string` chunks. The source is read as the client receives the data
   * (backpressure) and cancelled when the client disconnects; it runs in the request scope.
   *
   * ```ts
   * @Get('/export.csv')
   * export() {
   *   return HttpResponse.stream(this.rows.csvLines(), { filename: 'export.csv' }) // text/csv; charset=utf-8
   * }
   * ```
   */
  static stream(source: StreamSource, options: StreamResponseOptions = {}): HttpResponse<ReadableStream<Uint8Array>> {
    if (!isStreamSource(source)) {
      throw new TypeError(
        'HttpResponse.stream() expects a ReadableStream, a Node.js Readable or an async iterable of Uint8Array / string chunks',
      )
    }
    const headers: Record<string, HeaderValue> = {
      'content-type':
        options.contentType ??
        (options.filename === undefined ? undefined : contentTypeFor(options.filename)) ??
        OCTET_STREAM,
    }
    const disposition = options.disposition ?? (options.filename === undefined ? undefined : 'attachment')
    if (disposition !== undefined) headers['content-disposition'] = contentDisposition(options.filename, disposition)
    return new HttpResponse(toByteStream(source), { headers })
  }

  /** A copy of this response with `name` set to `value`. */
  withHeader(name: string, value: HeaderValue): HttpResponse<T> {
    return new HttpResponse(this.body, {
      ...(this.status === undefined ? {} : { status: this.status }),
      headers: { ...this.headers, [name.toLowerCase()]: value },
    })
  }

  /** A copy of this response with another status. */
  withStatus(status: number): HttpResponse<T> {
    return new HttpResponse(this.body, { status, headers: this.headers })
  }
}

/** Whether `value` is an {@link HttpResponse} (also across duplicated package copies). */
export function isHttpResponse(value: unknown): value is HttpResponse {
  return (
    value instanceof HttpResponse ||
    (value !== null &&
      typeof value === 'object' &&
      (value as { constructor?: { name?: unknown } }).constructor?.name === 'HttpResponse' &&
      'body' in value &&
      'headers' in value)
  )
}
