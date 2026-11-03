# @znight/graphql

Code-first GraphQL for [Znight](../../README.md): the TypeScript types are the schema. Resolvers
are providers marked with `@Resolver`, `@Query`, `@Mutation`, `@Subscription` and `@ResolveField`;
the compiler extension (`@znight/graphql/compiler`) follows every type their signatures reach and
derives the complete schema at build time, with descriptions and deprecations taken from JSDoc. At
runtime, `GraphQLPlugin` serves it on graphql-js 17 through the HTTP plugin, with DataLoader batching
and subscriptions over Server-Sent Events. The design is [RFC 0005](../../rfcs/0005-graphql.md); the
package is in progress and not published yet.

```sh
# bun
bun add @znight/core @znight/http @znight/graphql graphql
bun add -d @znight/compiler vite

# npm
npm install @znight/core @znight/http @znight/graphql graphql
npm install -D @znight/compiler vite
```

Runs on Node.js >= 24 and Bun >= 1.3 (ESM only). `@znight/http` and `graphql` 17 are required peer
dependencies; `dataloader` is a dependency.

```ts
import { Args, type ID, Query, Resolver } from '@znight/graphql'

interface Book {
  readonly id: ID
  readonly title: string
}

@Resolver()
export class BookResolver {
  /** One book. */
  @Query()
  book(@Args('id') id: ID): Book | null {
    return id === '1' ? { id, title: 'Dune' } : null
  }
}
```

## HTTP endpoint

`GraphQLPlugin` contributes two routes to `HttpPlugin` on `path` (default `/graphql`, under the
`HttpPlugin` prefix): `GET` and `POST`, with the route metadata, guards and body limit of the
`http` option (`{ meta, guards, bodyLimit: '100kb', get: true }`; `http: false` serves no route).
They run through the HTTP pipeline like a controller route, without interceptors. The endpoint
follows the GraphQL-over-HTTP specification draft:

| Request                                                | Answer                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------- |
| `POST` with `content-type: application/json`           | `{ query, operationName?, variables?, extensions? }` executed          |
| `POST` with another content type or a content encoding | 415 (no form or text body: cross-site requests are always preflighted) |
| `POST` with an array body (batching)                   | 400                                                                    |
| `POST` with malformed JSON, a non-object, no `query`   | 400                                                                    |
| `POST` past the body limit                             | 413, with a GraphQL error body                                         |
| `GET ?query=...&variables=...` (JSON parameters)       | queries only; a mutation or a subscription is 405 with `allow: POST`   |
| `GET` with `http.get: false`                           | 405 with `allow: POST`                                                 |
| `GET` with `accept: text/html` and `graphiql` on       | the GraphiQL page, with its own `content-security-policy`              |
| A subscription without `accept: text/event-stream`     | 400, with a hint                                                       |
| `accept` that lists none of the produced types         | 406                                                                    |

The `accept` header picks the answer: `application/graphql-response+json` when listed (200 with
`data`, 400 for parse, validation, variable and limit errors), otherwise `application/json` (200
for every well-formed request; no `accept` header, `*/*` and `application/*` mean
`application/json`), or `text/event-stream` for GraphQL over SSE (distinct connections mode, any
operation): one `next` event per result, then `complete`. The stream is RFC 0006's
`HttpResponse.sse()` with the `subscriptions` options (`heartbeat`, `maxDuration`): a client that
leaves aborts `ctx.signal` and ends the source, a stream closed by the shutdown ends without
`complete` (clients reconnect to another instance), and past `subscriptions.maxActive` a new
subscription is 503. An asynchronous query whose client leaves is aborted.

On the hot path (a cached query, synchronous resolvers), a request is a memoised `accept` lookup,
the body or the query string read once, the execution, and one `JSON.stringify`; every answer
stays on the fast lane of `@znight/http` unless the application adds CORS, guards or
`http:request` hooks.

## Testing

`@znight/graphql/testing` (with the optional peer `@znight/testing`):

- `executeOperation(app, { query, variables?, operationName?, extensions?, headers? })` sends a
  `POST` through `app.inject()` (the whole HTTP pipeline) and resolves with `{ status, headers,
  body, data, errors, extensions }`; without HTTP transport it calls `GraphQLPlugin.execute()`.
- `subscribeOperation(app, request)` streams the operation over GraphQL over SSE in memory
  (`injectStream()`), or through `GraphQLPlugin.subscribe()` without HTTP transport. Its `next()`
  times out (2 s by default) and `return()` disconnects, which the server sees as a client abort.
- `fakeLoader<L>(values | fn)` builds a `Loader<L>` whose `load` and `loadMany` are spies.

```ts
import { executeOperation, fakeLoader } from '@znight/graphql/testing'

const res = await executeOperation(app, { query: '{ books { title } }' })
expect(res.status).toBe(200)
expect(res.errors).toBeUndefined()

const authors = fakeLoader<AuthorsById>({ a1: { id: 'a1', name: 'Frank Herbert' } })
```

## Benchmarks

Two non-gating micro-benchmarks, run by hand from `packages/graphql` (`bun test` does not run
them; on Node.js, use `node --conditions=@znight/source` instead of `bun`):

- `bun --conditions=@znight/source test/bench/execute.bench.ts`: the per-operation overhead of
  `GraphQLPlugin.execute()` over graphql-js `execute()` for a cached 50-field query (target:
  under 10 %).
- `bun --conditions=@znight/source test/bench/http.bench.ts`: the endpoint through the `HttpPlugin`
  pipeline in process (`GET` and `POST`, both JSON media types), next to bare graphql-js and to a
  controller route answering a constant. `ABORT_REASON=1` removes the cost graphql-js 17.0 adds to
  every execution on Node.js (a `DOMException` built when it aborts its own `AbortController`).

## Compiler contract

The compiler extension generates `metadata.extensions.graphql` (`GraphQLMetadata`, declared in
[`src/metadata.ts`](./src/metadata.ts)): the schema as data, sorted by type name, with one
`invoke` function per resolver method. Type references are strings in graphql-js' canonical form
(`'[Book!]!'`), and `schemaHash` is the first 16 hexadecimal characters of the SHA-256 of the SDL
printed by `src/sdl.ts`, byte-identical to graphql-js `printSchema()` of the schema the plugin builds.

The generated `invoke` functions call two runtime helpers, kept stable:

- `validateArgs(schema, value, label)`, exported from `@znight/graphql`: validates an argument with
  a Standard Schema and returns its output, synchronously when the schema validates synchronously
  (a promise otherwise, which the `async` invoker awaits); a failure is a `GraphQLException`
  `BAD_USER_INPUT` whose `extensions.issues` lists `{ path, message }`. `label` is the argument
  name, or `'arguments'` for `@Args(Schema)` without name.
- `GraphQLContext.loader(token)`: the DataLoader of the current execution (one operation, or one
  subscription event) for a loader provider token.

Everything else in the section is data the plugin interprets at boot: it checks the section
structurally (version, roots, names, type references, bindings, discriminators, scalars, groups),
builds the schema with graphql-js constructors and fails with one ZNIGHT066 error listing every
problem. Null handling (`nullAsUndefined`) is applied before `invoke`, by normalisers built at boot
only for the fields that need one; a field without guards nor normaliser calls `invoke` directly.
