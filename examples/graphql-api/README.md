# GraphQL API

A book catalog served over **GraphQL** with [Znight](../../README.md): books, authors and reviews,
queries with filters and pagination, validated mutations, batched field resolvers, and
**subscriptions over Server-Sent Events**. It runs on Node.js and on Bun, served by **Hono**, with a
REST health check next to the GraphQL endpoint.

It is the reference example of [`@znight/graphql`](../../packages/graphql/README.md), the
application of [RFC 0005](../../rfcs/0005-graphql.md) §14, and the source of the snippets of the
[GraphQL guide](../../docs/guide/graphql.md).

- **The types are the schema.** The compiler follows every type the resolvers reach and derives the
  schema at build time, with descriptions and deprecations from JSDoc. No `@ObjectType`, no
  `@Field(() => Int)`, no SDL to keep in sync.
- **The schema is committed.** The compiler writes [`schema.graphql`](schema.graphql): every pull
  request shows its schema diff, `znight generate --check` fails when it is stale, and a test proves
  the served schema is the file, byte for byte.
- **Schema errors at build time.** A type GraphQL cannot express, a union that cannot be told apart,
  a root field without access decision: `znight build` fails with a located diagnostic.
- **No N+1.** Field resolvers load through loaders: one repository call per execution, whatever the
  number of books, proven by a test.
- **One access vocabulary.** The route decorators of `@znight/http` decide for routes and for
  GraphQL fields, and one guard enforces them on both.

The repositories are in memory (the data layer is the subject of
[`rest-api`](../rest-api/README.md)): each instance starts from [`seed.ts`](src/catalog/seed.ts).

## What it shows

| Feature                                                                                          | Where                                                                                                                                               |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Types as the schema: a TypeScript enum, a literal-union enum, a generic `Page<T>`, JSDoc         | [`catalog/book.ts`](src/catalog/book.ts)                                                                                                            |
| `@deprecated`, `@gqlHidden` (`Book.authorId`, exposed as `author`)                               | [`catalog/book.ts`](src/catalog/book.ts), [`reviews/review.ts`](src/reviews/review.ts)                                                              |
| An arguments object (`@Args(BookFilter)`) with `@default` values, validated by a Zod schema      | [`catalog/book.args.ts`](src/catalog/book.args.ts)                                                                                                  |
| Input types validated by Zod schemas of the same name (`BAD_USER_INPUT` with the issues)         | [`catalog/book.inputs.ts`](src/catalog/book.inputs.ts), [`reviews/review.ts`](src/reviews/review.ts)                                                |
| Queries, a nullable lookup with a `@param` description, a mutation, a subscription               | [`catalog/book.resolver.ts`](src/catalog/book.resolver.ts)                                                                                          |
| Field resolvers batched by loaders (`@Loader() authors: Loader<AuthorsById>`), with arguments    | [`authors-by-id.loader.ts`](src/catalog/authors-by-id.loader.ts), [`reviews/review.resolver.ts`](src/reviews/review.resolver.ts)                    |
| A union told apart by `kind` (`search: [SearchResult!]!`)                                        | [`search/search.ts`](src/search/search.ts), [`search.resolver.ts`](src/search/search.resolver.ts)                                                   |
| A custom scalar: `EmailAddress`, a branded string checked and lower-cased                        | [`shared/scalars.ts`](src/shared/scalars.ts)                                                                                                        |
| A request-scoped resolver injecting the request-scoped `CurrentUser`                             | [`auth/viewer.resolver.ts`](src/auth/viewer.resolver.ts)                                                                                            |
| Subscriptions over SSE fed by the injectable `PubSub`, filtered in `async *` generators          | [`book.resolver.ts`](src/catalog/book.resolver.ts), [`review.resolver.ts`](src/reviews/review.resolver.ts)                                          |
| A required `access` group (`@Public` / `@Authenticated` / `@Roles`), checked at build and boot   | [`auth/access.ts`](src/auth/access.ts)                                                                                                              |
| An HTTP guard identifying the caller (API keys, `@Secret`), one guard deciding routes and fields | [`authentication.guard.ts`](src/auth/authentication.guard.ts), [`access.guard.ts`](src/auth/access.guard.ts), [`api-keys.ts`](src/auth/api-keys.ts) |
| Domain errors mapped to `CONFLICT` and `NOT_FOUND` in one place                                  | [`shared/catalog-error.mapper.ts`](src/shared/catalog-error.mapper.ts), [`catalog/errors.ts`](src/catalog/errors.ts)                                |
| A REST controller next to GraphQL, through the same guards                                       | [`health/health.controller.ts`](src/health/health.controller.ts)                                                                                    |
| The plugins, shared by `main.ts` and the tests; the SDL artifact                                 | [`plugins.ts`](src/plugins.ts), [`znight.config.ts`](znight.config.ts)                                                                              |
| `TestBed` and `fakeLoader`, operations through the whole stack, build checks, e2e                | [`test/`](test)                                                                                                                                     |

