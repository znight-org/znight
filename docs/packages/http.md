---
description: "@znight/http - controllers, routing, parameter coercion, schema validation, file uploads and downloads, streaming, guards, interceptors and error handling on Node.js, Fastify, Express or Hono."
---

# @znight/http <Badge type="tip" text="available" />

HTTP controllers for Znight. Routes are analysed by the compiler (paths, parameters, types, schemas,
uploads, guards) and served by the adapter of your choice: the built-in `node:http` server, Fastify,
Express or Hono. Every adapter behaves the same, on Node.js 24+ and Bun 1.3+.

```sh
npm install @znight/core @znight/http zod
npm install fastify     # optional: or express, or hono (+ @hono/node-server on Node.js)
```

::: code-group

```ts [src/main.ts]
import { Application } from '@znight/core'
import { HttpPlugin } from '@znight/http'
import { __ZNIGHT_METADATA__ } from './.znight/container.generated.js'

const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins: [HttpPlugin.configure({ port: 3000, prefix: '/api' })], // built-in node:http adapter
})
await app.start() // SIGINT / SIGTERM: stop accepting connections, drain, close
```

```ts [with Fastify]
import { HttpPlugin } from '@znight/http'
import { fastifyAdapter } from '@znight/http/fastify'

HttpPlugin.configure({ adapter: fastifyAdapter({ options: { trustProxy: true } }), port: 3000 })
```

:::

The complete reference (every option, the compiler contract, how to write an adapter) is the
[package README](../../packages/http/README.md).

## Controllers and routes

```ts
import { Body, Controller, Delete, Get, HttpResponse, NotFoundException, Param, Post, Query } from '@znight/http'

@Controller('/users')
export class UserController {
  constructor(private readonly users: UserService) {}

  @Get()
  list(@Query('page') page = 1, @Query('tag') tags: string[] = []) {
    return this.users.list({ page, tags })
  }

  @Get('/:id')
  async get(@Param('id') id: number) {
    const user = await this.users.findById(id)
    if (user === undefined) throw new NotFoundException(`User ${id} not found`)
    return user
  }

  @Post()
  async create(@Body(CreateUser) input: CreateUser) {
    const user = await this.users.create(input)
    return HttpResponse.created(user, `/users/${user.id}`) // 201 + location
  }

  @Delete('/:id')
  remove(@Param('id') id: number) {
    return this.users.remove(id) // undefined → 204 No Content
  }
}
```

- `@Controller(path?)` or `@Controller({ path?, scope? })`: a provider (singleton by default) whose
  decorated methods are routes.
- Route decorators: `@Get`, `@Post`, `@Put`, `@Patch`, `@Delete`, `@Head`, `@Options`, `@All`.
  Method decorators: `@HttpCode(status)`, `@Header(name, value)`, `@BodyLimit(size)` (also on the
  class), `@UseGuard(...)`, `@UseInterceptor(...)`, `@Validate(schema)`.
