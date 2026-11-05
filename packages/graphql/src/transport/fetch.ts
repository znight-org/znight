/**
 * The Fetch bridge of route-mounted drivers (RFC 0009 §4.4, Q10): the Web `Request` a Fetch server
 * (GraphQL Yoga) handles, built from the `HttpContext` of the route. Internal to `@znight/graphql`
 * (a candidate for `@znight/http` once a second user appears).
 *
 * - On `honoAdapter()` the native request already is a Web `Request`: it is handed over as is when
 *   its body was not read and cannot exceed the route's body limit (a `GET`, or a declared
 *   `content-length` within the limit), so nothing is copied.
 * - Otherwise (Node-style adapters, chunked bodies) a `Request` is built from the method, the URL,
 *   the headers and the body read by `ctx.rawBody()`: the route's body limit then answers with
 *   `HttpPlugin`'s 413 on every adapter, before the server sees the request. GraphQL servers buffer
 *   the body to parse it anyway, so reading it first costs no extra copy of note.
 */
import type { HttpContext } from '@znight/http'

/** The Web `Request` of the route's request, read under `limit` bytes. */
export function fetchRequest(ctx: HttpContext, limit: number): Request | Promise<Request> {
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
  if (bodyless) return new Request(url, { method, headers, signal: ctx.signal })
  return ctx.rawBody().then(body => new Request(url, { method, headers, body, signal: ctx.signal }))
}

/** The absolute URL of the request: the raw target on the request's protocol and host. */
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

function requestHeaders(ctx: HttpContext): Headers {
  const headers = new Headers()
  const source = ctx.headers
  for (const name in source) {
    const value = source[name]
    if (value !== undefined) headers.append(name, value)
  }
  return headers
}
