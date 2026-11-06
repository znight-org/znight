/**
 * The Fetch bridge of route-mounted drivers (RFC 0009 §4.4, Q10): the Web `Request` a Fetch server
 * (GraphQL Yoga) handles, built from the `HttpContext` of the route. Internal to `@znight/graphql`
 * (a candidate for `@znight/http` once a second user appears).
 *
 * - On `honoAdapter()` the native request already is a Web `Request`: it is handed over as is when
 *   its body was not read and cannot exceed the route's body limit (a `GET`, or a declared
 *   `content-length` within the limit), so nothing is copied.
 * - Otherwise (Node-style adapters, chunked bodies) a `Request` of the server's own Fetch API is
 *   built from the method, the URL, a copy of the headers and the body read by `ctx.rawBody()`:
 *   the route's body limit then answers with `HttpPlugin`'s 413 on every adapter, before the
 *   server sees the request. GraphQL servers buffer the body to parse it anyway, so reading it
 *   first costs no extra copy of note. Yoga's `Request` on Node.js (the `@whatwg-node` ponyfill)
 *   keeps the bytes, the headers record and the URL string as they are, and parses them on use.
 *
 * Either way the body of the `Request` cannot exceed the route's limit: the server needs no limit of
 * its own (Yoga's `maxRequestBodySize` would pipe every body through a counting stream).
 */
import type { HttpContext } from '@znight/http'

/** The `Request` constructor of a Fetch API (the server's own: Yoga's `fetchAPI.Request`). */
export type RequestClass = new (input: string, init: RequestInit) => Request

/**
 * The Web `Request` of the route's request, read under `limit` bytes: the native one (see above),
 * or one built with `Fetch`.
 */
export function fetchRequest(ctx: HttpContext, limit: number, Fetch: RequestClass): Request | Promise<Request> {
  const native = ctx.request
  const method = ctx.method
  const bodyless = method === 'GET' || method === 'HEAD'
  if (native instanceof Request && !native.bodyUsed) {
    if (bodyless) return native
    const length = ctx.headers['content-length']
    if (length !== undefined && ctx.headers['transfer-encoding'] === undefined) {
      // past the limit, ctx.rawBody() below rejects with HttpPlugin's own 413
      const declared = Number(length)
      if (Number.isSafeInteger(declared) && declared >= 0 && declared <= limit) return native
    }
  }
  const url = requestUrl(ctx)
  const headers = requestHeaders(ctx)
  if (bodyless) return new Fetch(url, { method, headers, signal: ctx.signal })
  return ctx.rawBody().then(body => new Fetch(url, { method, headers, body, signal: ctx.signal }))
}

/**
 * The absolute URL of the request: the raw target on the request's protocol and host. Checked with
 * `URL.canParse()` (as cheap as any test of the host, about 30 ns), kept as a string: the ponyfill
 * parses it only if it is read.
 */
function requestUrl(ctx: HttpContext): string {
  const host = ctx.headers['host']
  const target = ctx.url
  if (host !== undefined && target.startsWith('/') && !target.startsWith('//')) {
    const url = `${ctx.protocol}://${host}${target}`
    if (URL.canParse(url)) return url
  }
  // no host header, or one a URL cannot hold: the path and query string still route the request
  return new URL(target.startsWith('/') ? target.replace(/^\/+/, '/') : `/${target}`, `${ctx.protocol}://localhost`)
    .href
}

/**
 * A copy of the request headers (the server may set some on its `Request`), as a record: the
 * ponyfill's `Headers` read it lazily, native ones take it in one call.
 */
function requestHeaders(ctx: HttpContext): Record<string, string> {
  const headers: Record<string, string> = Object.create(null)
  const source = ctx.headers
  for (const name in source) {
    const value = source[name]
    if (value !== undefined) headers[name] = value
  }
  return headers
}
