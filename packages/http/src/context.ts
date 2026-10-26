import type { Token } from '@znight/core'
import type { AdapterRequest } from './adapter.ts'
import type { HeaderValue } from './exceptions.ts'
import type { MultipartResult } from './multipart.ts'
import type { BodyPlan } from './uploads.ts'

import { checkContentEncoding, hasBody, parseBody, parseMediaType } from './body.ts'
import { UnsupportedMediaTypeException } from './exceptions.ts'
import { parseMultipart, readMultipart } from './multipart.ts'
import { parseQuery, type QueryRecord, splitUrl } from './query.ts'
import { emptyRecord } from './utils.ts'

declare const requestIdBrand: unique symbol

/**
 * Identifier of the current request: the incoming `x-request-id` header (see the plugin option
 * `requestIdHeader`) or a generated UUID. Injectable in request-scoped providers.
 */
export type RequestId = string & { readonly [requestIdBrand]: true }

/** The route that matched a request. */
export interface HttpRouteInfo {
  /** Route method (`GET`...; the concrete method for `@All` routes). */
  readonly method: string
  /** Route pattern including the plugin prefix (`/api/users/:id`). */
  readonly path: string
  /** Controller provider token. */
  readonly controller: Token
  /** Handler method name. */
  readonly handler: string
  /** Controller metadata merged with route metadata (`createRouteDecorator`). */
  readonly meta: Readonly<Record<string, unknown>>
}

/**
 * Adapter-neutral view of the current HTTP request, shared by guards, interceptors, exception
 * mappers and handlers (`@Ctx()`), and injectable in request-scoped providers.
 */
export interface HttpContext {
  readonly requestId: RequestId
  /** Upper-case method. */
  readonly method: string
  /** Raw request target (`/users/a%20b?page=2`). */
  readonly url: string
  /** Raw path, without query string (`/users/a%20b`). */
  readonly path: string
  /** Decoded route parameters (`*` holds the part matched by a trailing wildcard). */
  readonly params: Readonly<Record<string, string>>
  /** Decoded query string (repeated keys → arrays), parsed on first access. */
  readonly query: Readonly<QueryRecord>
  /** Request headers, lower-case names. */
  readonly headers: Readonly<Record<string, string | undefined>>
  /**
   * Parsed body. Populated before the interceptors for routes declaring `@Body()` or upload
   * parameters (and after {@link parseBody} resolved otherwise); `undefined` until then and for
   * empty bodies. Forms (urlencoded and multipart) are records of their text fields.
   */
  readonly body: unknown
  /**
   * Files of a `multipart/form-data` body by field name, in body order (standard `File` objects,
   * held in memory). Populated with {@link body}; empty for other bodies.
   */
  readonly files: Readonly<Record<string, readonly File[]>>
  /** The matched route, `undefined` for unmatched requests (404/405). */
  readonly route: HttpRouteInfo | undefined
  /** Per-request storage for guards, interceptors and handlers (`ctx.state.set('user', user)`). */
  readonly state: Map<string | symbol, unknown>
  /** Native request of the adapter (`IncomingMessage`, `FastifyRequest`, Express `Request`, Web `Request`). */
  readonly request: unknown
  /** Native response of the adapter (`ServerResponse`, `FastifyReply`, Express `Response`, Hono `Context`). */
  readonly response: unknown
  /** Adapter name (`node`, `fastify`, `express`, `hono`). */
  readonly adapter: string
  /** Remote address, when the adapter knows it. */
  readonly ip: string | undefined
  /** Headers added to the response, whatever its outcome (errors included). */
  readonly responseHeaders: Readonly<Record<string, HeaderValue>>
  /** A request header (case-insensitive name). */
  header(name: string): string | undefined
  /** Sets a response header (case-insensitive name), sent with success and error responses. */
  setHeader(name: string, value: HeaderValue): void
  /** Appends a response header value (`set-cookie`...). */
  appendHeader(name: string, value: string): void
  /**
   * Reads and parses the body (once): JSON (`application/json`, `+json`), text (`text/*`), forms
   * (`application/x-www-form-urlencoded` and `multipart/form-data` → record of the text fields,
   * repeated names as arrays; files in {@link files}), raw bytes otherwise; `undefined` when empty.
   * Fails with 400 (malformed), 413 (body or upload limits) or 415 (unsupported encoding, refused
   * file type, non-multipart body on an upload route).
   */
  parseBody(): Promise<unknown>
  /** The raw body bytes (once; shared with {@link parseBody}), e.g. to check a webhook signature. */
  rawBody(): Promise<Uint8Array>
  /**
   * The request body as a Web stream, read as it arrives (nothing is buffered): the escape hatch
   * for large uploads (`PUT /files/:name` piped to disk or object storage). The body limit of the
   * route still applies (`@BodyLimit`, `Infinity` to disable): past it the stream errors with a
   * `PayloadTooLargeException` (413). Exclusive with {@link rawBody} / {@link parseBody}: throws when
   * the body was already read (routes with `@Body()` or upload parameters read it before the
   * handler).
   */
  bodyStream(): ReadableStream<Uint8Array>
}

