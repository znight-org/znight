# Bookshelf REST API

A production-shaped REST API built with [Znight](../../README.md): a shelf of books with a cover
image each, served by **Fastify**, stored in **PostgreSQL** through **Drizzle ORM**, configured from
the environment, protected by API keys and observable out of the box.

It is the reference example of a Znight HTTP service, and of the **recommended data layer**: Znight
does not ship an ORM and leaves the choice to you; for SQL databases we recommend Drizzle, wired
through a `@Factory` exactly as shown here. The database is [PGlite](https://pglite.dev) (PostgreSQL
compiled to WebAssembly), so the example runs without any server, on Node.js and on Bun, while the
code is the one you would write for a real PostgreSQL.

Every dependency below is resolved **at build time**: the compiler reads the decorators and the
constructor types, validates the graph and generates the container (`src/.znight/`). There is no
`reflect-metadata` and no module to declare.

## What it shows

| Feature                                                                                               | Where                                                                                                                            |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| CRUD controller, `@Param` / `@Query` coercion, Zod body schemas                                       | [`books/book.controller.ts`](src/books/book.controller.ts), [`book.schemas.ts`](src/books/book.schemas.ts)                       |
| Global API-key guard, `@Public()` and `@Roles()` built with `createRouteDecorator`                    | [`auth/auth.guard.ts`](src/auth/auth.guard.ts), [`auth/auth.decorators.ts`](src/auth/auth.decorators.ts)                         |
| Request-scoped provider filled by the guard, read through `Lazy<T>`                                   | [`auth/request-user.ts`](src/auth/request-user.ts), [`auth/me.controller.ts`](src/auth/me.controller.ts)                         |
| HTTP interceptor                                                                                      | [`shared/server-timing.interceptor.ts`](src/shared/server-timing.interceptor.ts)                                                 |
| Domain errors mapped to HTTP (`BookNotFoundError` → 404, duplicate → 409)                             | [`books/book.ts`](src/books/book.ts), [`shared/domain-error.mapper.ts`](src/shared/domain-error.mapper.ts)                       |
| File upload with limits (`@UploadedFile`) and download (`HttpResponse.file`)                          | `PUT` / `GET /books/:id/cover` in the controller                                                                                 |
| Drizzle + PGlite through a `@Factory`: async init, migrations, dispose                                | [`db/database.factory.ts`](src/db/database.factory.ts), [`drizzle/`](drizzle)                                                    |
| Repository behind an interface, injected by interface                                                 | [`books/book.repository.ts`](src/books/book.repository.ts), [`drizzle-book.repository.ts`](src/books/drizzle-book.repository.ts) |
| `@Config` classes, `@Env`, `@Secret`, `.env` files                                                    | [`config/`](src/config), [`.env.development`](.env.development)                                                                  |
| JSON logs with request ids, Prometheus `/metrics`, `@Logged`, `@Metric`                               | [`main.ts`](src/main.ts), [`books/book.service.ts`](src/books/book.service.ts)                                                   |
| Lifecycle hooks (`onReady`, `onStop`) and graceful shutdown                                           | [`app.lifecycle.ts`](src/app.lifecycle.ts), [`main.ts`](src/main.ts)                                                             |
| Unit tests (`TestBed`), repository tests on a real database, HTTP tests (`TestApp`), end-to-end tests | [`test/`](test)                                                                                                                  |

## Run it