- **Path grammar**: static segments, `:name` parameters and a trailing `*` wildcard. Anything else
  (regular expressions, optional segments) is [`ZNIGHT007`](/reference/error-codes#znight007), as are
  duplicate method + path pairs and `:params` without a matching `@Param()`. The most specific route
  wins (static > `:param` > `*`).
- `HEAD` is served for every `GET` route; unknown paths answer `404`, other methods `405` with
  `allow`, unmatched `OPTIONS` `204` (both `allow` headers list the same methods, `OPTIONS`
  included). A trailing-slash policy (`strict` by default, `ignore`, `redirect`, whose `location`
  always stays on the same origin) is applied the same way on every adapter.
- Routes match the **raw** request path: dot segments are not resolved (`/files/a/../b` gives
  `ctx.params['*'] = 'a/../b'`), so never build file paths from parameters without the `root`
  option of `HttpResponse.file()`. Exception: `Bun.serve()` gives the Hono adapter a normalised URL.
- Paths can be built from constants: ``@Controller(`${API_V1}/users`)`` is evaluated at build time.

## Parameters

| Decorator                    | Injects                                                       |
| ---------------------------- | ------------------------------------------------------------- |
| `@Param(name?, schema?)`     | A path parameter (or all of them without `name`)              |
| `@Query(name?, schema?)`     | A query parameter (or the whole query object)                 |
| `@Body(schema?)`             | The parsed request body                                       |
| `@Headers(name?)`            | A header (lower-cased name) or all headers                    |
| `@UploadedFile(field?, o?)`  | An uploaded `File` of a multipart body ([Files](#files))      |
| `@UploadedFiles(field?, o?)` | The uploaded files of a field (`File[]`)                      |
| `@Ctx()`                     | The adapter-neutral `HttpContext`                             |
| `@Req()` / `@Res()`          | The native adapter request / response (escape hatch, warning) |

**Coercion.** Path, query and header values are strings on the wire; Znight coerces them from the
**declared parameter type** in generated code: `string`, `number`, `boolean`, `bigint`, `Date`,
literal unions, enums, branded primitives and arrays of those (`T[]` also accepts a single value).
A `Date` is an ISO 8601 date (`2024-01-02`), a date-time **with** an offset
(`2024-01-02T10:00:00Z`, `+02:00`) or a millisecond timestamp: impossible dates and date-times
without offset (they would depend on the server time zone) are rejected. An invalid value is a
`400 Bad Request` naming the parameter. A type that cannot be coerced from a
string is a build error ([`ZNIGHT007`](/reference/error-codes#znight007)) for `@Param` / `@Headers`.

Parameters with a default value, `?` or `| undefined` may be absent (`undefined` is injected, so
default values apply).

## Validation

Pass any [Standard Schema](https://standardschema.dev) (Zod 3.24+/4, Valibot 1, ArkType 2, Effect
Schema...) to `@Body()`, `@Query()` or `@Param()`, or use `@Validate(schema)` on the method as sugar
for `@Body(schema)`:

```ts
import { z } from 'zod'

export const CreateUser = z.object({
  email: z.email(),
  name: z.string().min(2),
  role: z.enum(['admin', 'member']).default('member'),
})
export type CreateUser = z.output<typeof CreateUser>

@Post()
create(@Body(CreateUser) input: CreateUser) {
  // input.role is 'member' when omitted: handlers receive the schema output
}
```

- Handlers receive the schema **output** (defaults, transforms, stripped keys); async schemas work.
- Failures answer `400` with `details: [{ path, message }]` (a `ValidationException` carrying the raw
  issues, to map with an exception mapper).
- Schemas must be **exported** (the generated module imports them).
- A non-primitive `@Body()` or `@Query()` without a schema is reported as
  [`ZNIGHT017`](/reference/error-codes#znight017): a warning, or an error with the compiler's
  `strictValidation` option.

## Request bodies

Bodies are parsed by Znight (identically on every adapter), after the guards and before the
interceptors, for routes declaring `@Body()` or upload parameters; other routes read them lazily
with `ctx.parseBody()`, `ctx.rawBody()` (bytes, e.g. for webhook signatures) or `ctx.bodyStream()`.

| `content-type`                      | Body                                                              |
| ----------------------------------- | ----------------------------------------------------------------- |
| (empty body)                        | `undefined`                                                       |
| `application/json`, `*/*+json`      | parsed JSON (`400` when malformed)                                |
| `text/*`                            | string (charset honoured)                                         |
| `application/x-www-form-urlencoded` | record, repeated keys as arrays                                   |
| `multipart/form-data`               | record of the text fields; files in `ctx.files` ([Files](#files)) |
| anything else / none                | `Uint8Array`                                                      |

Bodies above the body limit answer `413` (plugin `bodyLimit`, 1 MiB by default, or
`@BodyLimit('10mb')` on a route or a controller); a `content-encoding` other than `identity` answers
`415`.

## Responses

| Handler returns                                 | Response                             |
| ----------------------------------------------- | ------------------------------------ |
| Object / array / number / boolean / `null`      | JSON                                 |
| `string`                                        | `text/plain; charset=utf-8`          |
| `Uint8Array` / `ArrayBuffer`                    | `application/octet-stream`           |
| `ReadableStream` / Node.js `Readable`           | streamed `application/octet-stream`  |
| `Blob` / `File`                                 | its bytes, with its type and size    |
| `HttpResponse.file()` / `HttpResponse.stream()` | a file or a stream ([Files](#files)) |
| `HttpResponse`                                  | its body, status and headers         |
| Web `Response`                                  | sent as is                           |
| `undefined`                                     | empty body, `204` (`201` for `POST`) |

Status precedence: `@HttpCode(status)` > `HttpResponse.status` > default (`201` for `POST`, `204`
without body, `200` otherwise). Headers: content type < `@Header` < `ctx.setHeader()` <
`HttpResponse` headers.

## Files

### Uploads

```ts
import { Body, Controller, Post, UploadedFile, UploadedFiles } from '@znight/http'
import { z } from 'zod'

export const AvatarForm = z.object({ title: z.string().min(1) })

@Controller('/profile')
export class ProfileController {
  @Post('/avatar')
  avatar(
    @UploadedFile('avatar', { maxSize: '2mb', mimeTypes: ['image/png', 'image/jpeg'] }) avatar: File,
    @Body(AvatarForm) form: z.output<typeof AvatarForm>, // the text fields of the form
  ) {
    return { size: avatar.size, type: avatar.type, title: form.title }
  }

  @Post('/documents')
  add(
    @UploadedFiles('documents', { maxFiles: 5, maxSize: '20mb' }) documents: File[],
    @UploadedFile('cover') cover?: File, // optional: undefined when absent
  ) {}
}
```

Uploaded files are standard `File` objects (`name`, `type`, `size`, `arrayBuffer()`, `text()`,
`stream()`), held in memory. `@UploadedFile()` / `@UploadedFiles()` without field take the files of
any field; `@Body(schema?)` receives the text fields (`Record<string, string | string[]>`).

| Option      | Default                                  | Description                                                  |
| ----------- | ---------------------------------------- | ------------------------------------------------------------ |
| `required`  | `true`, unless the parameter is optional | `400` when no file is sent                                   |
| `maxSize`   | `uploads.maxFileSize` (10 MiB)           | Maximum size of each file (`5_000_000`, `'5mb'`, `Infinity`) |
| `maxFiles`  | `uploads.maxFiles` (10)                  | `@UploadedFiles`: maximum number of files                    |
| `mimeTypes` | any                                      | Accepted types: `'image/png'`, `'image/*'`, `'*/*'`          |

Upload routes parse `multipart/form-data` bodies **as they arrive**, with Znight's own RFC 7578
parser (not `Request.formData()`, which buffers everything and differs between runtimes), and reject
an invalid upload as soon as the offending part shows up:

| Status | When                                                                                                                              |
| ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | missing required file, text value instead of a file, second file for `@UploadedFile`, file in an undeclared field, malformed body |
| `413`  | file above `maxSize`, more than `maxFiles` files, too many parts, field too large, body above the limit                           |
| `415`  | refused media type, non-empty body that is not `multipart/form-data`                                                              |

Plugin-wide limits: `HttpPlugin.configure({ uploads: { maxFileSize, maxFiles, maxParts, maxFieldSize } })`
(defaults: 10 MiB, 10, 1000, 1 MiB). The body limit of an upload route defaults to the sum of what
its upload parameters accept plus `bodyLimit`; `@BodyLimit(size)` caps it.

### Downloads

```ts
@Get('/reports/*')
download(@Param('*') name: string) {
  return HttpResponse.file(name, { root: REPORTS_DIR }) // '../../etc/passwd' → 404
}

@Get('/invoices/:id')
async invoice(@Param('id') id: string) {
  return HttpResponse.file(await this.invoices.pathOf(id), { filename: `Facture ${id}.pdf` }) // attachment
}
```

`HttpResponse.file(path | URL | Blob, { root?, dotfiles?, filename?, disposition?, contentType? })` streams the
file with `Content-Type` (from the extension), `Content-Length`, `Last-Modified`, `ETag` and
`Accept-Ranges`, and handles conditional requests (`If-None-Match` / `If-Modified-Since` → `304`,
`If-Match` / `If-Unmodified-Since` → `412`) and single byte ranges (`206`, `416` when unsatisfiable).
`Content-Disposition` follows RFC 6266 with a UTF-8 `filename*` for non-ASCII names. Missing files
and paths leaving `root` (`..`, absolute paths, symbolic links) or naming dotfiles (`.env`, `.git/`)
answer `404`.

### Streaming responses

```ts
@Get('/export.csv')
export() {
  async function* lines(users: UserService) {
    yield 'id,email\n'
    for await (const user of users.iterate()) yield `${user.id},${user.email}\n`
  }
  return HttpResponse.stream(lines(this.users), { filename: 'users.csv' })
}
```

`HttpResponse.stream()` accepts a Web `ReadableStream`, a Node.js `Readable` or an async iterable of
`Uint8Array` / `string` chunks. The source is read as fast as the client receives the data
(backpressure), cancelled when the client disconnects, and runs in the request scope:
**request-scoped instances are disposed only after the stream has been sent** (or cancelled), and
the graceful shutdown waits for streamed responses.

### Large files

::: tip Recommended
For large files, let clients upload **directly to object storage** with presigned URLs (S3, GCS,
R2...): the API authorises the upload and returns the URL, your servers never carry the bytes.
:::

To receive a large file through the API, send it as the raw request body and stream it with
`ctx.bodyStream()` (nothing is buffered; backpressure applies; the route limit still applies):

```ts
@Put('/files/:id')
@BodyLimit('5gb')
async store(@Param('id', FileId) id: string, @Ctx() ctx: HttpContext) {
  await pipeline(Readable.fromWeb(ctx.bodyStream()), createWriteStream(join(UPLOADS_DIR, id)))
}
```

### Security

::: warning Never trust what the client sends
- `File.name` is chosen by the client: never use it as a path. Store files under generated
  identifiers and keep the name as metadata.
- `File.type` and `mimeTypes` rely on the type the client declares: check the content (magic
  numbers) when it matters.
- Always pass `root` to `HttpResponse.file()` when the path comes from the request.
- Store uploads outside of the web root, and serve user content as an `attachment` (or from another
  domain) with `X-Content-Type-Options: nosniff`: an uploaded HTML or SVG file served inline runs
  scripts in your origin.
- Keep limits tight (`maxSize`, `maxFiles`, `@BodyLimit`, plugin `uploads`): uploaded files live in
  memory.
  :::

## Errors

Throw `HttpException(status, message?, details?)` (or a subclass: `NotFoundException`,
`ConflictException`...) for expected failures:

```ts
import { HttpException, NotFoundException } from '@znight/http'

if (user === undefined) throw new NotFoundException(`User ${id} not found`)
throw new HttpException(409, 'Email already used', { field: 'email' })
```

```json
{ "statusCode": 409, "error": "Conflict", "message": "Email already used", "details": { "field": "email" } }
```

Any other error becomes `{ "statusCode": 500, "error": "Internal Server Error" }`: the message is
only exposed with `exposeErrors: true`, and the error is reported to hooks and the logger. Map your
own error types to responses with the `exceptionMappers` option.

## Guards

A guard is a provider deciding whether a request may proceed. Apply it with `@UseGuard()` on a
controller or a route, or globally with the `guards` option:

```ts
import { type CanActivate, type HttpContext, UseGuard } from '@znight/http'

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly config: SecurityConfig) {}

  canActivate(ctx: HttpContext): boolean {
    return ctx.header('x-api-key') === this.config.apiKey // anything but true → 403
  }
}

@Controller('/admin')
@UseGuard(ApiKeyGuard)
export class AdminController {}
```

Order: global guards → controller guards → route guards. Guards are injected like any provider, and
the [scope rules](/guide/scopes#rules-between-scopes) apply to them.

## Route metadata

Create metadata decorators with `createRouteDecorator`; values land in the generated route definition
(`route.meta[key]`), readable by guards and interceptors without reflection:

```ts
import { createRouteDecorator } from '@znight/http'

export const Roles = createRouteDecorator<readonly string[]>('roles')
export const Public = createRouteDecorator('public') // flag: @Public()

@Get('/stats')
@Roles(['admin'])
stats() {}

// in a guard
const roles = Roles.get(ctx) ?? []
```

## Interceptors

`@UseInterceptor()` wraps route execution (global → controller → route, the first one being the
outermost), seeing the context and the result: response mapping, caching, timing. For
business-level interception of any provider method, use [`@Intercept()`](/guide/aop).

## Request context

Each request runs in its own [request scope](/guide/scopes#request-scopes) seeded with request-scoped
externals:

- `HttpContext`: the adapter-neutral request/response context (`params`, `query`, `headers`, `body`,
  `files`, `route`, `state`, `setHeader()`, `parseBody()`, `rawBody()`, `bodyStream()`...);
- `RequestId`: the request identifier (the incoming `x-request-id` when valid, else a UUID).

Inject them in request-scoped providers, or through `Lazy<HttpContext>` in singletons. Request-scoped
instances are disposed once the response has been sent (streams and files included, so a
request-scoped provider may own a temporary file it deletes when disposed).

## The request pipeline

```txt
container.runInScope({ HttpContext, RequestId })
└─ hooks.run('http:request', event)
   ├─ global guards → controller guards → route guards
   ├─ body parsing (routes with @Body / uploads)
   ├─ global → controller → route interceptors
   │  └─ invoke: extract → coerce → validate → handler
   ├─ serialise the result (files: preconditions, ranges)
   └─ map exceptions to a response (event.status / event.error are set)
└─ the scope closes once the response body has been sent
```

Observers such as `@znight/observability` wrap `http:request` to log, measure and trace every
request.

## Plugin options

`HttpPlugin.configure(options)`, or `HttpPlugin.configure(container => options)`:

| Option             | Default               | Description                                                            |
| ------------------ | --------------------- | ---------------------------------------------------------------------- |
| `adapter`          | `nodeAdapter()`       | `fastifyAdapter()`, `expressAdapter()`, `honoAdapter()`...             |
| `port`, `host`     | `3000`, `0.0.0.0`     | Listening address (`port: 0`: a free port)                             |
| `prefix`           | —                     | Path prefix for every route (`/api`)                                   |
| `guards`           | `[]`                  | Global guards (classes or instances)                                   |
| `interceptors`     | `[]`                  | Global interceptors                                                    |
| `exceptionMappers` | `[]`                  | Map error types to responses                                           |
| `trailingSlash`    | `'strict'`            | `'strict'`, `'ignore'` or `'redirect'`                                 |
| `exposeErrors`     | `false`               | Include messages of unexpected errors in `500` responses               |
| `bodyLimit`        | 1 MiB                 | Maximum request body size (bytes or `'10mb'`)                          |
| `uploads`          | see [Files](#uploads) | `{ maxFileSize, maxFiles, maxParts, maxFieldSize }`                    |
| `requestIdHeader`  | `x-request-id`        | Header read and echoed (`false`: always generate)                      |
| `drainTimeoutMs`   | `4000`                | Maximum wait for in-flight requests on shutdown (`Infinity`: no limit) |

## Adapters

| Adapter                                     | Peer dependencies           | Notes                                                                                 |
| ------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------- |
| `nodeAdapter()` (`@znight/http`)            | none                        | Built-in `node:http` server (also works on Bun)                                       |
| `fastifyAdapter()` (`@znight/http/fastify`) | `fastify`                   | `exposeHeadRoutes` disabled: Znight serves HEAD                                       |
| `expressAdapter()` (`@znight/http/express`) | `express`                   | Your middleware runs before the Znight routes                                         |
| `honoAdapter()` (`@znight/http/hono`)       | `hono`, `@hono/node-server` | `Bun.serve()` on Bun (`serveOptions`, no 128 MiB cap), `@hono/node-server` on Node.js |

Every adapter implements `inject(request)`: requests handled in memory, without a socket, which is
what [`TestApp`](/guide/testing#testapp-end-to-end-tests) uses. `inject()` accepts `FormData` bodies
(uploads) and returns the raw body in `bytes` (downloads); `set-cookie` is always an array in its
`headers`. With the `node` and `express` adapters it needs `light-my-request`.

A plugin instance serves one application at a time (a `HttpPlugin.configure()` shared by the tests
of a file works; two running applications sharing it fail with
[`ZNIGHT004`](/reference/error-codes#znight004)), and an adapter instance serves a single
application: create adapters per application with the function form,
`HttpPlugin.configure(() => ({ adapter: fastifyAdapter() }))`
([`ZNIGHT021`](/reference/error-codes#znight021) otherwise).