/** Implementation of {@link HttpContext} used by the pipeline (internal). */
export class RequestContext implements HttpContext {
  readonly requestId: RequestId
  readonly method: string
  readonly url: string
  readonly path: string
  readonly params: Readonly<Record<string, string>>
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly route: HttpRouteInfo | undefined
  readonly request: unknown
  readonly response: unknown
  readonly adapter: string
  readonly ip: string | undefined
  readonly #source: AdapterRequest
  readonly #plan: BodyPlan
  readonly #rawQuery: string
  #query: QueryRecord | undefined
  #state: Map<string | symbol, unknown> | undefined
  #responseHeaders: Record<string, HeaderValue> | undefined
  #body: unknown
  #files: Readonly<Record<string, readonly File[]>> | undefined
  #raw: Promise<Uint8Array> | undefined
  #streamed = false
  /** Stops the body stream opened for the request, unless it was read to its end or cancelled. */
  #stopBody: (() => void) | undefined
  #parsed: Promise<unknown> | undefined

  constructor(
    source: AdapterRequest,
    init: {
      readonly requestId: RequestId
      readonly adapter: string
      readonly route: HttpRouteInfo | undefined
      readonly params: Readonly<Record<string, string>>
      readonly body: BodyPlan
    },
  ) {
    this.#source = source
    this.#plan = init.body
    const { path, query } = splitUrl(source.url)
    this.#rawQuery = query
    this.requestId = init.requestId
    this.method = source.method
    this.url = source.url
    this.path = path
    this.params = init.params
    this.headers = source.headers
    this.route = init.route
    this.request = source.raw
    this.response = source.rawResponse
    this.adapter = init.adapter
    this.ip = source.ip
  }

  get query(): Readonly<QueryRecord> {
    this.#query ??= parseQuery(this.#rawQuery)
    return this.#query
  }

  get state(): Map<string | symbol, unknown> {
    this.#state ??= new Map()
    return this.#state
  }

  get body(): unknown {
    return this.#body
  }

  get files(): Readonly<Record<string, readonly File[]>> {
    return this.#files ?? NO_FILES
  }

  /** Maximum body size of the route, in bytes. */
  get bodyLimit(): number {
    return this.#plan.limit
  }

  get responseHeaders(): Readonly<Record<string, HeaderValue>> {
    return this.#responseHeaders ?? EMPTY_HEADERS
  }

  /** Whether {@link setHeader}/{@link appendHeader} were called. */
  get hasResponseHeaders(): boolean {
    return this.#responseHeaders !== undefined
  }

  header(name: string): string | undefined {
    return this.headers[name.toLowerCase()]
  }

  setHeader(name: string, value: HeaderValue): void {
    this.#responseHeaders ??= emptyRecord()
    this.#responseHeaders[name.toLowerCase()] = typeof value === 'string' ? value : [...value]
  }

  appendHeader(name: string, value: string): void {
    this.#responseHeaders ??= emptyRecord()
    const key = name.toLowerCase()
    const existing = this.#responseHeaders[key]
    if (existing === undefined) this.#responseHeaders[key] = value
    else this.#responseHeaders[key] = typeof existing === 'string' ? [existing, value] : [...existing, value]
  }

