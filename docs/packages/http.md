---
description: "@znight/http - controllers, routing, parameter coercion, schema validation, file uploads and downloads, streaming, cookies, Server-Sent Events, guards, access decisions, CORS and error handling on Node.js, Fastify, Express or Hono."
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
| `@Cookie(name?, schema?)`    | A request cookie (or all of them), coerced like a header      |
| `@SignedCookie(name, s?)`    | The verified value of a [signed cookie](#cookies)             |
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
  domain): an uploaded HTML or SVG file served inline runs scripts in your origin. The default
  [security headers](#security-headers) (`nosniff` and a `default-src 'none'` CSP) are a second line
  of defence: keep them on.
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
the [scope rules](/guide/scopes#rules-between-scopes) apply to them. A guard that enforces
[route decisions](#route-metadata-and-decisions) declares them in a static `enforces` array, checked
when the plugin boots.

## Route metadata and decisions

Create metadata decorators with `createRouteDecorator`; values land in the generated route definition
(`route.meta[key]`), readable by guards and interceptors without reflection:

```ts
import { createRouteDecorator } from '@znight/http'

export const Public = createRouteDecorator('public', { group: 'access', required: true }) // flag: @Public()
export const Roles = createRouteDecorator<readonly string[]>('roles', { group: 'access', required: true })

@Controller('/stats')
@Roles(['analyst']) // default decision of the controller's routes
export class StatsController {
  @Get('/summary')
  @Roles(['admin']) // the nearest decision wins
  summary() {}
}

// in a guard
const roles = Roles.get(ctx) // the effective value: ['admin'] on /stats/summary
```

- Decorators sharing a `group` are **alternatives** for one decision: a route (or controller) takes
  one of them ([`ZNIGHT005`](/reference/error-codes#znight005) otherwise), and the route's decision
  replaces the controller's. Without `group`, each decorator is its own group.
- With `required: true`, every route must carry a decision of the group, its own or its
  controller's: a route without one fails the build
  ([`ZNIGHT023`](/reference/error-codes#znight023)).
- A guard lists the decorators it enforces (`static enforces = [Public, Roles]`): at boot, every
  route deciding a required group, or a group that a guard class of the application enforces (even
  a guard registered in no chain, so a forgotten `RateLimitGuard` is caught), must have such a
  guard in its chain, otherwise the application does not start (`ZNIGHT023`, or one warning per
  group with `enforcement: 'warn'`).
- Without `group`, any non-empty key is valid (`'auth:public'`); an explicit `group` is a name of
  letters, digits, `_`, `.` and `-` starting with a letter.
- `HttpPlugin.routes` lists the effective `meta` and the guard chain of every route: snapshot it to
  review access changes.

The [Security guide](/guide/security) builds authentication and authorization on these rules.

## Interceptors

`@UseInterceptor()` wraps route execution (global → controller → route, the first one being the
outermost), seeing the context and the result: response mapping, caching, timing. For
business-level interception of any provider method, use [`@Intercept()`](/guide/aop).

## CORS

```ts
HttpPlugin.configure({
  cors: {
    origin: ['https://app.example.com', /^https:\/\/[a-z0-9-]+\.preview\.example\.com$/],
    credentials: true,
  },
})
```

CORS is handled by the plugin, the same way on every adapter (the built-in node server included):

- **Preflights** are answered inside the `http:request` hook, **before** routing and guards, even
  when an `@Options` or `@All` route matches: `204` with the CORS headers, `403` for a denied origin,
  `404` for a path without route. A preflight never gets the `401` of an authentication guard.
- **Other replies to an allowed origin** (errors, `404`, `405` and redirects included) get
  `access-control-allow-origin`, `access-control-allow-credentials` and
  `access-control-expose-headers` (the request id header by default); `vary: origin` is merged into
  every reply. With `origin: '*'` (or `'*'` in a list), every reply gets
  `access-control-allow-origin: *`, with or without an `Origin` header, and no `vary: origin`: a
  cached reply then serves CORS and non-CORS requests alike.
- A denied origin is served normally, without CORS headers: CORS decides what a page may read, it is
  not access control.

`origin` is `'*'`, an origin, an anchored `RegExp`, a list of them or a function. Options are checked
at boot ([`ZNIGHT005`](/reference/error-codes#znight005)): an origin written with a path or a
trailing slash, an unanchored `RegExp`, `'*'` or `allowHeaders: '*'` with `credentials`, and
`'*'` in the `methods`, `allowHeaders` or `exposeHeaders` lists with `credentials` (browsers read it
literally there). Other options: `methods`, `allowHeaders` (`'*'` never covers `Authorization`: it
is named in the preflight answer when the browser asks for it), `exposeHeaders`, `maxAge` (600 s).
With Fastify, Express or Hono, use either this option or their CORS middleware, not both.

## Security headers

On by default, added to every reply that does not set them (`@Res()` raw replies excepted):
`content-security-policy: default-src 'none'; frame-ancestors 'none'`, `x-frame-options: DENY`,
`x-content-type-options: nosniff` and `referrer-policy: no-referrer`. HSTS,
`cross-origin-resource-policy` and `cache-control` are opt-in:

```ts
HttpPlugin.configure({ securityHeaders: { hsts: true, cacheControl: 'no-store' } }) // merged over the defaults
HttpPlugin.configure({ securityHeaders: false }) // none
```

Every header loses to one set by the handler (`@Header`, `ctx.setHeader()`, `HttpResponse`), an
interceptor, an exception or a hook: a route serving an HTML page sets its own
`content-security-policy`.

## Behind a proxy

```ts
HttpPlugin.configure({ trustProxy: 1 }) // one load balancer in front of the server
HttpPlugin.configure({ trustProxy: ['loopback', '10.0.0.0/8'] }) // the addresses of the proxies
```

`trustProxy` (default `false`) gives the real client address in `ctx.ip` and the original protocol
in `ctx.protocol` (`'http'` or `'https'`), read from `x-forwarded-for` and `x-forwarded-proto` only
when they come from a trusted proxy. It works the same way on every adapter: a number of hops, or
IPv4 / IPv6 addresses, CIDR ranges and the aliases `'loopback'`, `'private'` and `'linklocal'`.
`true` is refused at boot: trusting every hop lets any client choose its `ctx.ip`.

## Cookies

Cookies are handled by the plugin itself, identically on every adapter: no `cookie-parser`,
`@fastify/cookie` or `hono/cookie`, secure defaults, strict validation and optional signing.

### Reading cookies

```ts
import { Body, Controller, Cookie, Ctx, Get, type HttpContext, HttpResponse, Post } from '@znight/http'
import { z } from 'zod'

export const ThemeInput = z.object({ theme: z.enum(['light', 'dark']) })
export type ThemeInput = z.output<typeof ThemeInput>
// a stale or forged value falls back instead of answering 400 until the cookie expires
export const ThemeCookie = z.enum(['light', 'dark']).catch('light')

@Controller('/prefs')
export class PrefsController {
  @Get()
  read(@Cookie('theme', ThemeCookie) theme: 'light' | 'dark', @Cookie('visits') visits = 0) {
    return { theme, visits }
  }

  @Post('/theme')
  setTheme(@Body(ThemeInput) input: ThemeInput, @Ctx() ctx: HttpContext) {
    ctx.setCookie('theme', input.theme, { maxAge: 365 * 86_400, httpOnly: false }) // readable by the front-end
    return HttpResponse.noContent()
  }
}
```

| Decorator / member          | Injects                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `@Cookie('name') v: T`      | The decoded cookie, coerced to `T` like a header; absent and required: 400 `Missing cookie`  |
| `@Cookie('name', schema)`   | The decoded value (or `undefined`) validated with a Standard Schema (its output is injected) |
| `@Cookie()` / `@Cookie(S)`  | Every cookie (`Record<string, string>`), validated by `S` when given                         |
| `@SignedCookie('name', S?)` | The verified value of a [signed cookie](#signed-cookies): tampered or unsigned means absent  |
| `ctx.cookies`               | Every request cookie (a frozen record without prototype, parsed on first access)             |
| `ctx.signedCookie(name)`    | The verified value, or `undefined`                                                           |

When a name repeats, the first cookie wins (browsers send the most specific path first). An
invalid value answers 400 (`Invalid cookie "visits": expected a number`) and the message never
echoes the value (the issues of a schema read `Invalid value`: some libraries quote the value in
them): cookies outlive deployments, so give the ones that may go stale a schema with a fallback, as
above.

### Setting cookies

```ts
ctx.setCookie('theme', 'dark', { maxAge: 365 * 86_400, httpOnly: false })
ctx.clearCookie('__Host-uid') // Max-Age=0 with the same Path and Secure

return HttpResponse.ok({ id: user.id }).withCookie('__Host-uid', user.id, { signed: true, maxAge: 8 * 3600 })
return HttpResponse.noContent().withoutCookie('session')
```

| Option                    | Default | Description                                                                |
| ------------------------- | ------- | -------------------------------------------------------------------------- |
| `maxAge`, `expires`       | —       | Lifetime in seconds, or an absolute `Date`. Default: a session cookie      |
| `domain`, `path`          | —, `/`  | Default: a host-only cookie for the whole site (`domain: null`: host-only) |
| `secure`                  | `true`  | Sent over HTTPS only (and `http://localhost`)                              |
| `httpOnly`                | `true`  | Not readable from JavaScript                                               |
| `sameSite`                | `'lax'` | `'strict'`, `'lax'` or `'none'` (requires `secure`)                        |
| `partitioned`, `priority` | —       | CHIPS partitioned cookie (requires `secure`), Chromium `Priority`          |
| `signed`                  | `false` | Signs the value with the first secret of `cookies.secrets`                 |

What the plugin guarantees:

- **Secure defaults**: `Path=/; Secure; HttpOnly; SameSite=Lax`, host-only. Change them for the
  whole application with the plugin option `cookies.defaults`, and per cookie with the options:
  `domain: null` keeps one cookie host-only under a default `domain`, and a `__Host-` cookie never
  takes the default `domain` or `path`.
- **Strict serialisation**: a cookie browsers would drop silently (a name that is not a token,
  more than 4096 bytes, an `expires` outside the years 1601 to 9999, `SameSite=None` or
  `partitioned` without `secure`, an invalid `__Secure-`, `__Host-`, `__Http-` or `__Host-Http-`
  cookie) throws where it is set. `ctx.setCookie()` checks
  everything at call time; `withCookie()` checks what depends on the plugin (defaults, signing)
  when the response is sent, and a violation answers a logged 500.
- **Which cookies are sent**: the cookies of `ctx.setCookie()` / `ctx.clearCookie()` go with every
  response of the request, errors and redirects included (a guard can clear a cookie, then throw a
  401); those of the `HttpResponse` replace them for the same name, domain and path. Each cookie is
  its own `set-cookie` line on every adapter. Cookies your middleware set before the Znight route
  (Express `res.cookie()`, a Fastify hook, Hono `setCookie(c, ...)`) are kept, before these. A
  `@Res()` handler writes its own response: no cookie is added. Setting a cookie once an event
  stream has started throws.
- `serializeCookie()`, `serializeClearCookie()`, `parseCookieHeader()` and `parseSetCookie()` are
  exported for gateways and tests.

### Signed cookies

```ts
HttpPlugin.configure(c => ({ cookies: { secrets: c.get(AppConfig).cookieSecrets } })) // the first signs, all verify
```

`{ signed: true }`, `@SignedCookie` and `ctx.signedCookie()` use an HMAC-SHA256 bound to the cookie
name, checked in constant time; a tampered value, or one signed with a retired key, is treated as
absent (no "bad signature" error to probe). Each secret is at least 32 bytes
(`crypto.randomBytes(32).toString('base64url')`, loaded with `@Secret`); short secrets and
duplicates fail the boot with [`ZNIGHT005`](/reference/error-codes#znight005), and a route reading
`@SignedCookie` without `cookies.secrets` with [`ZNIGHT006`](/reference/error-codes#znight006).
Rotate keys by deploying `[next, current]`, then `[next]` once the longest cookie lifetime has
passed. Signing gives integrity, not confidentiality. `plugin.signCookie(name, value)` returns the
signed value.

Sessions and encrypted cookies are not included. Use `__Host-` names for authentication cookies,
and see the [CSRF recipe](/guide/security#csrf) for cookie authentication.

### Testing cookies

`inject()` (and [`TestApp.inject()`](/guide/testing#testapp-end-to-end-tests)) sends request
cookies with `cookies`, signs `signedCookies` with the current secret, and returns the parsed
`set-cookie` lines by name in `response.cookies` (`{ name, value, maxAge, path, secure, httpOnly,
sameSite... }`). Values round-trip, signed ones included:

```ts
const login = await app.inject({ method: 'POST', url: '/auth/login', body: { email, password } })
expect(login.cookies['__Host-uid']).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax' })

const me = await app.inject({
  method: 'GET',
  url: '/auth/me',
  cookies: { '__Host-uid': login.cookies['__Host-uid'].value },
})
const signed = await app.inject({ method: 'GET', url: '/auth/me', signedCookies: { '__Host-uid': 'u-1' } })
```

## Server-Sent Events

`@Sse(path?, options?)` declares a `GET` route serving an event stream. No dependency, identical
on every adapter, Node.js and Bun.

```ts
import {
  Controller,
  Ctx,
  Headers,
  type HttpContext,
  HttpResponse,
  NotFoundException,
  Param,
  Sse,
  type SseEvent,
} from '@znight/http'

@Controller('/orders')
export class OrderEventsController {
  constructor(
    private readonly orders: OrderService,
    private readonly hub: OrderHub,
  ) {}

  /** An async method checks first, then returns the source of events. */
  @Sse('/:id/events', { retry: 5_000, maxDuration: 30 * 60_000 })
  async events(
    @Param('id') id: string,
    @Headers('last-event-id') lastEventId: string | undefined, // sent by EventSource when it reconnects
    @Ctx() ctx: HttpContext,
  ): Promise<AsyncIterable<SseEvent<OrderEvent>> | HttpResponse> {
    const order = await this.orders.find(id)
    if (order === undefined) throw new NotFoundException(`Order ${id} not found`) // EventSource stops
    if (order.closed) return HttpResponse.noContent() // 204: EventSource stops reconnecting
    return this.hub.subscribe(id, { after: lastEventId, signal: ctx.signal })
  }
}
```

- The handler returns an `AsyncIterable`, an `Iterable` or a `ReadableStream` of `SseEvent`
  (`{ data, event, id, retry, comment }`; non-string `data` is sent as JSON, user content can never
  inject fields). `Uint8Array` chunks are written as is, to proxy an upstream event stream.
  Any other `HttpResponse`, a thrown exception or a Web `Response` is sent as usual.
- Prefer an `async` method that returns the source over an `async *` generator: the body of a
  generator only runs once the 200 is sent, too late to answer 404 or 204.
- `HttpResponse.sse(source, options?)` serves an event stream from any route and method (`POST`
  streaming for `fetch()` clients, 200 by default).
- `encodeSseEvent()` and `parseSseStream()` (a `ReadableStream` to its events) are exported.

| Option        | Default                           | Description                                                                                              |
| ------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `heartbeat`   | plugin `sse.heartbeat` (8 000 ms) | Keep-alive comment after this many ms without an event (1 000 to 2^31 − 1), or `false`                   |
| `retry`       | plugin `sse.retry` (none)         | Client reconnection delay, sent first                                                                    |
| `maxDuration` | none                              | Ends the stream gracefully after this many ms (1 000 to 2^31 − 1, about 24.8 days): rebalancing, re-auth |

### Stream lifecycle

- **Open**: the status, the headers (`content-type: text/event-stream`,
  `cache-control: no-cache, no-transform`, `x-accel-buffering: no`) and a first chunk are sent at
  once, on every adapter. Guards run before, once: use `maxDuration` to force re-authentication.
- **Backpressure**: events are pulled one at a time, nothing is read ahead. `EventChannel` bridges
  push sources (a bus, an `EventEmitter`) with a bounded buffer per client (`capacity`, `overflow`:
  `'drop-oldest'`, `'drop-newest'` or `'close'`).
- **Client disconnect**: `ctx.signal` aborts (a `RequestAbortedError` with `kind: 'client'`) and
  the source is stopped. Pass `ctx.signal` to the source: the request scope waits for it to stop
  (5 s at most, with a warning).
- **Errors**: a source that throws ends the stream cleanly, logged; the client reconnects.
- **`maxDuration` and shutdown**: `ctx.signal` aborts (`'expired'` / `'shutdown'`), the source gets
  `sse.shutdownGraceMs` to send final events, then the client receives a jittered `retry` and
  reconnects, to another instance during a rolling deployment. `onStop` closes the streams before
  the drain; keep `sse.shutdownGraceMs` < `drainTimeoutMs`.
- **Observability**: `http:request` resolves when the stream opens; `plugin.streams` counts the
  open streams.

`ctx.signal` exists on every route: it aborts when the client leaves before the response was
written, never after a normal completion. `EventSource` cannot send an `Authorization` header:
authenticate browser streams with a cookie. Proxies and timeouts (nginx, Cloudflare, `Bun.serve()`
`idleTimeout`) are covered by the heartbeat and the headers above; the
[README](../../packages/http/README.md) has the details.

### Testing event streams

`inject()` rejects an event stream instead of waiting for its end. `injectSse()` (on the plugin and
on [`TestApp`](/guide/testing#testapp-end-to-end-tests)) reads it in memory like `EventSource`;
`injectStream()` gives the raw `ReadableStream`:

```ts
await using stream = await app.injectSse({ url: '/orders/o-1/events' })
expect(stream.status).toBe(200)

hub.publish({ orderId: 'o-1', sequence: 42, type: 'status', status: 'paid' })
const event = await stream.next() // rejects after 2 000 ms by default
expect(event).toMatchObject({ event: 'status', id: '42' })
expect(event.json()).toMatchObject({ status: 'paid' })

const resumed = await stream.reconnect() // sends last-event-id: 42, like EventSource
```

Events are read only when asked for (`next()`, `take(n)`, `for await`), so the test sets the pace
of the client; `close()` (or the end of the `await using` block) is a client disconnect. Opening
never hangs a test: `injectSse()` resolves at the first chunk of the stream, or after 2 000 ms for a
stream that sends nothing yet (a hand-written or proxied one), and rejects, naming the request, when
the response headers do not arrive within 2 000 ms.

## Request context

Each request runs in its own [request scope](/guide/scopes#request-scopes) seeded with request-scoped
externals:

- `HttpContext`: the adapter-neutral request/response context (`params`, `query`, `headers`, `body`,
  `files`, `cookies`, `route`, `state`, `ip`, `protocol`, `signal`, `setHeader()`, `setCookie()`,
  `parseBody()`, `rawBody()`, `bodyStream()`...);
- `RequestId`: the request identifier (the incoming `x-request-id` when valid, else a UUID).

Inject them in request-scoped providers, or through `Lazy<HttpContext>` in singletons. Request-scoped
instances are disposed once the response has been sent (streams and files included, so a
request-scoped provider may own a temporary file it deletes when disposed).

## The request pipeline

![HTTP request pipeline: in a request scope (HttpContext, RequestId) and inside the http:request hook, a CORS preflight is answered directly (204, 403, 404); otherwise guards, body parsing, interceptors around the invocation (extract, coerce, validate, handler) and serialisation run, anything thrown becoming an error response; then cookies, request id, CORS and security headers are added and the scope closes once the body has been sent](/diagrams/http-pipeline.svg)

Observers such as `@znight/observability` wrap `http:request` to log, measure and trace every
request.

## Plugin options

`HttpPlugin.configure(options)`, or `HttpPlugin.configure(container => options)`:

| Option             | Default               | Description                                                                                 |
| ------------------ | --------------------- | ------------------------------------------------------------------------------------------- |
| `adapter`          | `nodeAdapter()`       | `fastifyAdapter()`, `expressAdapter()`, `honoAdapter()`...                                  |
| `port`, `host`     | `3000`, `0.0.0.0`     | Listening address (`port: 0`: a free port)                                                  |
| `prefix`           | —                     | Path prefix for every route (`/api`)                                                        |
| `guards`           | `[]`                  | Global guards (classes or instances)                                                        |
| `interceptors`     | `[]`                  | Global interceptors                                                                         |
| `exceptionMappers` | `[]`                  | Map error types to responses                                                                |
| `trailingSlash`    | `'strict'`            | `'strict'`, `'ignore'` or `'redirect'`                                                      |
| `exposeErrors`     | `false`               | Include messages of unexpected errors in `500` responses                                    |
| `bodyLimit`        | 1 MiB                 | Maximum request body size (bytes or `'10mb'`)                                               |
| `uploads`          | see [Files](#uploads) | `{ maxFileSize, maxFiles, maxParts, maxFieldSize }`                                         |
| `requestIdHeader`  | `x-request-id`        | Header read and echoed (`false`: always generate)                                           |
| `drainTimeoutMs`   | `4000`                | Maximum wait for in-flight requests on shutdown (`Infinity`: no limit)                      |
| `cors`             | off                   | [CORS](#cors) policy: `{ origin, credentials?, methods?, ... }`                             |
| `securityHeaders`  | `true`                | [Security headers](#security-headers): `true`, `false` or settings                          |
| `trustProxy`       | `false`               | [Trusted proxies](#behind-a-proxy): a hop count or addresses / CIDRs                        |
| `enforcement`      | `'error'`             | Unenforced [route decisions](#route-metadata-and-decisions): fail or warn                   |
| `cookies`          | —                     | `{ secrets?, defaults? }`: [signing keys](#signed-cookies) and [defaults](#setting-cookies) |
| `sse`              | —                     | `{ heartbeat?, retry?, shutdownGraceMs? }` of [event streams](#server-sent-events)          |

## Plugin routes

Other plugins can serve routes through `HttpPlugin` (the OpenAPI document, status endpoints) by
implementing `PluginHttpRoutes`: `httpRoutes({ prefix, container })` returns
`{ method, path, name, handler, meta?, guards? }` entries. They are registered on every adapter in
the same pipeline as the controllers (the `http:request` hook, the global guards, then their own),
take their route decisions from `meta` (`[Public.meta()]`), and are listed in `HttpPlugin.routes`
with the plugin name as `source`. A path collision is [`ZNIGHT007`](/reference/error-codes#znight007)
naming the plugin.

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
