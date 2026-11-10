# @znight/http

## 0.7.0

### Patch Changes

- @znight/compiler@0.7.0
  - @znight/core@0.7.0

## 0.6.6

### Patch Changes

- Updated dependencies [d85b11b]
  - @znight/compiler@0.6.6
  - @znight/core@0.6.6

## 0.6.5

### Patch Changes

- 1a2b15c: A client leaving during a WebSocket handshake now aborts `ctx.signal` (`kind: 'client'`) and the handshake is not completed (`PendingUpgrade.disconnected`); the accepted connection closing later never aborts it. On `node:http` a client's FIN is detected even behind bytes it sent after its headers, and a guard failing with that abort (passing `ctx.signal` to `fetch()`) is answered `400` without an error log. `upgradeInMemory()` takes a `signal`, and `AdapterRequest.onAbort` may return a function removing its listener.
- ad31655: `HttpResponse.file()` accepts a lazy file (`{ size, etag?, lastModified?, type?, name?, load() }`): conditional requests and ranges are evaluated from its metadata, and `load()` is called only when a body is sent (never for a 304, a 412 or a `HEAD` request). A weak entity tag no longer satisfies `If-Match` nor `If-Range`, and `If-Match` / `If-None-Match` lists are split outside quotes, so an entity tag containing a comma (`"3,7"`) matches.
- @znight/compiler@0.6.5
  - @znight/core@0.6.5

## 0.6.4

### Patch Changes

- 74b6b04: An adapter trusting every proxy hop (Fastify `trustProxy: true`, an Express `trust proxy` accepting any address, including a function or ranges) is refused at boot only when the `trustProxy` option of `HttpPlugin` is not set, since `ctx.ip` then comes from the adapter (0.6.3 refused it in every case). Migration from 0.6.2: set `HttpPlugin.configure({ trustProxy })` to your proxies (a hop count or addresses), or remove the framework setting.
- 74b6b04: The WebSocket handshake timeout aborts `ctx.signal` with the message "The WebSocket handshake timed out" instead of the SSE `maxDuration` one; `RequestAbortedError` takes an optional message.
- 74b6b04: Report a route decorator already applied and stored in a `const` (`const AdminOnly = Roles(['admin'])`, used as `@AdminOnly`) as ZNIGHT005 instead of dropping its decision.
- 74b6b04: `matchesMediaType()` and upload part types accept a comma inside a quoted parameter value (`multipart/form-data; boundary="a,b"`) and still refuse a list of types.
- Updated dependencies [74b6b04]
- Updated dependencies [74b6b04]
  - @znight/compiler@0.6.4
  - @znight/core@0.6.4

## 0.6.3

### Patch Changes

- dc4be25: Fix audit findings: refuse adapters trusting every proxy hop, linear-time `Range` parsing, bounded stop of cancelled stream sources, route decorator aliases and wrappers, capped validation details, single-type upload media types, Hono late replies, handshake timeout abort, `injectStream()` listener cleanup and body headers on error replies.
- Updated dependencies [0eeac37]
- Updated dependencies [dede0c2]
  - @znight/compiler@0.6.3
  - @znight/core@0.6.3

## 0.6.2

### Patch Changes

- @znight/compiler@0.6.2
  - @znight/core@0.6.2

## 0.6.1

### Patch Changes

- 3785557: The JSDoc of `@Req()` no longer says the compiler warns: only `@Res()` does.
- @znight/compiler@0.6.1
  - @znight/core@0.6.1

## 0.6.0

### Minor Changes

- f6cbef6: Upgrade routes for plugins (RFC 0003 groundwork): `PluginHttpUpgrades`, the adapters' upgrade capability, `HttpPlugin.upgradeInMemory()`, the `websocket:*` hook types and the ZNIGHT050/051 codes.

### Patch Changes

- Updated dependencies [f6cbef6]
  - @znight/core@0.6.0
  - @znight/compiler@0.6.0

## 0.5.1

### Patch Changes

- @znight/compiler@0.5.1
  - @znight/core@0.5.1

## 0.5.0

### Patch Changes

- Updated dependencies [469d6bf]
  - @znight/core@0.5.0
  - @znight/compiler@0.5.0

## 0.4.0

### Minor Changes

- 3bb4597: Custom parameter decorators (RFC 0010): `createParamDecorator<T, D>({ http, graphql, messaging })` defines a `@CurrentUser()` of your own, checked at build time (target, transport, data argument, value type) and called directly by the generated `invoke` of routes, GraphQL fields and message handlers; resolvers are functions or `ParamResolver` providers in any scope. The compiler adds `AnalyzeContext.paramDecorator` and `TypeHelpers.assignable` to the extension API; `TestApp` instantiates parameter resolvers with the controllers, resolvers and consumers.