  rawBody(): Promise<Uint8Array> {
    if (this.#raw === undefined) {
      if (this.#streamed) return Promise.reject(alreadyStreamed())
      this.#raw = this.#source.readBody(this.#plan.limit)
    }
    return this.#raw
  }

  bodyStream(): ReadableStream<Uint8Array> {
    if (this.#raw !== undefined || this.#streamed) throw alreadyStreamed()
    this.#streamed = true
    return this.#openBodyStream()
  }

  /**
   * Called by the pipeline once the request is over: a body stream that was neither read to its
   * end nor cancelled (a handler that read the first chunk, then threw) is cancelled, which makes the
   * adapter discard the rest of the body, so that the connection can serve the next request.
   */
  releaseBody(): void {
    const stop = this.#stopBody
    this.#stopBody = undefined
    stop?.()
  }

  /** The body as a stream (see {@link releaseBody}). */
  #openBodyStream(): ReadableStream<Uint8Array> {
    const reader = openBodyStream(this.#source, this.#plan.limit).getReader()
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const settle = (): void => {
      this.#stopBody = undefined
    }
    this.#stopBody = (): void => {
      reader.cancel().catch(() => undefined)
      try {
        controller?.error(new Error('The request is over: its body can no longer be read'))
      } catch {
        // already closed or errored
      }
    }
    return new ReadableStream<Uint8Array>(
      {
        start(current) {
          controller = current
        },
        async pull(current) {
          let result: Awaited<ReturnType<typeof reader.read>>
          try {
            result = await reader.read()
          } catch (error) {
            settle()
            throw error
          }
          if (result.done) {
            settle()
            current.close()
            return
          }
          current.enqueue(result.value)
        },
        cancel(reason) {
          settle()
          return reader.cancel(reason)
        },
      },
      { highWaterMark: 0 },
    )
  }

  parseBody(): Promise<unknown> {
    this.#parsed ??= this.#parse()
    return this.#parsed
  }

  async #parse(): Promise<unknown> {
    const headers = this.headers
    const contentType = headers['content-type']
    const media = parseMediaType(contentType)
    if (media?.type === 'multipart/form-data') {
      checkContentEncoding(headers['content-encoding'])
      const policy = this.#plan.multipart
      let result: MultipartResult
      if (this.#raw === undefined) {
        if (this.#streamed) throw alreadyStreamed()
        this.#streamed = true
        result = await readMultipart(this.#openBodyStream(), contentType as string, policy)
      } else {
        result = parseMultipart(await this.#raw, contentType as string, policy)
      }
      this.#files = result.files
      this.#body = result.fields
      return result.fields
    }
    if (this.#plan.upload) {
      // upload routes only accept multipart bodies (an empty body means "no file"); the framing
      // headers decide, the adapter only for requests without them (Web `Request`s built in memory)
      const framed = headers['content-length'] !== undefined || headers['transfer-encoding'] !== undefined
      if (!(framed ? hasBody(headers) : this.#source.hasBody?.() === true)) return undefined
      throw new UnsupportedMediaTypeException(
        `Expected a multipart/form-data body${media === undefined ? '' : ` (received ${JSON.stringify(media.type)})`}`,
      )
    }
    const bytes = await this.rawBody()
    const body = await parseBody(bytes, contentType, headers['content-encoding'])
    this.#body = body
    return body
  }
}

/** The body as a stream: the adapter's `streamBody`, or the buffered body when it has none. */
function openBodyStream(source: AdapterRequest, limit: number): ReadableStream<Uint8Array> {
  if (typeof source.streamBody === 'function') return source.streamBody(limit)
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const bytes = await source.readBody(limit)
        if (bytes.byteLength > 0) controller.enqueue(bytes)
        controller.close()
      },
    },
    { highWaterMark: 0 },
  )
}

function alreadyStreamed(): Error {
  return new Error(
    'The request body was already read: bodyStream() cannot be combined with rawBody(), parseBody(), @Body() or upload parameters',
  )
}

const EMPTY_HEADERS: Readonly<Record<string, HeaderValue>> = Object.freeze({})
const NO_FILES: Readonly<Record<string, readonly File[]>> = Object.freeze(emptyRecord<readonly File[]>())