Requirements: Node.js 24+ or Bun 1.3+. In this repository, install and build the framework once,
from the repository root: `bun install && bun run build` (the CLI and the production build use the
packages' `dist`).

```sh
bun run dev          # or: npm run dev
```

`dev` builds the application in watch mode and restarts it on every change, with `NODE_ENV=development`:
[`.env.development`](.env.development) provides development API keys, debug logs and a few sample
books. The API listens on <http://localhost:3000>, the metrics on <http://localhost:9464/metrics>.

| Script      | bun                 | npm / Node.js       | Does                                                                     |
| ----------- | ------------------- | ------------------- | ------------------------------------------------------------------------ |
| `dev`       | `bun run dev`       | `npm run dev`       | `znight dev`: build in watch mode, restart on change                     |
| `build`     | `bun run build`     | `npm run build`     | `znight build`: production bundle `dist/main.js` (fails on any DI error) |
| `start`     | `bun run start`     | `npm run start`     | `znight start`: runs `dist/main.js` with `NODE_ENV=production`           |
| `test`      | `bun run test`      | —                   | unit, repository and HTTP tests (`bun test`)                             |
| `test:e2e`  | `bun run test:e2e`  | —                   | builds, then runs the bundle on Node.js **and** Bun over real HTTP       |
| `typecheck` | `bun run typecheck` | `npm run typecheck` | generates the container, then `tsc --noEmit`                             |
| `generate`  | `bun run generate`  | `npm run generate`  | writes `src/.znight/container.generated.ts` (`--check` in CI)            |

The production bundle runs on both runtimes, configured by environment variables only:

```sh
bun run build
API_KEY=change-me node --enable-source-maps dist/main.js   # Node.js
API_KEY=change-me bun dist/main.js                          # Bun
API_KEY=change-me bun run start                             # znight start (same PID, signals forwarded)
```

Without `API_KEY` the application refuses to start, listing every configuration problem at once:

```
ConfigValidationError: ZNIGHT006: Invalid configuration: 1 problem
  - AuthConfig.apiKey: missing required value; set API_KEY (or key "auth.apiKey")
```

### Configuration

Read by [`ConfigPlugin`](../../packages/config/README.md) from `.env` files (`.env`, `.env.local`,
`.env.<NODE_ENV>`, `.env.<NODE_ENV>.local`), then from the environment (which wins), and validated
at boot. Types drive the coercion: `PORT=abc` or `LOG_LEVEL=loud` fail the boot.

| Variable                     | Default            | Description                                                               |
| ---------------------------- | ------------------ | ------------------------------------------------------------------------- |
| `API_KEY`                    | (required)         | Administrator key: read and write (`@Secret`: never printed)              |
| `READONLY_API_KEY`           | —                  | Read-only key                                                             |
| `PORT` / `HOST`              | `3000` / `0.0.0.0` | API address (`PORT=0`: a free port, logged when ready)                    |
| `METRICS_PORT`               | `9464`             | Prometheus endpoint, on its own server (not exposed with the API)         |
| `LOG_LEVEL`                  | `info`             | `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`              |
| `EXPOSE_ERRORS`              | `false`            | Send the message of unexpected errors in 500 responses (development)      |
| `DATABASE_DATA_DIR`          | `memory://`        | PGlite data: in memory, or a directory persisted on disk (`./data/shelf`) |
| `DATABASE_MIGRATIONS_FOLDER` | `drizzle`          | SQL migrations applied at startup, relative to the working directory      |
| `DATABASE_SEED`              | `false`            | Insert sample books into an empty database                                |

## Try it

With `bun run dev` running (development keys: `dev-admin-key`, `dev-reader-key`):

```sh
API=http://localhost:3000
ADMIN='x-api-key: dev-admin-key'
READER='x-api-key: dev-reader-key'

curl $API/health                                     # {"status":"ok","uptime":3}       (@Public)
curl $API/books                                      # 401: missing API key
curl -H "$READER" $API/me                            # {"name":"reader","roles":["reader"]}

# list: coerced query parameters (repeated `tag`, `sort` is one of title|author|year|newest)
curl -H "$READER" "$API/books?tag=classic&tag=fantasy&sort=year&limit=10"
curl -H "$READER" "$API/books?limit=lots"            # 400: Invalid query "limit": expected a number...
curl -H "$READER" "$API/books?q=dune"

# create: the body is validated (and normalised) by the Zod schema
curl -i -H "$ADMIN" -H 'content-type: application/json' -X POST $API/books \
  -d '{"isbn":"978-0-13-468599-1","title":"The Pragmatic Programmer","author":"Andrew Hunt, David Thomas","publishedYear":2019,"tags":["Programming"]}'
# 201, location: /books/4, {"id":4,"isbn":"9780134685991",...,"tags":["programming"],"createdBy":"admin",...}
# again: 409 {"statusCode":409,"error":"Conflict","message":"A book with ISBN 9780134685991 is already on the shelf",...}

curl -H "$ADMIN" -H 'content-type: application/json' -X POST $API/books -d '{"isbn":"42"}'
# 400 {"message":"Invalid body","details":[{"path":"isbn",...},{"path":"title",...},{"path":"author",...}]}

curl -H "$READER" -X DELETE $API/books/4             # 403: @Roles(['admin'])
curl -H "$ADMIN" -H 'content-type: application/json' -X PATCH $API/books/4 -d '{"publishedYear":1999}'
curl -H "$ADMIN" $API/books/999                      # 404: BookNotFoundError, mapped by DomainErrorMapper

# cover: multipart upload (≤ 2 MiB, PNG/JPEG/WebP), public download with caching validators
curl -H "$ADMIN" -X PUT -F cover=@cover.png $API/books/4/cover
curl -i $API/books/4/cover                           # 200 image/png, etag, last-modified
curl -i -H 'if-none-match: "<etag>"' $API/books/4/cover   # 304
curl -H "$ADMIN" -X DELETE $API/books/4              # 204, the cover goes with the book

curl -s localhost:9464/metrics | grep -E 'http_server_requests_total|bookshelf_books_added_total'
```

| Method   | Path               | Access   | Response                                                                                 |
| -------- | ------------------ | -------- | ---------------------------------------------------------------------------------------- |
| `GET`    | `/health`          | public   | `200 {status, uptime}`, `503` when the database is down                                  |
| `GET`    | `/me`              | any key  | the caller (`RequestUser`)                                                               |
| `GET`    | `/books`           | `reader` | `{items, total, limit, offset}`; `q`, `author`, `tag`, `sort`, `limit` (1-100), `offset` |
| `GET`    | `/books/:id`       | `reader` | a book, `404`                                                                            |
| `POST`   | `/books`           | `admin`  | `201` + `location`, `400`, `409`                                                         |
| `PATCH`  | `/books/:id`       | `admin`  | the updated book, `400`, `404`, `409`                                                    |
| `DELETE` | `/books/:id`       | `admin`  | `204`, `404`                                                                             |
| `PUT`    | `/books/:id/cover` | `admin`  | multipart field `cover`: the book, `400`, `404`, `413`, `415`                            |
| `GET`    | `/books/:id/cover` | public   | the image (`etag`, ranges), `304`, `404`                                                 |

Every response carries an `x-request-id` (the client's, when it sends a valid one), also written in
every log line of the request.

## How it is built

```txt
src/
├─ main.ts                          # Application.create(): plugins, global guard, mapper, shutdown
├─ app.lifecycle.ts                 # onReady / onStop hooks
├─ config/                          # @Config classes: server, database, auth (@Secret)
├─ db/
│  ├─ schema.ts                     # Drizzle tables
│  ├─ database.ts                   # interface Database (the injected type)
│  ├─ database.factory.ts           # @Factory: PGlite client + migrated Drizzle database
│  └─ seed.ts                       # sample books (DATABASE_SEED)
├─ auth/                            # AuthGuard, @Public/@Roles, RequestUser, GET /me
├─ books/
│  ├─ book.ts                       # domain types and errors
│  ├─ book.schemas.ts               # Zod schemas of the request bodies
│  ├─ book.repository.ts            # interface BookRepository
│  ├─ drizzle-book.repository.ts    # @Injectable implements BookRepository
│  ├─ book.service.ts               # use cases (@Logged, @Metric)
│  ├─ book.controller.ts            # /books routes
│  └─ image-type.ts                 # cover content sniffing
├─ health/health.controller.ts      # GET /health
├─ shared/                          # ServerTimingInterceptor, DomainErrorMapper
└─ .znight/                         # generated container (git-ignored)
drizzle/                            # SQL migrations (drizzle-kit layout)
test/                               # bun test: unit, repository, HTTP, e2e
```

Providers are found by their decorators, never by file name; folders group code by feature.

### Dependency injection, resolved by the compiler

```ts
@Injectable()
export class BookService {
  constructor(
    private readonly books: BookRepository, // an interface
    private readonly logger: Logger, // provided at runtime by ObservabilityPlugin
  ) {}
}
```

From these types alone, the compiler generates (excerpt of `src/.znight/container.generated.ts`):

```ts
['src/books/book.service.ts#BookService']: {
  scope: 'singleton',
  class: BookService,
  deps: [
    'src/books/drizzle-book.repository.ts#DrizzleBookRepository', // the only class implementing BookRepository
    '@znight/observability#Logger',
    '@znight/observability#LoggedInterceptor', // @Logged
    '@znight/observability#MetricInterceptor', // @Metric
  ],
  factory: d => new BookService(d[0], d[1]),
  interceptors: { ['add']: { async: true, chain: [{ dep: 2, options: { ... } }, { dep: 3, options: { ... } }] } },
},
```

A missing implementation, a second `BookRepository` implementation, a cycle or a singleton depending on
`RequestUser` would fail `znight build` (and `bun test`) with a located diagnostic. Constructor types
can be imported with `import type`: nothing is reflected at runtime, the generated module imports the
classes itself.

### The data layer: Drizzle through a `@Factory`

Third-party objects are provided by a `@Factory` ([`database.factory.ts`](src/db/database.factory.ts)):
each `@Provides` method provides its return type and receives its parameters by injection.

```ts
@Factory()
export class DatabaseFactory {
  @Provides({ dispose: 'close' }) // client.close() on shutdown, after its dependents stopped
  async client(config: DatabaseConfig, logger: Logger): Promise<PGlite> {
    return await PGlite.create(config.dataDir) // async: awaited at boot
  }

  @Provides()
  async database(client: PGlite, config: DatabaseConfig, logger: Logger): Promise<Database> {
    const db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder: config.migrationsFolder }) // before anyone can query
    return db
  }
}
```

- **Async init**: the container awaits async factories during `Application.create()`, in dependency
  order (independent ones concurrently). Nothing can use the database before it is migrated.
- **Migrations**: SQL files in [`drizzle/`](drizzle), in the folder layout of
  [drizzle-kit](https://orm.drizzle.team/docs/kit-overview), applied by Drizzle's migrator and
  recorded in `drizzle.__drizzle_migrations` (a restart applies nothing). The initial migration was
  written by hand to keep the example's dependencies small; in your project, add `drizzle-kit` and
  generate them from [`schema.ts`](src/db/schema.ts) (`drizzle-kit generate`).
- **Dispose**: `@Provides({ dispose: 'close' })` closes the client on shutdown, also when the boot
  fails half-way.
- **A named type**: Drizzle's type is generic (`PgliteDatabase<typeof schema>`) and the compiler
  injects by type, so [`database.ts`](src/db/database.ts) gives it a name, `interface Database`.
  Repositories inject `Database`.
- **Repository interface**: services depend on [`BookRepository`](src/books/book.repository.ts);
  `DrizzleBookRepository` implements it and translates database errors into domain errors (unique
  violation → `DuplicateIsbnError`, foreign key violation → "no such book").
- **Real PostgreSQL**: replace PGlite with `drizzle-orm/node-postgres` and a `pg.Pool` (or
  `drizzle-orm/bun-sql`) in the factory — `@Provides({ dispose: 'end' }) async pool(...): Promise<Pool>`.
  Repositories, services and tests do not change.

### Authentication and request scope

[`AuthGuard`](src/auth/auth.guard.ts) is registered **globally** (`HttpPlugin.configure({ guards })`)
and runs before every route. It reads route metadata declared with
[`createRouteDecorator`](src/auth/auth.decorators.ts): `@Public()` skips authentication,
`@Roles([...])` restricts a controller or a route (route values win). It compares SHA-256 digests of
the keys in constant time, throws `401` (with a `www-authenticate` header when the key is missing)
or returns `false` (`403`).

Once the key is verified, the guard records the caller in [`RequestUser`](src/auth/request-user.ts),
a `scope: 'request'` provider: one instance per request, disposed with it. Singletons (the guard,
the controllers) inject `Lazy<RequestUser>` and call `get()` while handling a request; injecting
`RequestUser` directly into a singleton is a build error (ZNIGHT003), since the singleton would keep
the first request's user. `POST /books` records `createdBy` from it.

### Errors

Services throw domain errors ([`book.ts`](src/books/book.ts)) and know nothing about HTTP;
[`DomainErrorMapper`](src/shared/domain-error.mapper.ts) maps them (`404`, `409`, `415`). Validation
failures are `400` with one entry per issue; unexpected errors are `500` without their message
(unless `EXPOSE_ERRORS=true`) and are logged with the request id, route and handler.

### Files

`PUT /books/:id/cover` declares `@UploadedFile('cover', { maxSize: '2mb', mimeTypes: COVER_TYPES })`:
the multipart body is parsed as it arrives and refused as soon as a part breaks a limit (`413`,
`415`). The declared type is not trusted: the service checks the image signature before storing
anything. Covers are stored in their own table (a `bytea`), so listing books never reads image
bytes. `GET /books/:id/cover` returns `HttpResponse.file(file, { disposition: 'inline' })`, which
handles `etag`, `last-modified`, `if-none-match` (`304`) and `range` (`206`); `nosniff` and a cache
header are added. For large files, upload to object storage instead (see
[Large files](../../packages/http/README.md#large-files)).

### Observability

`ObservabilityPlugin` comes first in `main.ts`, so its hooks wrap everything:

- one JSON log line per request (`request completed`, warnings for 4xx, errors for 5xx) with its
  `requestId`; every log written while handling the request carries it too;
- `@Logged` on `BookService.add` logs each call with its duration and arguments, `@Metric` counts
  them (`bookshelf_books_added_total`);
- RED metrics (`http_server_requests_total`, `http_server_request_duration_seconds`...) labelled by
  route pattern, plus process metrics, on a separate `/metrics` server;
- traces with any OpenTelemetry SDK (none is registered here).

### Lifecycle and graceful shutdown

[`AppLifecycle`](src/app.lifecycle.ts) logs `Bookshelf API ready` (with the actual URLs) once
everything listens, and `Bookshelf API stopping` on shutdown. On `SIGTERM` / `SIGINT`: the HTTP
server stops accepting connections and drains in-flight requests, providers stop, the database is
closed, logs are flushed, and the process exits with code `0` (`1` if a step failed). Timeouts are
set in `main.ts` (`shutdown: { timeoutMs, hookTimeoutMs }`): keep them below your platform's grace
period.

## Tests

```sh
bun run test       # unit, repository and HTTP tests: a few seconds
bun run test:e2e   # production build, then Node.js and Bun processes: a few seconds more
```

`bunfig.toml` preloads `@znight/compiler/bun`, which regenerates the container before the tests.

| File                                                                      | Shows                                                                                                                                               |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`book.service.test.ts`](test/book.service.test.ts)                       | `TestBed`: the real service, its interface dependency auto-mocked                                                                                   |
| [`auth.guard.test.ts`](test/auth.guard.test.ts)                           | `TestBed` with `@Config` values; `Lazy<RequestUser>` mocked                                                                                         |
| [`drizzle-book.repository.test.ts`](test/drizzle-book.repository.test.ts) | the repository against a fresh, migrated in-memory PostgreSQL per test                                                                              |
| [`books.http.test.ts`](test/books.http.test.ts)                           | `TestApp`: the whole application in memory (`app.inject()`), uploads and downloads included                                                         |
| [`e2e.test.ts`](test/e2e.test.ts)                                         | `ZNIGHT_E2E=1`: `znight build`, the bundle on Node.js then on Bun (same data directory), real HTTP, SIGTERM during an upload (drained, exit code 0) |

## In this repository

The example is a workspace of the Znight monorepo, so a few settings exist only to use the
framework from its sources; a project created with `znight new` does not need them:

- `tsconfig.json`: `customConditions: ["@znight/source"]` and `allowImportingTsExtensions` make `tsc`
  check against the packages' TypeScript sources;
- `vite.config.ts`: `ssr.external` keeps the linked `@znight/*` packages out of the bundle (packages
  installed from npm are external anyway);
- `test` scripts pass `--conditions=@znight/source` to `bun test`;
- the `dev` script sets `NODE_ENV=development` explicitly: `znight dev` should do it, but currently
  starts the application with the `NODE_ENV=production` set by Vite during the build.