## Run it

Requirements: Node.js 24+ or Bun 1.3+. In this repository, install and build the framework once,
from the repository root: `bun install && bun run build` (the CLI and the production build use the
packages' `dist`).

```sh
bun run dev          # or: npm run dev
```

`dev` builds the application in watch mode and restarts it on every change, with
`NODE_ENV=development`: [`.env.development`](.env.development) provides development API keys
(`dev-editor-key`, `dev-reader-key`), debug logs and unmasked errors, and **GraphiQL** opens on
<http://localhost:3000/graphql> in a browser.

| Script      | bun                 | npm / Node.js       | Does                                                                               |
| ----------- | ------------------- | ------------------- | ---------------------------------------------------------------------------------- |
| `dev`       | `bun run dev`       | `npm run dev`       | `znight dev`: build in watch mode, restart on change                               |
| `build`     | `bun run build`     | `npm run build`     | `znight build`: production bundle `dist/main.js` (fails on any schema error)       |
| `start`     | `bun run start`     | `npm run start`     | `znight start`: runs `dist/main.js` with `NODE_ENV=production`                     |
| `test`      | `bun run test`      | —                   | unit, GraphQL, HTTP and build checks (`bun test`), about a second                  |
| `test:e2e`  | `bun run test:e2e`  | —                   | builds, then runs the bundle on Node.js **and** Bun over real HTTP                 |
| `typecheck` | `bun run typecheck` | `npm run typecheck` | generates the container and the schema, then `tsc --noEmit`                        |
| `generate`  | `bun run generate`  | `npm run generate`  | writes `src/.znight/container.generated.ts` and `schema.graphql` (`--check` in CI) |

The production bundle runs on both runtimes, configured by environment variables only:

```sh
bun run build
EDITOR_API_KEY=change-me READER_API_KEY=change-me-too node --enable-source-maps dist/main.js   # Node.js
EDITOR_API_KEY=change-me READER_API_KEY=change-me-too bun dist/main.js                          # Bun
```

```json
{"level":30,"component":"znight","adapter":"hono","routes":5,"msg":"HTTP server listening on http://0.0.0.0:3000"}
{"level":30,"component":"znight","path":"/graphql","types":16,"schemaHash":"186afeabad93e143","msg":"GraphQL endpoint ready"}
{"level":30,"url":"http://0.0.0.0:3000","graphql":"http://0.0.0.0:3000/graphql","msg":"Book catalog ready"}
```

### Configuration

Read by [`ConfigPlugin`](../../packages/config/README.md) from `.env` files, then from the
environment (which wins), and validated at boot: a missing key stops the boot with every problem
listed (`ZNIGHT006`), secrets never printed.

| Variable         | Default            | Description                                                                             |
| ---------------- | ------------------ | --------------------------------------------------------------------------------------- |
| `EDITOR_API_KEY` | (required)         | Key of the editors: they add books, and do what readers do (`@Secret`: never printed)   |
| `READER_API_KEY` | (required)         | Key of the readers: `me`, reviews, subscriptions                                        |
| `PORT` / `HOST`  | `3000` / `0.0.0.0` | API address (`PORT=0`: a free port, logged when ready)                                  |
| `LOG_LEVEL`      | `info`             | `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`                            |
| `EXPOSE_ERRORS`  | `false`            | Send the real message of unexpected errors instead of `Unexpected error.` (development) |
| `NODE_ENV`       | —                  | `production`: introspection off and suggestions hidden; `development`: GraphiQL         |

## Try it

With `bun run dev` running:

```sh
API=http://localhost:3000/graphql
```

### Queries

```sh
# anonymous: the catalog is public. Enum values are names on the wire (Fantasy, ScienceFiction...)
curl -s -H 'content-type: application/json' \
  -d '{"query":"{ books(genre: Fantasy, limit: 2) { total hasMore items { title author { name } } } }"}' $API
# {"data":{"books":{"total":2,"hasMore":false,"items":[{"title":"A Wizard of Earthsea","author":{"name":"Ursula K. Le Guin"}},{"title":"The Hobbit","author":{"name":"J. R. R. Tolkien"}}]}}}

# queries also work over GET (mutations do not: 405)
curl -s -G $API --data-urlencode 'query={ book(id: "b1") { title publishedYear reviews(first: 1) { rating comment reviewer } } }'
# {"data":{"book":{"title":"Dune","publishedYear":1965,"reviews":[{"rating":4,"comment":null,"reviewer":"reader2@books.example"}]}}}

# a union: books and authors
curl -s -H 'content-type: application/json' \
  -d '{"query":"{ search(text: \"le\") { __typename ... on Book { title } ... on Author { name } } }"}' $API
# {"data":{"search":[{"__typename":"Book","title":"The Left Hand of Darkness"},{"__typename":"Author","name":"Ursula K. Le Guin"}]}}

# the caller: an API key is needed
curl -s -H 'content-type: application/json' -H 'x-api-key: dev-reader-key' -d '{"query":"{ me { name email roles } }"}' $API
# {"data":{"me":{"name":"reader","email":"reader@books.example","roles":["reader"]}}}
curl -s -H 'content-type: application/json' -d '{"query":"{ me { name } }"}' $API
# {"data":null,"errors":[{"message":"Authentication required",...,"path":["me"],"extensions":{"code":"UNAUTHENTICATED"}}]}

# a REST route next to GraphQL
curl -s http://localhost:3000/health
# {"status":"ok","uptime":2,"subscriptions":0}
```

### A subscription, then mutations

In a first terminal, follow the fantasy books as a reader. Subscriptions are GraphQL over
Server-Sent Events: a plain `POST` with `accept: text/event-stream`.

```sh
curl -N -H 'accept: text/event-stream' -H 'content-type: application/json' -H 'x-api-key: dev-reader-key' \
  -d '{"query":"subscription { bookAdded(genre: Fantasy) { title author { name } } }"}' http://localhost:3000/graphql
# :
#
# event: next
# data: {"data":{"bookAdded":{"title":"The Fellowship of the Ring","author":{"name":"J. R. R. Tolkien"}}}}
```

In a second one, add a book as an editor. The Zod schema of `NewBookInput` trims the title,
normalises the ISBN and lower-cases the tags before the resolver runs:

```sh
curl -s -H 'content-type: application/json' -H 'x-api-key: dev-editor-key' \
  -d '{"query":"mutation Add($input: NewBookInput!) { addBook(input: $input) { id title isbn tags } }",
       "variables":{"input":{"title":" The Fellowship of the Ring ","isbn":"978-0-547-92821-0","authorId":"a3","genre":"Fantasy","publishedYear":1954,"tags":["Rings"]}}}' $API
# {"data":{"addBook":{"id":"b7","title":"The Fellowship of the Ring","isbn":"9780547928210","tags":["rings"]}}}

# the same ISBN again: a domain error mapped to CONFLICT
# {"data":null,"errors":[{"message":"A book with the ISBN 9780547928210 is already in the catalog",...,"extensions":{"isbn":"9780547928210","code":"CONFLICT"}}]}

# an invalid input: every issue of the schema
# {"data":null,"errors":[{"message":"Invalid input",...,"extensions":{"issues":[{"path":"title","message":"A title is required"},{"path":"isbn","message":"An ISBN has 10 or 13 digits"}],"code":"BAD_USER_INPUT"}}]}

# the reader key cannot add books
# {"data":null,"errors":[{"message":"Not allowed to resolve Mutation.addBook",...,"extensions":{"code":"FORBIDDEN"}}]}
```

Reviews take an `EmailAddress`, a custom scalar: GraphQL checks and lower-cases it before the
resolver runs.

```sh
curl -s -H 'content-type: application/json' -H 'x-api-key: dev-reader-key' \
  -d '{"query":"mutation { addReview(input: { bookId: \"b7\", rating: 5, reviewer: \"Frodo@Shire.example\" }) { id rating reviewer } }"}' $API
# {"data":{"addReview":{"id":"r5","rating":5,"reviewer":"frodo@shire.example"}}}

# reviewer: "frodo"
# {"errors":[{"message":"Expected value of type \"EmailAddress\", but encountered error \"Expected an e-mail address\"; found: \"frodo\".",...,"extensions":{"code":"GRAPHQL_VALIDATION_FAILED"}}]}
```

A wrong API key is refused by the HTTP guard, before GraphQL runs:

```sh
curl -s -i -H 'content-type: application/json' -H 'x-api-key: nope' -d '{"query":"{ books { total } }"}' $API
# HTTP/1.1 401 Unauthorized
# www-authenticate: ApiKey header="x-api-key"
# {"statusCode":401,"error":"Unauthorized","message":"Invalid API key"}
```

## Try breaking it

The schema is checked by the compiler: `znight build`, `znight dev`, `znight generate` and `bun test`
fail with a located diagnostic. In [`book.ts`](src/catalog/book.ts), give `Book` a cover as bytes
(`readonly cover: Uint8Array | null`):

```txt
✗ ZNIGHT060: Cannot map binary data to a GraphQL type (Book.cover)
  --> src/catalog/book.ts:18:19
   |
18 |   readonly cover: Uint8Array | null
   |                   ^^^^^^^^^^^^^^^^^
   |
  ::: src/catalog/book.resolver.ts:44:3
   |
44 |   books(@Args(BookFilter) filter: BookFilter): Promise<Page<Book>> {
   |   ----- reached from Query.books → BookPage.items → Book
   = hint: Expose a URL (coverUrl: string), hide the property with /** @gqlHidden */, or declare a scalar: export const Base64 = scalar<Uint8Array>('Base64', { ... })
```

Remove `readonly kind: 'author'` from `Author`: graphql-js could no longer tell a book from an
author in `search` results.

```txt
✗ ZNIGHT064: The members of union SearchResult cannot be told apart at runtime: Author and Book have no common literal property
 --> src/search/search.ts:6:13
  |
6 | export type SearchResult = Book | Author
  |             ^^^^^^^^^^^^
  = hint: Add a literal property to each member (readonly kind: 'author' / readonly kind: 'book'), or make the members classes
```

Remove `@Public()` from `search` in [`search.resolver.ts`](src/search/search.resolver.ts): the
`access` group is required, so a root field without decision is not denied or allowed by accident,
it does not build.

```txt
✗ ZNIGHT023: Root field Query.search (SearchResolver.search) has no "access" decision
  --> src/search/search.resolver.ts:17:3
   |
17 |   search(@Args('text') text: string): Promise<readonly SearchResult[]> {
   |   ^^^^^^
   |
  ::: src/auth/access.ts:16:14
   |
16 | export const Public = createRouteDecorator('public', { group: 'access', required: true })
   |              ------ The "access" group is required
   = hint: Add @Public(), @Authenticated() or @Roles(...) to the method or to SearchResolver
```

Edit `schema.graphql` by hand, or change a type without regenerating: `znight generate --check`
answers `✗ schema.graphql is out of date`. [`build-check.test.ts`](test/build-check.test.ts) compiles
a copy of the application with these changes and checks every diagnostic, so this section stays
true.

## How it is built

### The schema

[`book.ts`](src/catalog/book.ts) holds plain interfaces: `Book`, `Author`, `Page<T>`, a TypeScript
`enum Genre` and a literal union `BookSort`. Nothing imports a decorator. The resolvers'
signatures decide what is part of the schema: `books(@Args(BookFilter) filter: BookFilter):
Promise<Page<Book>>` reaches `BookPage` (generic instances are named after their arguments), `Book`,
`Genre`... Nullability comes from the types (`Int | null` is `Int`, `Int` is `Int!`), numbers are
`Float` unless typed `Int` or `ID`, `Date` is `DateTime`. Explicit return types are required: the
compiler reads annotations, it never infers.

[`znight.config.ts`](znight.config.ts) configures the extension with
`graphql.configure({ sdl: 'schema.graphql' })`: the compiler writes the SDL next to the generated
module, byte-identical to what graphql-js prints for the schema the plugin builds.
[`schema.test.ts`](test/schema.test.ts) checks exactly that.

### Resolvers

A resolver is a provider. [`BookResolver`](src/catalog/book.resolver.ts) is a singleton injecting
the `CatalogService`, the `PubSub` and `Lazy<CurrentUser>` (a singleton reads a request-scoped
provider through `Lazy`, or the build fails with `ZNIGHT003`).
[`ViewerResolver`](src/auth/viewer.resolver.ts) is request-scoped instead and injects `CurrentUser`
directly. Methods stay thin: the services ([`catalog.service.ts`](src/catalog/catalog.service.ts),
[`review.service.ts`](src/reviews/review.service.ts)) know nothing of GraphQL and throw domain
errors, which [`CatalogErrorMapper`](src/shared/catalog-error.mapper.ts) maps to `CONFLICT` and
`NOT_FOUND`. Anything else is masked as `Unexpected error.` and logged with the request id and the
field.

### Loaders

`Book.author`, `Book.reviews` and `Author.books` are field resolvers. Each loads through a loader
([`AuthorsById`](src/catalog/authors-by-id.loader.ts), [`ReviewsByBook`](src/reviews/reviews-by-book.loader.ts),
[`BooksByAuthor`](src/catalog/books-by-author.loader.ts)): a provider implementing
`BatchLoad<K, V>`, injected as `@Loader() authors: Loader<AuthorsById>`, the DataLoader of the
current execution. Twenty books, one `findMany`. The cache lives for one operation (or one
subscription event), so values never leak between requests.

### Access

[`access.ts`](src/auth/access.ts) declares three decorators of one **required** group, `access`:
`@Public()`, `@Authenticated()`, `@Roles([...])`. A root field (or a route) without a decision does
not build (`ZNIGHT023`). Two guards enforce them:

- [`AuthenticationGuard`](src/auth/authentication.guard.ts), an HTTP guard, runs on every request
  (`/graphql` included): an `x-api-key` header is verified once and fills the request-scoped
  [`CurrentUser`](src/auth/current-user.ts); a wrong key is a 401 at once. It decides nothing else.
- [`AccessGuard`](src/auth/access.guard.ts) implements both `CanActivate` (routes) and
  `GraphQLGuard` (fields), since `ResolverContext` is a `RouteMetaCarrier` like `HttpContext`. Its
  `static enforces` tells both plugins it enforces the group: a boot without it fails.

In [`plugins.ts`](src/plugins.ts), `HttpPlugin` gets `guards: [AuthenticationGuard, AccessGuard]`,
`GraphQLPlugin` gets `guards: [AccessGuard]` and `http: { meta: [Public.meta()] }`: the endpoint is
open, the decisions are taken per root field. A denied field fails alone (`UNAUTHENTICATED` or
`FORBIDDEN`, with its path); field resolvers without a decision of their own are covered by the
root field they descend from, so guards do not run once per book.

### Subscriptions

`bookAdded(genre)` and `reviewAdded(bookId)` are `async *` generators reading the injectable
`PubSub<CatalogEvents>` ([`catalog.events.ts`](src/catalog/catalog.events.ts)) and filtering what
they yield. They pass `ctx.signal` to `subscribe()`: it aborts when the client leaves, on shutdown
and after `subscriptions.maxDuration`, which ends the generator and frees the subscriber. The
default `MemoryPubSub` serves one process; with several instances, pass a shared implementation
(Redis, a broker) as the `pubsub` option.

On SIGTERM, HTTP drains the requests in flight and ends the event streams **without** the
`complete` event: GraphQL-over-SSE clients treat it as a lost connection and reconnect, to another
instance.

### Production defaults

With `NODE_ENV=production`, introspection is off and validation errors suggest no field names.
Unexpected errors are masked. Documents are limited (2 000 tokens, depth 12, 30 aliases, 50
directives) before validation runs, bodies to 100 KiB; batches are refused, `POST` accepts JSON
only (cross-site requests are always preflighted) and `GET` runs queries only.

## Tests

```sh
bun run test       # unit, GraphQL, HTTP and build checks: about a second
bun run test:e2e   # production build, then Node.js and Bun processes over real HTTP
```

`bunfig.toml` preloads `@znight/compiler/bun`, which regenerates the container and `schema.graphql`
before the tests. [`support/app.ts`](test/support/app.ts) boots the application with the
`plugins()` of `main.ts`, test API keys and silent logs.

| File                                                  | Shows                                                                                                                                                          |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`resolvers.test.ts`](test/resolvers.test.ts)         | `TestBed` unit tests of resolvers (auto-mocked services and `PubSub`), `fakeLoader`, a loader's `orderByKeys`, the error mapper                                |
| [`books.graphql.test.ts`](test/books.graphql.test.ts) | `executeOperation()` through the whole stack: variables, enums, schema defaults, pagination, the union, validation issues, `CONFLICT`, `NOT_FOUND`, the scalar |
| [`batching.test.ts`](test/batching.test.ts)           | `books { items { author { name } } }` calls `AuthorRepository.findMany` once; a fresh batch per operation                                                      |
| [`access.test.ts`](test/access.test.ts)               | the access matrix of every root field for anonymous, reader and editor callers, committed as a snapshot; a wrong key is a 401                                  |
| [`subscriptions.test.ts`](test/subscriptions.test.ts) | `subscribeOperation()`: events, genre and book filtering, `return()` closing the PubSub subscription, a shutdown ending the stream without `complete`          |
| [`http.test.ts`](test/http.test.ts)                   | GraphQL over HTTP: `GET` queries, `GET` mutations 405, form `POST` 415, statuses per media type, limits, introspection with `NODE_ENV=production`, GraphiQL    |
| [`schema.test.ts`](test/schema.test.ts)               | `plugin.printSchema()` equals the committed `schema.graphql`                                                                                                   |
| [`build-check.test.ts`](test/build-check.test.ts)     | `compile()` on a copy of the application: ZNIGHT060 and ZNIGHT064 with their locations, ZNIGHT023                                                              |
| [`guide.test.ts`](test/guide.test.ts)                 | the links of the GraphQL guide to this application                                                                                                             |
| [`e2e.test.ts`](test/e2e.test.ts)                     | `ZNIGHT_E2E=1`: `znight build`, the bundle on Node.js then Bun: a query, a mutation with an API key, a subscription receiving the added book, SIGTERM          |

`subscribeOperation()` resolves once the subscription is established: the plugin starts the
resolver's `async *` generator with the stream, so it has subscribed to the `PubSub` and the tests
publish right away, then read the event.

## In this repository

The example is a workspace of the Znight monorepo, so a few settings exist only to use the
framework from its sources; a project created with `znight new` does not need them:

- `tsconfig.json`: `customConditions: ["@znight/source"]` and `allowImportingTsExtensions` make `tsc`
  check against the packages' TypeScript sources;
- `vite.config.ts`: `ssr.external` keeps the linked `@znight/*` packages out of the bundle (packages
  installed from npm are external anyway);
- `test` scripts pass `--conditions=@znight/source` to `bun test`.

`bunfig.toml` sets `env = false` in any project: Bun would otherwise load `.env` files itself, with
its own precedence and expansion rules, before `ConfigPlugin` does.