### Patch Changes

- Updated dependencies [3bb4597]
  - @znight/core@0.4.0
  - @znight/compiler@0.4.0

## 0.3.0

### Patch Changes

- 75f4b8c: `PluginHttpRoutes.onHttpDrain()`: `HttpPlugin` tells the plugins serving routes that it starts draining, whatever the plugin order, so they end the streams it does not know of. The engine's subscriptions end there, and a route-mounted GraphQL driver stops once the drain is over (requests in flight are served, a stopped driver answers 503). The Yoga driver takes `application/json` `POST` bodies only (415 otherwise, like the built-in transport: no CSRF through forms), masks errors thrown outside the engine, and refuses Yoga's `batching` and `multipart` options (ZNIGHT066).
- Updated dependencies [75f4b8c]
  - @znight/core@0.3.0
  - @znight/compiler@0.3.0

## 0.2.2

### Patch Changes

- @znight/compiler@0.2.2
  - @znight/core@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [1ecae4f]
  - @znight/compiler@0.2.1
  - @znight/core@0.2.1

## 0.2.0

### Patch Changes

- b6119e6: The fast lane of the request pipeline also serves an `HttpResponse` carrying a plain JSON body with no header other than `content-type` and no cookie (`HttpResponse.ok(body)`, an explicit status, a custom JSON media type), byte for byte like the general pipeline: about 0.3 to 0.4 µs less per request.
- Updated dependencies [b6119e6]
  - @znight/compiler@0.2.0
  - @znight/core@0.2.0

## 0.1.4

### Patch Changes

- b6d42bc: The fast lane of the request pipeline now serves requests with `http:request` listeners or wrappers instead of sending them through the general pipeline, with the same replies and the same hook events (applications with `@znight/observability` get it).
- c21ef01: `RouteMetaCarrier` (route decorators read metadata from any carrier), `readRouteMeta`, `effectiveRouteMeta` and `requiredRouteGroups` exported from `@znight/http/compiler`, and a per-route `bodyLimit` on plugin routes.
- Updated dependencies [c21ef01]
- Updated dependencies [c21ef01]
  - @znight/compiler@0.1.4
  - @znight/core@0.1.4

## 0.1.3

### Patch Changes

- 39f7f5f: Faster Hono adapter on Bun, with the same behaviour: a request body with a `Content-Length` is read at once (`request.bytes()`) instead of through a Web stream, responses go to `Bun.serve()` untouched (no `response.body` read, no wrapper without Hono middleware), and the GET and HEAD routes of a path are one Hono route.
- 39f7f5f: Faster Node.js adapters, with the same responses: the Fastify adapter serves a Znight route from its `onRequest` hook when no other hook needs Fastify's lifecycle (no content type parsing) and writes text replies on the raw response when no `onSend`/`onResponse` hook runs; the node, Fastify and Express adapters read request bodies and count in-flight requests without closures or map lookups per request.
- 39f7f5f: A fast lane for simple routes: a synchronous handler returning JSON is served without promises and its headers come from a template computed at boot; `container.openScope()` opens a request scope without a callback.
- 39f7f5f: Faster serialisation and request bodies, with the same responses: response header records stay in V8's fast mode (about 100 ns per request on Node.js), text bodies are encoded once, `content-type` values are parsed once per distinct value, the request context parses its buffered body without an extra promise, and `isHttpResponse` answers object literals and arrays at once.
- 39f7f5f: Faster validated routes: the generated `invoke` of a route validating arguments with schemas stays synchronous while the schemas validate synchronously (no promise and no `await` per request), and falls back to awaiting them, in parameter order, for asynchronous schemas. `coerce.number`, `coerce.integer` and `coerce.boolean` read plain values without a regular expression, `validate` reads `~standard` once, `isThenable` is exported for the generated code, and code generators get the `block` builder.
- Updated dependencies [39f7f5f]
- Updated dependencies [39f7f5f]
  - @znight/core@0.1.3
  - @znight/compiler@0.1.3

## 0.1.2

### Patch Changes

- 4f680af: Faster request pipeline on every adapter (1.4× to 2.7× the requests per second on Node.js), with the same behaviour: the async context is captured for streamed bodies only, serialiser headers are not checked twice, text bodies reach the adapters as strings (`AdapterReply.text`), and the Hono adapter reads HTTP/1.1 requests from Node.js directly.
- @znight/compiler@0.1.2
  - @znight/core@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [dc8ac11]
  - @znight/compiler@0.1.1
  - @znight/core@0.1.1

## 0.1.0

### Initial release

- First public release of `@znight/http`. Znight HTTP plugin: controllers, routing, guards, interceptors, validation with Fastify, Express or Hono.
