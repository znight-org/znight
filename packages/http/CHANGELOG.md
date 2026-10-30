# @znight/http

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
