# @znight/http

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
