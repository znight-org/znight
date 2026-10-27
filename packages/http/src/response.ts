import type { HeaderValue } from './exceptions.ts'

import {
  type ClearCookieOptions,
  type CookieOptions,
  checkCookie,
  givenCookieKey,
  type ResponseCookie,
} from './cookies.ts'
import { type ContentDispositionType, contentDisposition, FileBody, type FileResponseOptions } from './files.ts'
import { contentTypeFor, OCTET_STREAM } from './mime.ts'
import { SseBody, type SseOptions, type SseSource } from './sse.ts'
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
  /** Cookies to set (see {@link HttpResponse.withCookie}), in order. */
  readonly cookies?: readonly ResponseCookie[]
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
  /** Cookies set by this response (`withCookie` / `withoutCookie`), in order; they win over `ctx.setCookie()`. */
  readonly cookies: readonly ResponseCookie[]

  constructor(body: T, init: HttpResponseInit = {}) {
    if (init.status !== undefined && !isValidStatus(init.status)) {
      throw new RangeError(`Invalid HTTP status ${String(init.status)} (expected an integer between 100 and 599)`)
    }
    this.body = body
    this.status = init.status
    this.headers = init.headers ?? {}
    this.cookies = init.cookies === undefined ? NO_COOKIES : Object.freeze([...init.cookies])
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

  /**
   * An event stream (Server-Sent Events) on any route and any method: `200` unless `@HttpCode` or
   * {@link withStatus} say otherwise (`EventSource` requires 200; `fetch()` clients read any status),
   * even on `POST` routes. Same source, framing and lifecycle as an `@Sse()` route.
   *
   * ```ts
   * @Post('/:id/assistant')
   * assistant(@Param('id') id: string, @Body(Prompt) prompt: Prompt, @Ctx() ctx: HttpContext) {
   *   return HttpResponse.sse(this.llm.complete(id, prompt, { signal: ctx.signal }))
   * }
   * ```
   */
  static sse(source: SseSource, options?: SseOptions): HttpResponse<SseBody> {
    return new HttpResponse(new SseBody(source, options))
  }

  /** A copy of this response with `name` set to `value`. */
  withHeader(name: string, value: HeaderValue): HttpResponse<T> {
    return this.#copy({ headers: { ...this.headers, [name.toLowerCase()]: value } })
  }

  /** A copy of this response with another status. */
  withStatus(status: number): HttpResponse<T> {
    return this.#copy({ status })
  }

  /**
   * A copy of this response setting a cookie, with the secure defaults (`Path=/; Secure; HttpOnly;
   * SameSite=Lax`, see the plugin option `cookies.defaults`). It replaces a cookie with the same name,
   * domain and path set by `ctx.setCookie()` or an earlier `withCookie()`.
   *
   * ```ts
   * return HttpResponse.ok({ id: user.id }).withCookie('__Host-uid', user.id, { signed: true, maxAge: 8 * 3600 })
   * ```
   *
   * The name, the value, the lifetime, the domain, the path and the size are checked now; the rules
   * depending on the plugin (`secure` default with a prefix or `SameSite=None`, signing, the final
   * size) when the response is sent: a violation then answers a generic 500, logged as
   * `Invalid cookie "name": …`.
   *
   * @throws TypeError / RangeError for an invalid cookie.
   */
  withCookie(name: string, value: string, options: CookieOptions = {}): HttpResponse<T> {
    checkCookie(name, value, options)
    return this.#copy({ cookies: withCookie(this.cookies, { name, value, options: Object.freeze({ ...options }) }) })
  }

  /** A copy of this response clearing a cookie (see `ctx.clearCookie()`). */
  withoutCookie(name: string, options: ClearCookieOptions = {}): HttpResponse<T> {
    if (options === null || typeof options !== 'object') {
      throw new TypeError(`Invalid cookie ${JSON.stringify(String(name))}: options must be an object`)
    }
    const { maxAge: _maxAge, expires: _expires, signed: _signed, ...clear } = options as CookieOptions
    checkCookie(name, undefined, clear)
    return this.#copy({ cookies: withCookie(this.cookies, { name, value: undefined, options: Object.freeze(clear) }) })
  }

  #copy(changes: HttpResponseInit): HttpResponse<T> {
    const status = changes.status ?? this.status
    return new HttpResponse(this.body, {
      ...(status === undefined ? {} : { status }),
      headers: changes.headers ?? this.headers,
      cookies: changes.cookies ?? this.cookies,
    })
  }
}

const NO_COOKIES: readonly ResponseCookie[] = Object.freeze([])

/** `cookies` with `cookie` added, replacing (in place) a cookie of the same name, domain and path. */
function withCookie(cookies: readonly ResponseCookie[], cookie: ResponseCookie): ResponseCookie[] {
  const key = givenCookieKey(cookie.name, cookie.options)
  const index = cookies.findIndex(existing => givenCookieKey(existing.name, existing.options) === key)
  if (index === -1) return [...cookies, cookie]
  const result = [...cookies]
  result[index] = cookie
  return result
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
