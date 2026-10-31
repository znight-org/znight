# @znight/http

HTTP controllers for [Znight](../../README.md), resolved at build time and served by the built-in
`node:http` server, Fastify, Express or Hono.

Controllers, routing, parameter coercion, validation with any
[Standard Schema](https://standardschema.dev) library (Zod, Valibot, ArkType...), file uploads and
downloads, streaming, cookies (signed or not), Server-Sent Events, guards, interceptors, exception
mappers, request scopes and graceful shutdown.
Security is built in: access decisions on every route checked at build time and at boot, CORS,
security headers and trusted proxies.
It ships a zero-dependency server on `node:http` and adapters for **Fastify**, **Express** and
**Hono**, and behaves the same on every one of them (on Node.js and Bun).

Like the rest of Znight, routes are resolved **at build time**: `@znight/http/compiler` reads your
decorators and generates the route table and one `invoke` function per handler (argument
extraction, coercion, validation). At runtime the plugin only registers the generated routes: no
reflection, no metadata lookup per request.

```sh
# bun
bun add @znight/core @znight/http zod   # zod, or any Standard Schema library
bun add -d @znight/compiler vite
bun add fastify                          # optional: or express, or hono (+ @hono/node-server on Node.js)

# npm
npm install @znight/core @znight/http zod
npm install -D @znight/compiler vite
npm install fastify
```

Runs on Node.js >= 24 and Bun >= 1.3 (ESM only). Decorators require `"experimentalDecorators": true`.
Every adapter is an [optional peer dependency](#optional-peer-dependencies) (`light-my-request` too,
for `inject()` with the `node` and `express` adapters).

**Documentation:** [`@znight/http`](https://github.com/znight-org/znight/blob/main/docs/packages/http.md)
and the [security guide](https://github.com/znight-org/znight/blob/main/docs/guide/security.md).
**Examples:** [`rest-api`](https://github.com/znight-org/znight/tree/main/examples/rest-api) (Fastify,
API keys), [`secure-api`](https://github.com/znight-org/znight/tree/main/examples/secure-api) (route
decisions, JWT, cookies, CORS), [`microservice`](https://github.com/znight-org/znight/tree/main/examples/microservice)
and [`storefront-api`](https://github.com/znight-org/znight/tree/main/examples/storefront-api) (Hono),
[`uptime-monitor`](https://github.com/znight-org/znight/tree/main/examples/uptime-monitor)
(Server-Sent Events), [`monorepo`](https://github.com/znight-org/znight/tree/main/examples/monorepo)
(Express).

- [Quick start](#quick-start)
- [Controllers and routes](#controllers-and-routes)
- [Parameters](#parameters)
- [Validation](#validation)
- [Request bodies](#request-bodies)
- [Responses](#responses)
- [Cookies](#cookies)
- [Files](#files)
- [Server-Sent Events](#server-sent-events)
- [Errors](#errors)
- [Guards](#guards)
- [Route decisions](#route-decisions)
- [CORS](#cors)
- [Security headers](#security-headers)
- [Behind a proxy](#behind-a-proxy)
- [Interceptors](#interceptors)
- [The request context](#the-request-context)
- [Hooks and observability](#hooks-and-observability)
- [Plugin options](#plugin-options)
- [Plugin routes](#plugin-routes)
- [Adapters](#adapters)
- [Testing](#testing)
- [Lifecycle and graceful shutdown](#lifecycle-and-graceful-shutdown)
- [Compiler](#compiler)
- [Compiler contract](#compiler-contract)
- [Compiler contract for other extensions](#compiler-contract-for-other-extensions)
- [Writing an adapter](#writing-an-adapter)
- [Limitations](#limitations)

## Quick start

```ts
// src/users/user.controller.ts
import { Body, Controller, Delete, Get, HttpResponse, NotFoundException, Param, Post, Query } from '@znight/http'
import { z } from 'zod'

export const CreateUser = z.object({ name: z.string().min(1), email: z.email() })
export type CreateUser = z.output<typeof CreateUser>

@Controller('/users')
export class UserController {
  constructor(private readonly users: UserService) {}

  @Get()
  list(@Query('page') page = 1, @Query('tag') tags: string[] = []) {
    return this.users.list({ page, tags })
  }

  @Get('/:id')
  async find(@Param('id') id: number) {
    const user = await this.users.findById(id)
    if (user === undefined) throw new NotFoundException(`User ${id} not found`)
    return user
  }

  @Post()
  async create(@Body(CreateUser) input: CreateUser) {
    const user = await this.users.create(input)
    return HttpResponse.created(user, `/users/${user.id}`)
  }

  @Delete('/:id')
  remove(@Param('id') id: number) {
    return this.users.remove(id) // undefined → 204 No Content
  }
}
```

```ts
// src/main.ts
import { Application } from '@znight/core'
import { HttpPlugin } from '@znight/http'
import { __ZNIGHT_METADATA__ } from './.znight/container.generated.js'

const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins: [HttpPlugin.configure({ port: 3000, prefix: '/api' })],
})
await app.start() // SIGINT / SIGTERM: stop accepting connections, drain, close
```

```sh
curl localhost:3000/api/users/42          # {"id":42,...}
curl localhost:3000/api/users/abc         # 400 {"statusCode":400,"error":"Bad Request","message":"Invalid param \"id\": expected a number, received \"abc\""}
curl -X POST localhost:3000/api/users -H 'content-type: application/json' -d '{"name":""}'
# 400 {"statusCode":400,"error":"Bad Request","message":"Invalid body","details":[{"path":"name","message":"..."},{"path":"email","message":"..."}]}
```

## Controllers and routes

| Decorator                                 | Target         | Description                                                                            |
| ----------------------------------------- | -------------- | -------------------------------------------------------------------------------------- |
| `@Controller(path?)`                      | class          | A provider (singleton) whose decorated methods are routes                              |
| `@Controller({ path?, scope? })`          | class          | `scope: 'request'` creates one controller instance per request                         |
| `@Get` `@Post` `@Put` `@Patch` `@Delete`  | method         | Route; `path` is relative to the controller path (default: the controller path)        |
| `@Head(path?)` `@Options(path?)`          | method         | Explicit `HEAD` / `OPTIONS` routes                                                     |
| `@All(path?)`                             | method         | GET, HEAD, POST, PUT, PATCH, DELETE and OPTIONS, for methods without their own route   |
| `@Sse(path?, options?)` / `@Sse(options)` | method         | `GET` route serving an event stream, see [Server-Sent Events](#server-sent-events)     |
| `@HttpCode(status)`                       | method         | Status of successful responses                                                         |
| `@Header(name, value)`                    | method         | Header of successful responses (repeatable)                                            |
| `@BodyLimit(size)`                        | class / method | Maximum request body size of the route(s) (`'10mb'`), see [Limits](#limits)            |
| `@UseGuard(...guards)`                    | class / method | [Guards](#guards)                                                                      |
| `@UseInterceptor(...interceptors)`        | class / method | [Interceptors](#interceptors)                                                          |
| `@Validate(schema)`                       | method         | Sugar for `@Body(schema)`                                                              |
| `createRouteDecorator<T>(key)`            | —              | Your own metadata decorators (`@Roles(['admin'])`, `@Public()`), see [Guards](#guards) |

Arguments of paths, statuses and header names must be statically evaluable (literals, `const`
references): the compiler reads them.

### Path grammar

Paths are made of static segments, `:name` parameters and an optional trailing `*` wildcard:

```
/users                 static
/users/:id             :id matches one non-empty segment
/users/:id/posts/:post several parameters
/files/*               the rest of the path, possibly empty ('/files/' and '/files/a/b', not '/files'),
                       available as ctx.params['*']
```

Static segments accept letters, digits and `- . _ ~ ! $ & ' + , ; = @`. Anything else (`//`, `.`,
`..`, `:a-b`, `*` in the middle, regular expressions, `?`) is a ZNIGHT007 error at build time (and
at boot for hand-written metadata). Matching is case-sensitive, on the raw (percent-encoded)
request path: dot segments are not resolved (`GET /files/a/../b` gives `ctx.params['*']` = `a/../b`,
`/files/%2e%2e/x` gives `../x`), so never build file paths from parameters without `root` (see
[Downloads](#downloads)). The Hono adapter on Bun is the exception: `Bun.serve()` only gives it the
WHATWG-normalised URL (`/files/a/../b` arrives as `/files/b`).

When several routes match a path, the most specific one wins on every adapter: static segments
beat parameters, which beat the wildcard (`/users/me` before `/users/:id`).

### Automatic HEAD, OPTIONS, 404 and 405

- Every `GET` route answers `HEAD` (same status and headers, no body) unless a `@Head` route
  exists for the same path.
- A path that exists with other methods answers `405 Method Not Allowed` with an `allow` header,
  and `OPTIONS` with `204` and `allow` (unless an `@Options` route exists). Both list the same
  methods, `OPTIONS` included (`allow: GET, HEAD, POST, OPTIONS`).
- Unknown paths answer `404 Not Found`. Both go through [exception mappers](#exception-mappers) and
  [hooks](#hooks-and-observability).

### Trailing slashes and prefix

`trailingSlash` applies to every adapter: `'strict'` (default: `/users/` does not match `/users`),
`'ignore'` (it does) or `'redirect'` (`308` to `/users`, query string kept; the `location` always
stays on the same origin: a backslash, a control character or a leading `//` of the raw path is
percent-encoded or collapsed, so `GET /\evil.com/` redirects to `/%5Cevil.com`). `prefix: '/api'`
is prepended to every route.

## Parameters

| Decorator               | Injects                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `@Param('id')`          | A route parameter, decoded and coerced to the parameter type                           |
| `@Param()`              | Every route parameter (`Record<string, string>`)                                       |
| `@Query('page')`        | A query value, coerced; `T[]` accepts `?tag=a&tag=b` and `?tag=a`                      |
| `@Query()`              | The whole query (`Record<string, string \| string[]>`), usually with a schema          |
| `@Body()`               | The parsed body (see [Request bodies](#request-bodies)), usually with a schema         |
| `@Headers('x-api-key')` | A request header (case-insensitive), coerced                                           |
| `@Headers()`            | Every header (`Record<string, string \| undefined>`, lower-case names)                 |
| `@Cookie('name')`       | A request cookie (decoded), coerced (see [Cookies](#cookies))                          |
| `@Cookie()`             | Every cookie (`Record<string, string>`)                                                |
| `@SignedCookie('name')` | The verified value of a [signed cookie](#signed-cookies), coerced                      |
| `@UploadedFile('f')`    | An uploaded `File` of a multipart body (see [Files](#uploads))                         |
| `@UploadedFiles('f')`   | The uploaded files of a field (`File[]`)                                               |
| `@Ctx()`                | The [`HttpContext`](#the-request-context)                                              |
| `@Req()` / `@Res()`     | The native request / response of the adapter (escape hatch, see [Adapters](#adapters)) |

`@Param`, `@Query`, `@Body`, `@Cookie` and `@SignedCookie` take an optional Standard Schema
(`@Param('id', IdSchema)`, `@Query(SearchQuery)`, `@Body(CreateUser)`, `@Cookie('theme', Theme)`):
the **schema output** is injected (no coercion then).

Without a schema, typed parameters are coerced:

| Declared type                      | Accepted input                                    | Example            |
| ---------------------------------- | ------------------------------------------------- | ------------------ |
| `string`                           | any single value                                  | `abc`              |
| `number`                           | finite decimal number (no hex, `NaN`, `Infinity`) | `-1.5`, `1e3`      |
| `boolean`                          | `true`/`false`/`1`/`0` (case-insensitive)         | `true`             |
| `bigint`                           | integer                                           | `9007199254740993` |
| `Date`                             | ISO 8601 date, date-time with offset, timestamp   | `2024-01-02`       |
| literal unions (`'asc' \| 'desc'`) | one of the literals                               | `asc`              |
| `T[]`                              | repeated or single values, each coerced as `T`    | `?id=1&id=2`       |

Invalid values answer `400` naming the input (`Invalid query "page": expected a number, received
"x"`). Dates accept `YYYY-MM-DD` (UTC midnight), `YYYY-MM-DDTHH:mm[:ss[.fraction]]` with an offset
(`Z`, `+02:00`, `+0200`) and integer millisecond timestamps; anything else (`March 7`,
`01/02/2024`), impossible dates (`2024-02-30`) and date-times without offset (they would depend on
the server's time zone) answer `400`. A missing required value answers `400 Missing query "page"`. Optional parameters (`?`,
`| undefined`, default value) receive `undefined` when absent, so default values apply:
`@Query('page') page = 1`. A repeated query key for a scalar parameter is a `400`.

## Validation

Any library implementing [Standard Schema v1](https://standardschema.dev) works, without adapter:
Zod 3.24+/4, Valibot 1, ArkType 2, Effect Schema...

```ts
const SearchQuery = z.object({ q: z.string(), limit: z.coerce.number().int().max(100).default(10) })

@Get('/search')
search(@Query(SearchQuery) query: z.output<typeof SearchQuery>) {
  // query.limit is a number (default applied), unknown keys are stripped by the schema
}
```

- Handlers receive the schema **output**: defaults, transforms, coercions, stripped keys.
- Async schemas (async refinements) are supported.
- A failure answers `400` with one entry per issue (`path` is dotted, `''` for the root):

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "Invalid body",
  "details": [{ "path": "user.emails.1", "message": "Invalid email address" }]
}
```

The error is a `ValidationException` (a `BadRequestException`) carrying `location` (`body`,
`query`, `param "id"`...) and the raw Standard Schema `issues`: map it to your own format with an
[exception mapper](#exception-mappers).

A non-primitive `@Body()` / `@Query()` without schema is reported by the compiler (ZNIGHT017, an
error with `strictValidation`).

## Request bodies

Znight parses bodies itself (identically on every adapter), after the guards and before the
interceptors, for routes declaring `@Body()` or [upload parameters](#uploads):

| `content-type`                      | Body                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| (empty body)                        | `undefined`                                                                   |
| `application/json`, `*/*+json`      | parsed JSON (`400` when malformed)                                            |
| `text/*`                            | string (charset honoured)                                                     |
| `application/x-www-form-urlencoded` | record, repeated keys as arrays                                               |
| `multipart/form-data`               | record of the **text fields**, repeated names as arrays; files in `ctx.files` |
| anything else / none                | `Uint8Array`                                                                  |
- Bodies above the body limit answer `413`: `bodyLimit` (default 1 MiB), `@BodyLimit(size)` on the
  route or controller, or the computed limit of upload routes (see [Limits](#limits)). It is
  checked on `content-length` first, then while reading; the connection is closed.
- A `content-encoding` other than `identity` answers `415` (decompress upstream).
- Whether a request has a body is decided by its `content-length` / `transfer-encoding` headers
  (an HTTP/1.1 request without them has none), so `content-length: 0` or no framing header is an
  empty body on every adapter.
- Other routes do not read the body: call `await ctx.parseBody()` (memoised),
  `await ctx.rawBody()` (bytes, e.g. to verify a webhook signature) or `ctx.bodyStream()` (a Web
  stream, nothing buffered: see [Large files](#large-files)).

## Responses

| Handler result                                  | Response                                                       |
| ----------------------------------------------- | -------------------------------------------------------------- |
| object, array, number, boolean, `null`          | JSON (`application/json; charset=utf-8`), `toJSON()` honoured  |
| `string`                                        | `text/plain; charset=utf-8`                                    |
| `Uint8Array`, `Buffer`, `ArrayBuffer`, views    | `application/octet-stream`                                     |
| `ReadableStream`, Node.js `Readable`            | streamed `application/octet-stream` (string chunks as UTF-8)   |
| `Blob` / `File`                                 | its bytes, with the blob type and its size                     |
| `HttpResponse.file()` / `HttpResponse.stream()` | a file or a stream, see [Files](#downloads)                    |
| `HttpResponse.sse()`                            | an event stream, see [Server-Sent Events](#server-sent-events) |
| `undefined`                                     | empty body, `204` (`201` for `@Post`)                          |
| `HttpResponse`                                  | its body (same rules), status and headers                      |
| Web `Response`                                  | sent as is (`@HttpCode` / `@Header` do not apply)              |

**Status precedence:** `@HttpCode` > `HttpResponse.status` > default (`201` for `@Post` routes,
`204` without body, `200` otherwise).

**Header precedence:** content type < `@Header` < `ctx.setHeader()` < `HttpResponse` headers.
Headers set with `ctx.setHeader()` / `ctx.appendHeader()` are also sent with error responses (a
guard can set `www-authenticate` and throw). Every response carries the request id header and the
[security headers](#security-headers) it does not set itself.

```ts
return HttpResponse.ok(user)
return HttpResponse.created(user, `/users/${user.id}`) // location header; typed HttpResponse<User>
return HttpResponse.accepted()
return HttpResponse.noContent()
return HttpResponse.redirect('/login', 303)
return HttpResponse.file('report.pdf', { root: REPORTS_DIR }) // see Files
return HttpResponse.stream(rows(), { filename: 'export.csv' })
return HttpResponse.sse(this.llm.complete(prompt)) // see Server-Sent Events
return new HttpResponse(csv, { status: 200, headers: { 'content-type': 'text/csv' } }).withHeader('x-total', '42')
return HttpResponse.ok(user).withCookie('__Host-uid', user.id, { signed: true }) // see Cookies
```

`withHeader()`, `withStatus()`, `withCookie()` and `withoutCookie()` return copies (headers,
status and cookies are kept).

`HEAD` requests and `204`/`304` statuses never have a body (streams are cancelled).

### Writing the response yourself

`@Res()` injects the native response; the handler then writes it and must have finished when its
promise settles. Returning a Web `Response` is portable and usually better.

| Adapter   | `@Req()`               | `@Res()`                                             |
| --------- | ---------------------- | ---------------------------------------------------- |
| `node`    | `http.IncomingMessage` | `http.ServerResponse`                                |
| `fastify` | `FastifyRequest`       | `FastifyReply` (return `reply.send(...)`)            |
| `express` | Express `Request`      | Express `Response`                                   |
| `hono`    | Web `Request`          | Hono `Context` (return `c.text(...)`, `c.json(...)`) |

## Cookies

Cookies are handled by the plugin itself, identically on every adapter (no `cookie-parser`,
`@fastify/cookie` or `hono/cookie` needed), with secure defaults, strict validation and optional
signing. Tests send and read them with `inject()`: see
[Testing cookies](#testing-cookies).

### Reading cookies

```ts
import { Body, Controller, Cookie, Ctx, Get, type HttpContext, HttpResponse, Post } from '@znight/http'
import { z } from 'zod'

export const ThemeInput = z.object({ theme: z.enum(['light', 'dark']) })
// a stale or forged value falls back instead of answering 400 forever (cookies outlive deployments)
export const ThemeCookie = z.enum(['light', 'dark']).catch('light')

@Controller('/prefs')
export class PrefsController {
  @Get()
  read(@Cookie('theme', ThemeCookie) theme: 'light' | 'dark', @Cookie('visits') visits = 0) {
    return { theme, visits }
  }

  @Post('/theme')
  setTheme(@Body(ThemeInput) input: z.output<typeof ThemeInput>, @Ctx() ctx: HttpContext) {
    // readable by the front-end: httpOnly off for this one
    ctx.setCookie('theme', input.theme, { maxAge: 365 * 86_400, httpOnly: false })
    return HttpResponse.noContent()
  }
}
```

| Decorator / member          | Injects                                                                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@Cookie('name') v: T`      | The decoded cookie, coerced to `T` like `@Headers` (`string`, `number`, `boolean`, `bigint`, `Date`, literal unions, enums, branded primitives). Absent and required: 400 `Missing cookie "name"` |
| `@Cookie('name', S)`        | The decoded value (or `undefined`) validated with the Standard Schema `S` (its output is injected)                                                                                                |
| `@Cookie()` / `@Cookie(S)`  | Every cookie (`Record<string, string>`), validated by `S` when given                                                                                                                              |
| `@SignedCookie('name', S?)` | The **verified** value of a [signed cookie](#signed-cookies); absent, tampered or signed with an unknown key: the cookie does not exist                                                           |
| `ctx.cookies`               | `Readonly<Record<string, string>>`, parsed on first access                                                                                                                                        |
| `ctx.signedCookie(name)`    | `string \| undefined`, verified once per name                                                                                                                                                     |

The `cookie` header is split on `;` only (never `,`), pairs are trimmed, quoted values unquoted
and percent-encoded values decoded (a malformed sequence keeps the raw value). Pairs without `=`
and empty names are ignored; names are case-sensitive and kept as sent; when a name repeats, **the
first one wins** (browsers send the cookie with the longest path first). Repeated `Cookie` header
fields (HTTP/2) are joined with `; ` on every adapter. The record has no prototype (`__proto__` is
just a name) and parsing is linear, without regular expressions.

**An invalid cookie answers 400, on purpose**: `Invalid cookie "visits": expected a number`. The
message never echoes the value (cookies often carry tokens): with a schema
(`@Cookie(name, S)`, `@SignedCookie(name, S)`, `@Cookie(S)`), the `details` keep the issue paths
but their messages are `Invalid value`, since some libraries (Valibot, ArkType) quote the received
value in them. Since cookies outlive deployments, a
stale value would fail every request until it expires: give such cookies a schema with a fallback
(`z.enum([...]).catch('light')`, as above) rather than relying on lenient coercion, which would
hide tampering.

### Setting cookies

```ts
ctx.setCookie('theme', 'dark', { maxAge: 365 * 86_400, httpOnly: false })
ctx.clearCookie('__Host-uid') // Max-Age=0 with the same Path / Secure: valid for the __Host- prefix

return HttpResponse.ok({ id: user.id }).withCookie('__Host-uid', user.id, { signed: true, maxAge: 8 * 3600 })
return HttpResponse.noContent().withoutCookie('session')
```

| Option        | Default | Description                                                                                        |
| ------------- | ------- | -------------------------------------------------------------------------------------------------- |
| `maxAge`      | —       | Lifetime in seconds (integer); `0` or less expires the cookie now. Default: a session cookie       |
| `expires`     | —       | Absolute expiry (`Date` in the years 1601 to 9999, sent as an IMF-fixdate)                         |
| `domain`      | —       | Domain (sub-domains included). Default: a host-only cookie; `null`: host-only despite the defaults |
| `path`        | `'/'`   | Path                                                                                               |
| `secure`      | `true`  | Sent over HTTPS only (and `http://localhost`)                                                      |
| `httpOnly`    | `true`  | Not readable from JavaScript                                                                       |
| `sameSite`    | `'lax'` | `'strict'`, `'lax'` or `'none'` (requires `secure`)                                                |
| `partitioned` | `false` | CHIPS partitioned cookie (requires `secure`)                                                       |
| `priority`    | —       | Chromium `Priority`: `'low'`, `'medium'`, `'high'`                                                 |
| `signed`      | `false` | Signs the value with the first secret of `cookies.secrets` (see [Signed cookies](#signed-cookies)) |

The defaults are `Path=/; Secure; HttpOnly; SameSite=Lax`, host-only; change them for the whole
application with the plugin option `cookies.defaults`, and per cookie with the options above. With
a default `domain` (cookies shared across subdomains), `domain: null` makes one cookie host-only,
and `__Host-` cookies never take the default `domain` or `path` (the prefix forbids them): an
explicit `domain` or a `path` other than `/` on such a cookie still throws.
`Secure` is right behind TLS-terminating proxies: it governs the browser to edge connection, not
the proxy to app hop. Plain `http://` development setups on a non-localhost host (and old Safari
versions on `http://localhost`) need `defaults: { secure: config.env !== 'development' }`.

**Strict serialisation (RFC 6265bis).** A cookie browsers would drop silently throws where it is
set instead:

- the name must be an RFC 9110 token, the value a well-formed string; the value is percent-encoded
  outside `cookie-octet` (and `%`), so it always round-trips (`a b;c` → `a%20b%3Bc`);
- `name=value` is at most 4096 bytes on the wire (after encoding and signing), `Domain` and `Path`
  at most 1024 bytes each;
- `maxAge` is an integer, `expires` a valid `Date` in the years 1601 to 9999 (browsers ignore
  other years: `new Date(8.64e15)` would silently make a session cookie; use `maxAge`), `domain` an
  ASCII host name (IDNs in punycode; lower-cased, a leading `.` removed), `path` starts with `/` and
  has no `;` or controls;
- `SameSite=None` and `partitioned` require `secure`;
- prefixes (case-insensitive, like browsers): `__Secure-` requires `secure`; `__Host-` requires
  `secure`, `path: '/'` and no `domain`; `__Http-` and `__Host-Http-` also require `httpOnly`.

Browsers cap cookie lifetimes at 400 days; nothing is clamped server-side.

`ctx.setCookie()` / `ctx.clearCookie()` validate everything at call time (`TypeError` or
`RangeError`), so the stack trace points to the faulty line. `HttpResponse.withCookie()` is called
before any request exists: it checks the name, the value, `maxAge` / `expires`, the domain, the
path and the size before signing at call time; what depends on the plugin (the `secure` default
with a prefix or `SameSite=None`, signing, the size after signing) is checked when the response is
sent, and a violation answers a generic 500 logged as `Invalid cookie "x": …`.

**Which cookies are sent.** A response carries a _jar_ keyed by name, domain and path: a later
cookie with the same key replaces the earlier one in place (set then clear gives one clearing
cookie).

- The cookies of `ctx.setCookie()` / `ctx.clearCookie()` are sent with **every** response of the
  request: success and errors (mapped or not), redirects, automatic `OPTIONS`. A guard can
  `ctx.clearCookie('sid')` and then throw a 401.
- The cookies of the `HttpResponse` (handler result or exception mapper result) replace those of
  the context with the same key (like headers: `ctx.setHeader()` < `HttpResponse` headers).
- The `set-cookie` field holds the raw values first (`@Header`, `ctx.setHeader()` /
  `appendHeader()`, `HttpResponse` headers, a Web `Response`'s own cookies), then the jar, in
  insertion order: one field line per cookie on every adapter, one array entry in `inject()`.
- Cookies the native framework set before the Znight route (Express `res.cookie()` in a
  middleware, Fastify `reply.header('set-cookie', ...)` in a hook, Hono `setCookie(c, ...)` in a
  middleware) are kept, before the plugin's, on every reply (event streams included).
- A `@Res()` handler writes its own response: the jar is not applied.
- Once the response headers are sent (a running event stream), `setCookie()` / `clearCookie()`
  throw `Cannot set cookie "x": the response headers were already sent`.

`serializeCookie(name, value, options?)`, `serializeClearCookie(name, options?)`,
`parseCookieHeader(header)` and `parseSetCookie(line)` are exported for gateways and tests
(`serializeCookie` applies the secure defaults; signing needs the plugin: `plugin.signCookie()`).

### Signed cookies

```ts
HttpPlugin.configure(c => {
  const config = c.get(AppConfig) // @Secret('COOKIE_SECRETS') → ['current…', 'previous…']
  return { cookies: { secrets: config.cookieSecrets } } // the first signs, all verify
})

@Post('/login')
async login(@Body(Credentials) input: Credentials) {
  const user = await this.users.authenticate(input) // throws UnauthorizedException
  return HttpResponse.ok({ id: user.id }).withCookie('__Host-uid', user.id, { signed: true, maxAge: 8 * 3600 })
}

@Get('/me')
me(@SignedCookie('__Host-uid') uid: string) {
  // absent OR tampered OR signed with a retired key → 400 `Missing cookie "__Host-uid"`
  return this.users.find(uid)
}

// a guard reads the same thing imperatively
canActivate(ctx: HttpContext): boolean {
  const uid = ctx.signedCookie('__Host-uid')
  if (uid === undefined) throw new UnauthorizedException()
  ctx.state.set('uid', uid)
  return true
}
```

- **Secrets**: `cookies.secrets` is one secret or a list (`string` or `Uint8Array`), each at least
  32 bytes: generate them with `crypto.randomBytes(32).toString('base64url')` and load them with
  `@Secret` from `@znight/config`. Short secrets, duplicates and an empty list fail the boot
  (ZNIGHT005, the secrets are never echoed).
- **Format**: `<encoded value>.<base64url(HMAC-SHA256(secret, "<name>=<encoded value>"))>`. The MAC
  covers the name: a value of `a` replayed as `b` fails, `sid` and `__Host-sid` have different
  signatures. Verification is constant-time (`timingSafeEqual`); an invalid signature makes the
  cookie absent (no 400 "bad signature", no oracle). Not compatible with Express `cookie-parser`.
- **Rotation**: deploy `secrets: [next, current]` (new cookies use `next`, old ones still verify),
  wait for the longest cookie lifetime, then deploy `[next]`. Nothing is re-signed automatically;
  calling `setCookie()` again migrates a cookie.
- **Missing secrets**: a route reading `@SignedCookie` fails the boot with ZNIGHT006
  (`AuthController.me reads a signed cookie (@SignedCookie('__Host-uid')) but cookies.secrets is
  not set`); `ctx.signedCookie()` and `{ signed: true }` without secrets throw (a logged 500).
- **Limits**: signing gives integrity, not confidentiality (the client can read the value); the MAC
  does not cover an expiry, so a stolen signed cookie stays valid until rotation: put an expiry in
  the value when it matters. Sessions, encrypted cookies and CSRF middleware are out of scope.

`plugin.signCookie(name, value)` returns the signed wire value (gateways minting cookies, tests).

### Security notes

- Use `__Host-` names for authentication cookies: they cannot be shadowed by a cookie set from a
  sibling subdomain ("cookie tossing").
- `SameSite=Lax` blocks cookies on cross-site `POST`s in modern browsers but is no CSRF defense on
  its own (same-site subdomains, `GET` side effects).
- Znight's request logs do not include headers. If you log headers yourself, redact `cookie` and
  `set-cookie` (pino: `redact: ['req.headers.cookie', 'res.headers["set-cookie"]']`).

## Files

Uploads, downloads and streamed responses work the same on every adapter, on Node.js and Bun,
without dependency: files are standard [`File`](https://developer.mozilla.org/docs/Web/API/File)
objects, streams are Web `ReadableStream`s.

- [Uploads](#uploads): `@UploadedFile` / `@UploadedFiles`, text fields with `@Body()`
- [Limits](#limits): sizes, counts, media types, body limits
- [Downloads](#downloads): `HttpResponse.file()`, conditional requests and ranges
- [Streaming responses](#streaming-responses): `HttpResponse.stream()`
- [Large files](#large-files): `ctx.bodyStream()`, presigned URLs
- [Security](#security)

### Uploads

```ts
import { Body, BodyLimit, Controller, Post, UploadedFile, UploadedFiles } from '@znight/http'
import { z } from 'zod'

export const AvatarForm = z.object({ title: z.string().min(1), public: z.stringbool().default(false) })

@Controller('/profile')
export class ProfileController {
  constructor(private readonly storage: Storage) {}

  @Post('/avatar')
  async avatar(
    @UploadedFile('avatar', { maxSize: '2mb', mimeTypes: ['image/png', 'image/jpeg'] }) avatar: File,
    @Body(AvatarForm) form: z.output<typeof AvatarForm>, // the text fields of the form
  ) {
    const key = await this.storage.save(crypto.randomUUID(), avatar.stream(), avatar.type)
    return { key, size: avatar.size, title: form.title }
  }

  @Post('/documents')
  add(
    @UploadedFiles('documents', { maxFiles: 5, maxSize: '20mb', mimeTypes: ['application/pdf'] }) documents: File[],
    @UploadedFile('cover') cover?: File, // optional: undefined when absent
  ) {}
}
```

```sh
curl -F title=Me -F avatar=@me.png localhost:3000/profile/avatar
```

| Decorator                        | Injects                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| `@UploadedFile('avatar', opts?)` | the file of the field (`File`, or `File \| undefined` when optional)                |
| `@UploadedFile(opts?)`           | the single file of the body, whatever its field                                     |
| `@UploadedFiles('docs', opts?)`  | the files of the field, in body order (`File[]`)                                    |
| `@UploadedFiles(opts?)`          | every file of the body                                                              |
| `@Body(schema?)`                 | the **text fields**: `Record<string, string \| string[]>` (repeated names → arrays) |

The injected values are standard `File` objects, held in memory: `name`, `type`, `size`,
`lastModified`, `arrayBuffer()`, `bytes()`, `text()`, `stream()`, `slice()`. `file.type` is the
media type declared by the client, lower-cased (`application/octet-stream` when absent). Text fields
are strings: validate them with a schema that converts them (`z.coerce.number()`,
`z.stringbool()`); a repeated name gives an array and a single one a string
(`z.union([z.string(), z.array(z.string())])` accepts both).

Options (statically evaluated, like every decorator argument):

| Option      | Default                                  | Description                                                                                                                                        |
| ----------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `required`  | `true`, unless the parameter is optional | Answer `400` when no file is sent. An optional parameter (`file?: File`, `File \| undefined`) receives `undefined`; `@UploadedFiles` receives `[]` |
| `maxSize`   | plugin `uploads.maxFileSize` (10 MiB)    | Maximum size of **each** file: bytes or `'512kb'`, `'5mb'` (`kb` = 1024), `Infinity`                                                               |
| `maxFiles`  | plugin `uploads.maxFiles` (10)           | `@UploadedFiles` only: maximum number of files                                                                                                     |
| `mimeTypes` | any                                      | Accepted types: `'image/png'`, `'image/*'`, `'*/*'` (parameters are ignored)                                                                       |

Routes with upload parameters parse `multipart/form-data` bodies **before the interceptors**, as the
body arrives, and enforce the options while reading: an invalid upload is rejected as soon as the
offending part shows up, before the rest of the body is read. Files are only accepted in the
declared fields. Errors:

| Status | When                                                                | Message                                                                                  |
| ------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `400`  | a required file is missing                                          | `Missing file "avatar"` / `Missing files "documents"`                                    |
| `400`  | a text value was sent in a file field                               | `Expected a file in field "avatar", received a text value`                               |
| `400`  | a second file for `@UploadedFile`                                   | `Expected a single file in field "avatar"`                                               |
| `400`  | a file in an undeclared field                                       | `Unexpected file field "other"` (the issue lists the expected fields)                    |
| `400`  | a malformed body (boundary, part headers, truncated body)           | `Invalid multipart body: ...`                                                            |
| `413`  | a file above `maxSize`                                              | `File in field "avatar" exceeds the maximum size of 2 MiB`                               |
| `413`  | more than `maxFiles` files                                          | `Too many files in field "documents" (at most 5)`                                        |
| `413`  | too many parts, a text field too large, a body above the body limit | `Too many parts in the multipart body (at most 1000)`...                                 |
| `415`  | a refused media type                                                | `Unsupported file type "text/plain" in field "avatar" (accepted: image/png, image/jpeg)` |
| `415`  | a non-empty body that is not `multipart/form-data`                  | `Expected a multipart/form-data body (received "application/json")`                      |

The `details` of a `400` list the issue like a validation error does
(`[{ path: 'avatar', message: 'Missing file' }]`, the `ValidationErrorBody` of `@znight/openapi`);
those of a `413` or `415` carry the field and the limit (`{ field: 'avatar', maxSize: 2097152 }`). Errors raised
while the body is still being sent carry `connection: close`: the rest of the body is discarded and
the connection closed after the response.

On routes **without** upload parameters, a multipart body read with `@Body()` or
`ctx.parseBody()` also gives the text fields; its files are available in `ctx.files` (by field,
within the plugin `uploads` limits and the body limit), and files of any field are accepted.

> **Why not `Request.formData()`?** The Web-standard `formData()` buffers the whole body before
> parsing it, has no per-file limits and its results differ between Node.js and Bun (default part
> types, `filename*`, malformed bodies). Znight uses its own streaming RFC 7578 parser, shared by every
> adapter: same results everywhere, early rejection, explicit limits.

### Limits

| Limit                            | Where                                          | Default                    |
| -------------------------------- | ---------------------------------------------- | -------------------------- |
| size of each file                | `maxSize` option, plugin `uploads.maxFileSize` | 10 MiB                     |
| number of files of a parameter   | `maxFiles` option, plugin `uploads.maxFiles`   | 10 (1 for `@UploadedFile`) |
| number of parts (fields + files) | plugin `uploads.maxParts`                      | 1000                       |
| size of a text field             | plugin `uploads.maxFieldSize`                  | 1 MiB                      |
| size of the part headers         | built in                                       | 16 KiB                     |
| size of the whole body           | `@BodyLimit(size)`, plugin `bodyLimit`         | see below                  |

```ts
HttpPlugin.configure({
  bodyLimit: '1mb', // JSON, text, forms...
  uploads: { maxFileSize: '25mb', maxFiles: 20, maxParts: 200, maxFieldSize: '64kb' },
})
```

The **body limit** of a route is `@BodyLimit(size)` (on the route, or on the controller for all its
routes) when present. Otherwise it is the plugin `bodyLimit` for ordinary routes and, for upload
routes, the sum of what their upload parameters accept (`maxSize × maxFiles` each) plus `bodyLimit`
(room for the text fields and the multipart framing): an avatar route with `maxSize: '2mb'` accepts
bodies up to 3 MiB by default. Set `@BodyLimit` to cap a route accepting many large files, or
`@BodyLimit(Infinity)` to disable the limit of a route that streams its body itself.

Uploaded files are **held in memory** within these limits: keep them proportionate to your memory
and expected concurrency, and see [Large files](#large-files) beyond a few dozen megabytes.
`parseByteSize('10mb')` (→ `10485760`) and `formatByteSize(n)` convert sizes like the options do.

### Downloads

`HttpResponse.file(path | URL | Blob, options?)` sends a file:

```ts
import { Controller, Get, HttpResponse, Param } from '@znight/http'

const REPORTS = '/srv/app/reports'

@Controller('/reports')
export class ReportController {
  @Get('/*')
  download(@Param('*') name: string) {
    // `root` confines the path: '../../etc/passwd' or a symbolic link leaving the directory answer 404
    return HttpResponse.file(name, { root: REPORTS })
  }

  @Get('/:id/export')
  async export(@Param('id') id: string) {
    const report = await this.reports.find(id)
    return HttpResponse.file(report.path, { filename: `Rapport été ${report.year}.pdf` }) // attachment
  }

  @Get('/:id/preview')
  preview(@Param('id') id: string) {
    return HttpResponse.file(this.reports.pathOf(id), { disposition: 'inline', contentType: 'application/pdf' })
  }

  @Get('/generated.json')
  generated() {
    return HttpResponse.file(new File([JSON.stringify(data)], 'data.json', { type: 'application/json' }))
  }
}
```

| Option        | Default                                                                                               | Description                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `root`        | none (the path is used as given, relative to the working directory)                                   | Directory the path is resolved in; the real file (links followed) must stay inside it, otherwise `404`  |
| `dotfiles`    | `'deny'`                                                                                              | With `root`: `'allow'` to send names starting with a dot (`.env`, `.git/config` answer `404` otherwise) |
| `filename`    | none                                                                                                  | Name proposed to the client; makes the response an `attachment`                                         |
| `disposition` | `attachment` with `filename`, else no header                                                          | `'attachment'` (download) or `'inline'` (display); without `filename` the file name is used             |
| `contentType` | the `Blob` type, else from the extension of `filename` / of the path, else `application/octet-stream` | Media type (text types get `; charset=utf-8`)                                                           |

The response carries `Content-Type`, `Content-Length`, `Accept-Ranges: bytes`, `Last-Modified` and a
strong `ETag` (`"<mtime>-<size>"`, from the modification time and the size; `File` objects use
`lastModified`), and answers:

| Request                                                                     | Response                                                         |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `GET` / `HEAD`                                                              | `200` (`HEAD`: headers only)                                     |
| `If-None-Match` matching (weak comparison) or `If-Modified-Since` not older | `304 Not Modified`, no body                                      |
| `If-Match` not matching, or `If-Unmodified-Since` older                     | `412 Precondition Failed`                                        |
| `Range: bytes=0-499`, `bytes=500-`, `bytes=-500` (single range, `GET`)      | `206 Partial Content` with `Content-Range`                       |
| a range starting after the end                                              | `416 Range Not Satisfiable` with `Content-Range: bytes */<size>` |
| several ranges, another unit, a stale `If-Range`                            | `200` with the whole file (as RFC 9110 allows)                   |
| a missing file, a directory, a path leaving `root`, a dotfile               | `404` `File not found` (the path is never echoed)                |

`Content-Disposition` follows RFC 6266: an ASCII fallback in `filename` and the UTF-8 name in
`filename*` (RFC 8187 / 5987), directory parts and control characters removed:
`attachment; filename="Rapport _t_ 2024.pdf"; filename*=UTF-8''Rapport%20%C3%A9t%C3%A9%202024.pdf`.
`contentDisposition(filename, type?)` builds this header for your own responses,
`contentTypeFor(filename)` looks a type up in the built-in table, `parseRange(header, size)` parses a
`Range` header and `matchesMediaType(type, patterns)` applies `mimeTypes`-like filters.

Files on disk are sent as file-backed blobs (`fs.openAsBlob()`): read lazily as the client receives
them, no descriptor kept open, `sendfile` with the Hono adapter on Bun. The request stays in flight
and its scope open until the file has been sent (or the client went away), so a request-scoped
provider may own the file (a temporary export deleted in `[Symbol.dispose]()`); on `Bun.serve()`
the file is handed to Bun, which opens it at once, and the scope closes then. Headers set with `.withHeader()`
(`cache-control`...), `@Header` and `ctx.setHeader()` are added; a `200` follows the usual status
precedence, `206` / `304` keep theirs.

Returning a `File` / `Blob` directly sends it with its type and size (no `Content-Disposition`,
ranges or validators: use `HttpResponse.file(blob)` for those).

### Streaming responses

`HttpResponse.stream(source, { contentType?, filename?, disposition? })` streams a Web
`ReadableStream`, a Node.js `Readable` or any async iterable (async generator) of `Uint8Array` /
`string` chunks (strings are encoded as UTF-8):

```ts
@Get('/export.csv')
export() {
  const users = this.users
  async function* lines() {
    yield 'id,email\n'
    for await (const user of users.iterate()) yield `${user.id},${user.email}\n`
  }
  return HttpResponse.stream(lines(), { filename: 'users.csv' }) // text/csv; charset=utf-8, attachment
}

@Get('/logs')
logs() {
  return HttpResponse.stream(createReadStream('/var/log/app.log'), { contentType: 'text/plain; charset=utf-8' })
}
```

- **Backpressure**: the source is read only as fast as the client receives the data (on every
  adapter); a slow client never makes the server buffer the whole stream.
- **Cancellation**: when the client disconnects, the source is cancelled (`return()` of the
  iterator — `finally` blocks run —, `destroy()` of a `Readable`, `cancel()` of a Web stream).
- **Request scope**: request-scoped instances live until the stream has been fully sent or
  cancelled, and the source runs in the request scope (`Lazy<HttpContext>`, request-scoped
  providers and tracing contexts keep working while it produces chunks).
- **Errors**: a source failing after the headers were sent cannot change the status: the connection
  is closed (the client sees a truncated response) and the error is logged (`The response stream
  failed`).
- **Shutdown**: streamed responses are in-flight requests: the graceful drain waits for them up to
  `drainTimeoutMs`, then closes their connections (cancelling their sources).

Streams have no `Content-Length` (chunked transfer encoding). Returning a `ReadableStream` or a
`Readable` directly also works (`application/octet-stream`); string, `ArrayBuffer` and typed array
chunks of a returned `ReadableStream` are converted to bytes.

### Large files

Uploaded files are buffered in memory. For files of hundreds of megabytes or more:

1. **Upload directly to object storage (recommended).** The API authorises the upload and returns a
   presigned URL (S3, GCS, Azure Blob, R2...); the client sends the file to the storage, then
   notifies the API. Your servers never carry the bytes; storage handles resumable and multipart
   uploads.

   ```ts
   @Post('/uploads')
   async createUpload(@Body(NewUpload) input: NewUpload) {
     const key = `uploads/${crypto.randomUUID()}`
     const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket, Key: key, ContentType: input.type }), {
       expiresIn: 300,
     })
     return { key, url } // the client PUTs the file to `url`, then calls POST /uploads/:key/complete
   }
   ```

2. **Stream the raw body.** Send the file as the request body (`PUT /files/:name`, `curl -T`) and
   read it with `ctx.bodyStream()`: nothing is buffered, backpressure applies (the request is paused
   while you write), and the body limit of the route still applies (`@BodyLimit`):

   ```ts
   import { createWriteStream } from 'node:fs'
   import { join } from 'node:path'
   import { Readable } from 'node:stream'
   import { pipeline } from 'node:stream/promises'

   @Put('/files/:id')
   @BodyLimit('5gb')
   async store(@Param('id', FileId) id: string, @Ctx() ctx: HttpContext) {
     // never build the path from the client's file name
     await pipeline(Readable.fromWeb(ctx.bodyStream()), createWriteStream(join(UPLOADS_DIR, id)))
     return HttpResponse.created(undefined, `/files/${id}`)
   }
   ```

   `ctx.bodyStream()` reads the body once and is exclusive with `@Body()`, upload parameters,
   `ctx.parseBody()` and `ctx.rawBody()`. A body stream neither read to its end nor cancelled when
   the request is over (a handler that checked the first bytes, then threw) is cancelled: the rest
   of the body is discarded and the keep-alive connection serves the next request. A `multipart/form-data` body read this way is raw: parse
   it with a streaming parser of your choice (e.g. `busboy`) if you must accept huge browser form
   uploads.

3. **Serve large files with `HttpResponse.file()`**: they are streamed from disk, with ranges for
   resumable downloads and video seeking.

### Security

- **Never trust the client's file name.** `File.name` is chosen by the client (it may contain
  `../`, absolute paths, control characters or names of existing files). Do not use it as a path:
  store files under generated identifiers and keep the original name as metadata. When you must
  display or reuse it, `path.basename()` it and limit its characters.
- **Never trust the client's media type.** `File.type` and `mimeTypes` filters rely on what the client
  declares: they reject honest mistakes, not attackers. When the type matters, check the content
  (magic numbers, e.g. with [`file-type`](https://github.com/sindresorhus/file-type)) and decode
  images with a library that re-encodes them.
- **Confine downloads.** Always pass `root` to `HttpResponse.file()` when any part of the path comes
  from the request: `..` segments, absolute paths, encoded separators (`..%2F`), symbolic links
  leaving the directory and dotfiles (`.env`, `.git/`) answer `404`. Without `root`, the path is used
  as given.
- **Store uploads outside of the web root**, never in a directory served statically, and do not serve
  user content inline from your application's origin: send it as an `attachment`, with
  `X-Content-Type-Options: nosniff`, or from a separate domain (an uploaded HTML or SVG file served
  inline runs scripts in your origin).
- **Keep limits tight.** Limits protect memory and CPU: size each route for what it accepts
  (`maxSize`, `maxFiles`, `@BodyLimit`) and lower the plugin defaults if your routes accept less.
  Rate-limit upload routes and consider quotas and malware scanning for untrusted files.

## Server-Sent Events

`@Sse(path?, options?)` declares a `GET` route serving an event stream; its handler returns an
`AsyncIterable`, an `Iterable` or a `ReadableStream` of `SseEvent` (`{ data, event, id, retry,
comment }`). `HttpResponse.sse(source, options?)` does the same on any route and any method (`POST`
streaming for `fetch()` clients). No dependency, identical on every adapter, Node.js and Bun.
Tests read event streams in memory with `injectSse()`: see
[Testing event streams](#testing-event-streams).

```ts
import { setTimeout as sleep } from 'node:timers/promises'
import {
  Body,
  Controller,
  Ctx,
  Headers,
  type HttpContext,
  HttpResponse,
  NotFoundException,
  Param,
  Post,
  Sse,
  type SseEvent,
} from '@znight/http'

@Controller('/orders')
export class OrderEventsController {
  constructor(
    private readonly orders: OrderService,
    private readonly hub: OrderHub,
    private readonly llm: Llm,
  ) {}

  /** 1. Recommended shape: an async method does the pre-flight checks, then returns the source. */
  @Sse('/:id/events', { retry: 5_000, maxDuration: 30 * 60_000 })
  async events(
    @Param('id') id: string,
    @Headers('last-event-id') lastEventId: string | undefined, // sent by EventSource on reconnection
    @Ctx() ctx: HttpContext,
  ): Promise<AsyncIterable<SseEvent<OrderEvent>> | HttpResponse> {
    const order = await this.orders.find(id)
    if (order === undefined) throw new NotFoundException(`Order ${id} not found`) // a regular 404 (EventSource stops)
    if (order.closed) return HttpResponse.noContent() // 204: EventSource stops reconnecting
    return this.hub.subscribe(id, { after: lastEventId, signal: ctx.signal })
  }

  /** 2. An async generator: its body runs once the stream is open (it cannot answer 404 anymore). */
  @Sse('/clock', { heartbeat: false })
  async *clock(@Ctx() ctx: HttpContext): AsyncGenerator<SseEvent<{ now: string }>> {
    while (!ctx.signal.aborted) {
      yield { event: 'tick', data: { now: new Date().toISOString() } }
      await sleep(1_000, undefined, { signal: ctx.signal }).catch(() => undefined)
    }
  }

  /** 3. Any method: LLM-style POST streaming for fetch() clients (EventSource only does GET). */
  @Post('/:id/assistant')
  assistant(@Param('id') id: string, @Body(Prompt) prompt: Prompt, @Ctx() ctx: HttpContext) {
    return HttpResponse.sse(this.llm.complete(id, prompt, { signal: ctx.signal })) // 200, not 201
  }
}
```

**`async` versus `async *`.** The body of an async generator only runs once the 200 and the headers
are sent: pre-flight checks (existence, authorization beyond guards) belong in an `async` method
that _returns_ the source, where it can still throw a 404 or return a 204.

| Handler result (after awaiting)                                | Response                                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `AsyncIterable`, `Iterable` (not a string), `ReadableStream`   | 200 event stream                                                                                 |
| `HttpResponse.sse(...)`                                        | 200 event stream, plus its headers and cookies (its options win over the route's)                |
| Any other `HttpResponse`, a Web `Response`, a thrown exception | Sent as usual: 204 tells `EventSource` to stop, 401 / 404 fail it without reconnection           |
| `undefined`, a string, any other value                         | 500, logged: `@Sse handler C.m must return an AsyncIterable, an Iterable or a ReadableStream...` |

| Option        | Default                        | Description                                                                                        |
| ------------- | ------------------------------ | -------------------------------------------------------------------------------------------------- |
| `heartbeat`   | plugin `sse.heartbeat` (8 000) | Ms without an event after which a keep-alive comment (`:`) is sent (≥ 1 000), `false` to disable   |
| `retry`       | plugin `sse.retry` (none)      | Client reconnection delay sent first (`retry:`, ms)                                                |
| `maxDuration` | none                           | The server ends the stream gracefully after this many ms (≥ 1 000): rebalancing, re-authentication |

`heartbeat` and `maxDuration` (like the plugin's `sse.heartbeat` and `sse.shutdownGraceMs`) are at
most 2 147 483 647 ms (about 24.8 days), the longest timer: a larger delay would fire after 1 ms on
Node.js and Bun (every stream expiring at once), so it is ZNIGHT005 at build time and at boot.

### Events and framing

```ts
interface SseEvent<T = unknown> {
  readonly data?: T // a string is sent as is, anything else through JSON.stringify (toJSON honoured)
  readonly event?: string // event type (addEventListener(type)); the client defaults to `message`. No CR or LF
  readonly id?: string | number // echoed by the client as Last-Event-ID. No CR, LF or NUL; '' resets it
  readonly retry?: number // reconnection delay (ms, integer ≥ 0)
  readonly comment?: string // comment lines, ignored by EventSource
}
```

Each event is encoded as one chunk: one `: <line>` per comment line, `id:`, `event:`, `retry:`, then
one `data: <line>` per line of the data, and an empty line. Data is split on CRLF, CR and LF, so
user content can never inject fields or end an event early; `data: ` always carries its space (a
leading space survives). An event with `event` but no `data` gets an empty `data:` line (otherwise
`EventSource` would not dispatch it: `{ event: 'done' }` would vanish); events with only `id`,
`retry` or `comment` have no data line. Anything else than a plain object with these keys (strings,
numbers, `null`, unknown keys, an empty object, `event` / `id` with line breaks, data JSON cannot
serialise) is a `TypeError`: yield `{ data: value }`. A `Uint8Array` item (a `Buffer` of a Node.js
`Readable`) is written **as is**: already-framed SSE text from an upstream (proxying an LLM
provider), not validated. An event object yielded after raw bytes that do not end at an event
boundary (an empty line) would merge into the unterminated raw event: it fails the stream like an
invalid item. `encodeSseEvent(event)` is exported.

```text
HTTP/1.1 200 OK
content-type: text/event-stream; charset=utf-8
cache-control: no-cache, no-transform
x-accel-buffering: no

retry: 5000

id: 41
event: status
data: {"orderId":"o-1","status":"paid"}

:

data: line 1
data: line 2

retry: 7342

```

(The first chunk, one event, one heartbeat, a multi-line event and the jittered `retry` of a
graceful close.)

**Headers.** `cache-control: no-cache, no-transform` (no caching, no transformation by proxies or
compression middleware) and `x-accel-buffering: no` (nginx) are set first, so `@Header`,
`ctx.setHeader()` and the `HttpResponse` headers can override them; `content-type:
text/event-stream; charset=utf-8` is set last. Never `content-length`, `transfer-encoding` or
`connection: keep-alive`. **Status:** 200; `@HttpCode` on `@Sse` is a build error;
`HttpResponse.sse()` defaults to 200 even on `POST` routes, and honours `@HttpCode` / `.withStatus()`
on other routes (`EventSource` requires 200; `fetch()` clients read any status).

### Lifecycle

- **Open**: the first chunk (`retry: N`, or the comment `:`) is written at once, without touching
  the source, so every adapter flushes the status and headers (`EventSource.onopen` fires before
  the first event).
- **Backpressure**: the source is read once per chunk the client pulls, nothing is read ahead: a
  slow client stops the source, on every adapter. Push-based producers buffer in their own
  structure: use the bounded [`EventChannel`](#eventchannel).
- **Heartbeats**: while the client waits `heartbeat` ms without an event, the comment `:` is sent
  (the pending read of the source is kept). They never pile up for a slow client, are never
  inserted inside raw bytes that do not end at an event boundary, and 8 s is below every common
  idle timeout (`Bun.serve()` 10 s, nginx / ALB 60 s, Heroku 55 s, Cloudflare 100 s).
- **The source ends**: the response ends; `EventSource` then reconnects (that is the protocol). To
  stop a client for good, send an event it understands (`{ event: 'done' }`, then `es.close()`) or
  answer 204 on the next connection.
- **The source fails, or yields an invalid item**: the error is logged (`The SSE stream failed`,
  with `requestId` and `path`), an invalid item stops the source, and the response ends cleanly
  (no extra event: an automatic `event: error` would collide with `EventSource`'s own `error`).
  Unlike `HttpResponse.stream()`, which closes the connection abruptly: SSE events are
  self-delimited and the client reconnects either way.
- **Client disconnect**: `ctx.signal` aborts (`RequestAbortedError`, `kind: 'client'`), the source
  is stopped (`return()` / `cancel()`), and the request scope closes once it stopped, or after 5 s
  with a warning (`The SSE source did not stop within 5000 ms after its signal was aborted: make it
  honour ctx.signal`): an async generator blocked in an `await` that ignores the signal cannot be
  stopped otherwise. A client leaving before the handler returned (an async pre-flight) releases
  the reply the same way, on every adapter and runtime.
- **`maxDuration` and shutdown** (graceful close): `ctx.signal` aborts (`'expired'` /
  `'shutdown'`), the source keeps being read for `sse.shutdownGraceMs` (default 1 000 ms) so that it
  can send final events and finish, then `retry: R` is sent with R drawn in `[r, 2r]` (r = the
  `retry` option, else 3 000 ms; the jitter spreads the reconnections of a rolling deployment), the
  source is stopped and the response ends. When the raw bytes written last do not end at an event
  boundary (a proxied upstream cut mid-event), the `retry` is not sent: the client discards the
  unterminated event at the end of the stream instead of receiving a corrupted one.
- **HEAD** answers the headers only: the stream is cancelled before its first read (an async
  generator body never runs) and `ctx.signal` aborts (`'client'`), which releases a subscription
  made in a pre-flight.
- **Request scope**: request-scoped instances and the in-flight count live until the stream ends;
  the source runs in the handler's async context (`Lazy<HttpContext>`, request-scoped providers,
  tracing). One scope is held per connected client: keep request-scoped state small on SSE routes.
- **Guards, interceptors, mappers**: guards run before the stream (authentication happens when it
  connects: `maxDuration` forces periodic re-authentication); interceptors see the source and may
  wrap it (their `finally` runs when the handler returns); exception mappers only apply before the
  stream starts.
- **Hooks**: `http:request` resolves when the stream opens (`status: 200`): request logs, the
  duration histogram and tracing spans measure the time to open. `plugin.streams` counts the open
  streams (health checks, gauges, a guard capping streams: a 503 would make `EventSource` give up).

**`ctx.signal`** exists on every route, not only SSE: it aborts when the client disconnects before
the response was written, when the response body is cancelled, or when the server closes an event
stream; never after a normal completion (pass it to work that outlives the response). Its reason
is a `RequestAbortedError` (`name: 'AbortError'`, what `fetch` and `node:timers/promises` check)
with `kind: 'client' | 'shutdown' | 'expired'`. Ordinary in-flight requests are not aborted on
shutdown: they drain.

### `EventChannel`

Pull-based sources give real backpressure, but most producers push (a bus, an `EventEmitter`, a
database listener). `EventChannel` is a bounded, single-consumer bridge (generic: a GraphQL
subscription transport or a messaging integration can use it too):

```ts
import { EventChannel, type SseEvent } from '@znight/http'

@Injectable()
export class OrderHub {
  readonly #subscribers = new Map<string, Set<EventChannel<SseEvent<OrderEvent>>>>()
  constructor(private readonly store: OrderEventStore) {}

  subscribe(orderId: string, options: { after?: string; signal: AbortSignal }): AsyncIterable<SseEvent<OrderEvent>> {
    // overflow 'close': a client that falls behind is disconnected; it reconnects with Last-Event-ID
    // and catches up from the store, instead of the server buffering without bound
    const channel = new EventChannel<SseEvent<OrderEvent>>({ capacity: 256, overflow: 'close', signal: options.signal })
    const set = this.#subscribers.get(orderId) ?? new Set()
    this.#subscribers.set(orderId, set.add(channel))
    channel.onClose(() => set.delete(channel))
    for (const missed of this.store.since(orderId, options.after)) channel.push(toSseEvent(missed))
    return channel
  }

  publish(event: OrderEvent): void {
    for (const channel of this.#subscribers.get(event.orderId) ?? []) channel.push(toSseEvent(event))
  }
}
```

| Member                       | Description                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `new EventChannel(options?)` | `capacity` (1 000), `overflow` (`'drop-oldest'`, `'drop-newest'`, `'close'`), `signal` (closes the channel: pass `ctx.signal`) |
| `push(item)`                 | Buffers an item; `false` when it was dropped or the channel is closed                                                          |
| `close()` / `fail(error)`    | Ends the iteration (or makes it throw) after the buffered items                                                                |
| `onClose(listener)`          | Called once when the channel closes (close, fail, overflow, signal, consumer `return()`)                                       |
| `size`, `closed`             | Buffered items, state                                                                                                          |
| `[Symbol.asyncIterator]()`   | Single consumer; `return()` closes the channel and resolves at once, even while `next()` waits                                 |

A pending `next()` resolves with `{ done: true }` as soon as the channel closes, so an SSE handler
built on a channel always stops when its client leaves. Channels are in-process: fan-out across
instances (Redis, NATS...) is application code.

### Proxies, compression and timeouts

| Concern                               | What Znight does                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Headers not flushed, proxy buffering  | The first chunk is written at once; `x-accel-buffering: no` (nginx)                                                                                                                                                                                                                                                                    |
| Caching proxies, CDNs                 | `cache-control: no-cache, no-transform`. Cloudflare streams `text/event-stream`; its 100 s idle limit is covered by heartbeats                                                                                                                                                                                                         |
| Compression middleware                | `no-transform` is honoured by Express `compression()` and `hono/compress` (which also skips `text/event-stream`). Fastify sends event streams through `reply.hijack()`: no `onSend` hook (`@fastify/compress`, ETag) ever touches them; headers set by `onRequest` hooks are kept                                                      |
| Hand-written and proxied streams      | Any streamed `text/event-stream` body (`return fetch(upstream)`, `HttpResponse.stream(body, { contentType: 'text/event-stream' })`) is sent as an event stream: headers at once (even before a quiet stream's first byte, on Fastify too), no socket timeout, no `onSend` hook. `@Sse` adds the framing, heartbeats and graceful close |
| `Bun.serve()` `idleTimeout` (10 s)    | `honoAdapter().listen()` lifts it while the stream is sent. With `adapter.fetch` in your own `Bun.serve()`, keep `heartbeat` below `idleTimeout` (the 8 s default does)                                                                                                                                                                |
| Node.js socket timeouts               | `server.timeout` / `setTimeout()` / Fastify `connectionTimeout` (and Bun's `node:http` emulation) never cut a quiet event stream: the adapters call `response.setTimeout(0)` for it                                                                                                                                                    |
| HTTP/1.1 browser limit (6 per origin) | Serve HTTP/2 at the edge, or multiplex topics on one stream. Nothing connection-specific is sent: streams work through h2 proxies                                                                                                                                                                                                      |

**Credentials.** `EventSource` cannot send an `Authorization` header and tokens in the query string
leak into logs: authenticate event streams with a cookie (`new EventSource(url, { withCredentials:
true })` cross-origin, with [CORS](#cors)) or a short-lived, single-use stream ticket.
`Last-Event-ID` is client input: coerce or validate it, never trust it as an authorization
boundary.

**GraphQL over SSE.** Nothing here is GraphQL-specific, but the primitives a "distinct connections"
transport needs are there: `HttpResponse.sse()` on `POST`, free-form event names (`next`,
`complete` with `data: ''`), ordered streams stopped through `return()` and `ctx.signal`, and
`EventChannel` for PubSub engines.

## Errors

Throw an `HttpException` (or a subclass) anywhere — handler, guard, interceptor, service:

```ts
throw new HttpException(409, 'Email already used', { field: 'email' })
throw new NotFoundException(`User ${id} not found`)
throw new UnauthorizedException('Token expired', undefined, { headers: { 'www-authenticate': 'Bearer' } })
```

```json
{ "statusCode": 409, "error": "Conflict", "message": "Email already used", "details": { "field": "email" } }
```

Constructor: `new XxxException(message?, details?, { headers?, cause? })` (`HttpException` takes
the status first). Override `toBody()` in a subclass to change the shape.

| Class                           | Status | Class                          | Status |
| ------------------------------- | ------ | ------------------------------ | ------ |
| `BadRequestException`           | 400    | `UnprocessableEntityException` | 422    |
| `ValidationException`           | 400    | `TooManyRequestsException`     | 429    |
| `UnauthorizedException`         | 401    | `InternalServerErrorException` | 500    |
| `ForbiddenException`            | 403    | `NotImplementedException`      | 501    |
| `NotFoundException`             | 404    | `BadGatewayException`          | 502    |
| `MethodNotAllowedException`     | 405    | `ServiceUnavailableException`  | 503    |
| `ConflictException`             | 409    | `GatewayTimeoutException`      | 504    |
| `GoneException`                 | 410    | `PayloadTooLargeException`     | 413    |
| `UnsupportedMediaTypeException` | 415    |                                |        |

Any other error answers `{ "statusCode": 500, "error": "Internal Server Error" }` — the message is
hidden unless `exposeErrors: true` (development) — and is logged with the request id, route and
handler. So does a response header that cannot be sent (a CR/LF or a character above `\xff` in a
value, set with `ctx.setHeader()` or a redirect to a client-provided URL), identically on every
adapter: the body is discarded and the error logged. `5xx` exceptions are logged too. Every error is also recorded on the
[`http:request` event](#hooks-and-observability).

### Exception mappers

Convert errors (domain errors, ORM errors...) to responses. Mappers run in order for every error of
the pipeline, including `404`/`405`; the first one returning something wins:

```ts
@Injectable()
export class DomainErrorMapper implements ExceptionMapper {
  map(error: unknown, ctx: HttpContext) {
    if (error instanceof UserNotFoundError) return new NotFoundException(error.message) // default body
    if (error instanceof ValidationException) return new HttpResponse({ errors: error.issues }, { status: 422 })
    if (error instanceof RateLimitError) return new Response('slow down', { status: 429 })
    return undefined // next mapper, then the default rendering
  }
}

HttpPlugin.configure({ exceptionMappers: [DomainErrorMapper] })
```

A mapper that throws is logged and skipped.

## Guards

A guard decides whether a request reaches the handler. Global guards (plugin options) run first,
then controller guards, then route guards. Returning anything but `true` answers
`403 Forbidden`; throw an `HttpException` for another status.

```ts
// access.ts: one decision per route, every route must have one
export const Public = createRouteDecorator('public', { group: 'access', required: true })
export const Authenticated = createRouteDecorator('authenticated', { group: 'access', required: true })
export const Roles = createRouteDecorator<readonly Role[]>('roles', { group: 'access', required: true })

@Injectable()
export class AuthGuard implements CanActivate {
  /** Read by HttpPlugin at boot: every route needs a guard enforcing the "access" group. */
  static readonly enforces = [Public, Authenticated, Roles]

  constructor(private readonly tokens: TokenService) {}

  async canActivate(ctx: HttpContext): Promise<boolean> {
    if (Public.get(ctx)) return true
    const user = await this.tokens.verify(ctx.header('authorization'))
    if (user === undefined) throw new UnauthorizedException()
    ctx.state.set('user', user)
    const roles = Roles.get(ctx)
    if (roles !== undefined) return roles.some(role => user.roles.includes(role))
    return Authenticated.get(ctx) === true // no decision: denied
  }
}

@Controller('/admin')
@Roles(['admin']) // the decision of every route of the controller...
export class AdminController {
  @Get('/health')
  @Public() // ...unless the route has its own decision of the group
  health() {
    return 'ok'
  }
}

HttpPlugin.configure({ guards: [AuthGuard] })
```

`decorator.get(ctx)` reads the route metadata (`ctx.route.meta`) with its type. Guards,
interceptors and mappers are providers: they may be request-scoped (resolved per request) and have
dependencies. Plugin options also accept instances (`guards: [new IpAllowList(['10.0.0.0/8'])]`).

## Route decisions

`createRouteDecorator(key, { group, required })` makes route metadata safe to use for access
control:

- **Decorators of a group are alternatives.** A route (or a controller) has at most one decision
  per group: `@Public() @Roles(['admin'])` on one method is ZNIGHT005 at build time.
- **The nearest decision wins.** The effective metadata of a route (`ctx.route.meta`,
  `decorator.get(ctx)`) is made of the controller's entries whose group the route does not decide,
  then the route's entries. `@Public()` on a controller and `@Roles(['admin'])` on one of its
  routes give `{ roles: ['admin'] }` for that route: the route is not public. A decorator without
  `group` is its own group (the route value wins over the controller value, key by key).
- **Every route has a decision of each `required` group, checked at build time.** A route without
  one, neither on itself nor on its controller, is **ZNIGHT023** — including routes of an
  application that defines the decorators of a required group without applying them yet:

  ```
  ✗ ZNIGHT023: Route DELETE /books/:id (BookController.remove) has no "access" decision
    --> src/books/book.controller.ts:104:3
    = hint: Add @Public(), @Authenticated() or @Roles(...) to the route or to BookController
    = related: The "access" group is required (src/auth/access.ts:5:14)
  ```

- **Every decision is enforced, checked at boot.** Guards declare the decorators whose decisions
  they enforce (`static enforces = [Public, Authenticated, Roles]`, typed `readonly
  RouteDecoratorInfo[]`, see `GuardClass`). When `HttpPlugin` registers the routes, each route
  whose decision belongs to a required group, or to a group some guard enforces, must have a guard
  enforcing that group in its chain (global, controller or route guards). Otherwise the boot fails
  with one ZNIGHT023 listing every route, by group. "Some guard" is any guard class of the
  application, registered in a chain or not: a forgotten `guards: [AuthGuard]` or
  `guards: [RateLimitGuard]` in a second entrypoint or a test fails the boot, for required groups
  and for groups such as `@RateLimit` alike, with a hint naming the guards that enforce the group.
  A guard class registered nowhere only makes its groups known; a required group is known at boot
  through the compiled metadata and the `enforces` of the guards of the chains (an auth package
  shared between services). Plugin routes are checked too.

  ```
  ZNIGHT023: HttpPlugin: No guard enforces the required "access" group on 9 routes: GET /books (BookController.list), ...
    hint: Register a guard declaring `static enforces` with the decorators of the "access" group (authenticated, public, roles), e.g. HttpPlugin.configure({ guards: [AuthGuard] })
  ```

  The class whose `enforces` counts is the compiled class of controller and route guards (a guard
  replaced through `overrides` in a test keeps its declaration), the class or the
  `instance.constructor` of global guards. A test that deliberately runs without guards sets
  `enforcement: 'warn'` (one warning per group instead of the error).

- All the definitions of a key must use the same options, and the decorators of a group must agree
  on `required` (ZNIGHT005 at build time; at boot for contradicting `enforces`). Route decorators
  without options behave as before: the key is any non-empty string (`'auth:public'`,
  `'app/roles'`), and a decorator without `group` is its own group, named after its key. An explicit
  `group` is a letter followed by letters, digits, `_`, `.` or `-` (ZNIGHT005 at build time, a
  `TypeError` where the decorator is created).

`HttpPlugin.routes` lists the effective `meta` and the `guards` (display names, chain order) of
every route: snapshot it in a test to review access changes in pull requests.

```ts
test('access matrix', async () => {
  await using app = await createTestApp()
  const matrix = app
    .get(HttpPlugin)
    .routes.filter(route => route.method !== 'HEAD')
    .map(route => `${route.method} ${route.path} ${JSON.stringify(route.meta)} [${route.guards.join(', ')}]`)
  expect(matrix).toMatchSnapshot()
})
```

`decorator.meta(value?)` gives the same metadata as data (`{ key, value, group, required }`) for
routes that are not compiled controllers: [plugin routes](#plugin-routes) such as
`OpenApiPlugin.configure({ meta: [Public.meta()] })`.

## CORS

```ts
HttpPlugin.configure({
  cors: {
    origin: ['https://app.example.com', /^https:\/\/[a-z0-9-]+\.preview\.example\.com$/],
    credentials: true,
  },
})
```

| Option          | Default                      | Description                                                                                      |
| --------------- | ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `origin`        | required                     | `'*'`, an origin, an anchored `RegExp`, a list of them, or `(origin) => boolean \| Promise<...>` |
| `credentials`   | `false`                      | `access-control-allow-credentials: true` (cookies, `authorization`); refused with `'*'`          |
| `methods`       | the methods of the path      | `access-control-allow-methods` of preflights; `'*'` is refused with `credentials`                |
| `allowHeaders`  | the headers the browser asks | `access-control-allow-headers` of preflights, or `'*'` (refused with `credentials`)              |
| `exposeHeaders` | the request id header        | `access-control-expose-headers` of replies; `'*'` is refused with `credentials`                  |
| `maxAge`        | `600`                        | `access-control-max-age` of preflights, seconds (0 to 86400)                                     |

The options are validated at boot (ZNIGHT005): an origin must be written exactly as browsers send
it (`https://app.example.com`: no path, no trailing slash, no default port), `'null'` is refused,
a `RegExp` must be anchored with `^` and `$` around every alternative and have no `g` / `y` flag.
With `credentials: true`, `'*'` is refused in `methods`, `allowHeaders` and `exposeHeaders`:
browsers read it literally on credentialed requests (a method or header named `*`). Without
credentials it is a wildcard, except that it never covers `Authorization` (Fetch rule): with
`allowHeaders: '*'`, a preflight asking for `authorization` gets
`access-control-allow-headers: *, authorization`.

Behaviour, identical on every adapter:

- **Preflights** (`OPTIONS` with `origin` and `access-control-request-method`) are answered by the
  pipeline inside the `http:request` hook (logs, metrics and traces see them) and **never run
  guards, interceptors or handlers**, even when an `@Options` or `@All` route matches: `204` with
  the CORS headers, `allow` and `vary`; `403 CORS origin not allowed` for a denied origin; `404`
  for a path without route (both without CORS headers).
- **Other replies to an allowed origin** get `access-control-allow-origin`,
  `access-control-allow-credentials` and `access-control-expose-headers` unless the handler, an
  interceptor, a mapper or a hook wrapper set them: 2xx, guard 401 / 403, 404, 405, 413, 500,
  automatic `OPTIONS` and redirects alike. `@Res()` raw replies are the only exception.
- **A denied origin** is served normally, without CORS headers: CORS protects what a page may read,
  it is not access control (use a guard).
- **A wildcard policy** (`'*'`, alone or in a list) adds `access-control-allow-origin: *` (and
  `access-control-expose-headers`) to every reply, whether the request has an `origin` header or
  not: the reply does not depend on the origin, so a cached reply serves CORS and non-CORS requests
  alike.
- Other policies merge `vary: origin` into every reply, for shared caches.
- An origin function that throws or rejects denies the origin (logged at `error` level).

With Fastify, Express or Hono, use either this option or the native CORS middleware, not both.

## Security headers

On by default, added to every reply that does not set them (`@Res()` raw replies excepted):

| Option                      | Header                         | Default                                                                                             |
| --------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `contentSecurityPolicy`     | `content-security-policy`      | `default-src 'none'; frame-ancestors 'none'`                                                        |
| `frameOptions`              | `x-frame-options`              | `'DENY'` (or `'SAMEORIGIN'`)                                                                        |
| `noSniff`                   | `x-content-type-options`       | `true` (`nosniff`)                                                                                  |
| `referrerPolicy`            | `referrer-policy`              | `'no-referrer'`                                                                                     |
| `hsts`                      | `strict-transport-security`    | `false`; `true`: `max-age=31536000; includeSubDomains`; or `{ maxAge, includeSubDomains, preload }` |
| `crossOriginResourcePolicy` | `cross-origin-resource-policy` | `false` (`'same-origin'`, `'same-site'`, `'cross-origin'`)                                          |
| `cacheControl`              | `cache-control`                | `false` (`'no-store'` for APIs serving personal data)                                               |

```ts
HttpPlugin.configure({ securityHeaders: { hsts: true, cacheControl: 'no-store' } }) // merged over the defaults
HttpPlugin.configure({ securityHeaders: false }) // none
```

The defaults are safe for APIs: the CSP blocks a stored XSS through an uploaded HTML or SVG file
served by `HttpResponse.file()` and changes nothing for JSON. Every header loses to one set by the
handler (`@Header`, `ctx.setHeader`, `HttpResponse`), an interceptor, an exception or a hook
wrapper: a route serving an HTML page sets its own `content-security-policy`. HSTS normally belongs
to the TLS terminator. Values are validated at boot (ZNIGHT005).

## Behind a proxy

```ts
HttpPlugin.configure({ trustProxy: 1 }) // one load balancer in front of the server
HttpPlugin.configure({ trustProxy: ['loopback', '10.0.0.0/8'] }) // the addresses of the proxies
```

`trustProxy` (default `false`) gives a correct `ctx.ip` and `ctx.protocol` behind load balancers,
the same way on every adapter. Both forms walk `[socket peer, ...x-forwarded-for from right to
left]`:

- a **number** of hops (an integer ≥ 1): the client is the entry at that index, or the leftmost one
  when the list is shorter;
- a **list** of IPv4 / IPv6 addresses, CIDR ranges and the aliases `'loopback'` (127.0.0.0/8,
  ::1), `'private'` (10/8, 172.16/12, 192.168/16, fc00::/7) and `'linklocal'` (169.254/16,
  fe80::/10): the walk continues while the addresses are trusted; the first untrusted one is the
  client (or the leftmost entry when all are trusted).

IPv4-mapped IPv6 addresses are normalised (`::ffff:10.0.0.1` → `10.0.0.1`), and a malformed entry
stops the walk at the last valid address. When the socket peer is trusted, `ctx.protocol` is the
leftmost `x-forwarded-proto` (`http` or `https` only); otherwise it is the protocol of the
connection. `true` is refused (ZNIGHT005): trusting every hop would let any client choose its
`ctx.ip`. Without the option, `ctx.ip` is the adapter's address, so the proxy settings of Fastify
(`trustProxy`) and Express (`trust proxy`) still apply. The `Forwarded` header (RFC 7239) is not
read.

## Interceptors

Interceptors wrap the handler after the guards: global → controller → route, the first one being
the outermost. `next()` resolves with the handler result (before serialisation):

```ts
@Injectable()
export class TimingInterceptor implements HttpInterceptor {
  async intercept(ctx: HttpContext, next: CallHandler) {
    const started = performance.now()
    try {
      return await next() // or transform the result, or return something else without calling next()
    } finally {
      ctx.setHeader('server-timing', `app;dur=${(performance.now() - started).toFixed(1)}`)
    }
  }
}
```

## The request context

`HttpContext` is adapter-neutral. Use it with `@Ctx()`, in guards, interceptors and mappers, or
inject it in request-scoped providers.

| Member                                             | Description                                                                                                                             |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `requestId`                                        | Incoming `x-request-id` (when valid) or a generated UUID                                                                                |
| `method`, `url`, `path`                            | Upper-case method, raw target (`/a%20b?x=1`), raw path                                                                                  |
| `params`                                           | Decoded route parameters (`'*'` for the wildcard)                                                                                       |
| `query`                                            | Parsed query, repeated keys as arrays (parsed on first access)                                                                          |
| `headers`, `header(name)`                          | Request headers (lower-case names)                                                                                                      |
| `body`, `parseBody()`, `rawBody()`                 | Parsed body ([when](#request-bodies)), lazy parsing, raw bytes                                                                          |
| `files`                                            | Files of a multipart body by field (`Record<string, File[]>`)                                                                           |
| `bodyStream()`                                     | The body as a Web stream, nothing buffered ([Large files](#large-files))                                                                |
| `route`                                            | `{ method, path, controller, handler, meta }` (effective metadata, see [Route decisions](#route-decisions)), `undefined` for 404/405    |
| `state`                                            | `Map` shared by guards, interceptors and handlers                                                                                       |
| `setHeader()`, `appendHeader()`, `responseHeaders` | Response headers, also sent with errors                                                                                                 |
| `cookies`, `signedCookie(name)`                    | Request cookies (parsed on first access), the verified value of a signed cookie ([Cookies](#cookies))                                   |
| `setCookie()`, `clearCookie()`, `responseCookies`  | Response cookies, also sent with errors; validated at call time                                                                         |
| `signal`                                           | Aborted when the client leaves or an event stream is closed by the server, never after a normal completion ([`ctx.signal`](#lifecycle)) |
| `request`, `response`                              | Native objects of the adapter                                                                                                           |
| `adapter`                                          | Adapter name                                                                                                                            |
| `ip`, `protocol`                                   | Client address and `'http'` / `'https'` ([Behind a proxy](#behind-a-proxy))                                                             |

Each request runs in a container scope seeded with `HttpContext` and `RequestId`:

```ts
@Injectable({ scope: 'request' })
export class CurrentUser {
  constructor(ctx: HttpContext, requestId: RequestId) {}
}

@Injectable() // a singleton reading the current request lazily
export class AuditService {
  constructor(private readonly ctx: Lazy<HttpContext>) {}
  record(action: string) {
    log(action, this.ctx.get().requestId)
  }
}
```

Request-scoped instances are disposed when the response has been sent: for a streamed or file
body, once it has been fully sent or cancelled (client disconnected), so stream producers can use
them and files they own are still there (on `Bun.serve()`, a file is handed to Bun, which opens it,
first).

## Hooks and observability

Every request — matched or not — runs through `hooks.run('http:request', event, ...)` (the event
type, `HttpRequestEvent`, lives in `@znight/core`). Wrappers see the final `status` and `error`
before `run` resolves; listeners (`hooks.on`) are called once the response is computed.

| Field             | Description                                                  |
| ----------------- | ------------------------------------------------------------ |
| `method`, `path`  | Request method and raw path                                  |
| `route`           | Route pattern (`/api/users/:id`), `undefined` for 404/405    |
| `requestId`       | Request id                                                   |
| `headers`         | Request headers                                              |
| `context`         | The `HttpContext`                                            |
| `startTime`       | `performance.now()` when the request started                 |
| `status`, `error` | Set before `run` resolves (`error`: what the pipeline threw) |
| `responseHeaders` | Headers to add to the response (trace context...)            |

```ts
app.hooks.wrap('http:request', async (event, next) => {
  await next()
  histogram.observe({ route: event.route ?? 'unmatched', status: event.status }, performance.now() - event.startTime)
})
```

`@znight/observability` uses this hook for request logs, RED metrics and tracing. For an event
stream, `run` resolves when the stream opens (`status: 200`): durations measure the time to open.
A stream-lifetime hook is not provided.

When no `http:request` wrapper or listener is registered (and CORS is off), routes (other than
`@All`) without guards, interceptors, `@Sse`, `@Res()` or `@Header` take a fast lane: the plugin
decides at boot what the pipeline would do for them, runs a synchronous handler without creating a
promise and builds the headers of a JSON reply from a template. The replies are the same as through
the full pipeline (a thrown error, an `HttpResponse` or anything unusual continues there, in the
same request scope; a promise is awaited first); registering a hook simply sends every request
through the full pipeline again.

## Plugin options

`HttpPlugin.configure(options)` — `options` may also be a function of the container, evaluated
once at bootstrap: `HttpPlugin.configure(c => ({ port: c.get(AppConfig).port }))`.

| Option              | Default               | Description                                                                                                        |
| ------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `adapter`           | `nodeAdapter()`       | Server implementation                                                                                              |
| `port`              | `3000`                | Port (`0`: a free port, see `plugin.address`)                                                                      |
| `host`              | `0.0.0.0`             | Interface to bind                                                                                                  |
| `prefix`            | —                     | Static path prefixed to every route (`/api`)                                                                       |
| `guards`            | `[]`                  | Global guards: provider classes or instances                                                                       |
| `interceptors`      | `[]`                  | Global interceptors (outermost first)                                                                              |
| `exceptionMappers`  | `[]`                  | Exception mappers, tried in order                                                                                  |
| `trailingSlash`     | `'strict'`            | `'strict'`, `'ignore'` or `'redirect'`                                                                             |
| `exposeErrors`      | `false`               | Send the message of unexpected errors in 500 responses                                                             |
| `bodyLimit`         | `1048576`             | Maximum body size: bytes or `'10mb'` (see [Limits](#limits); routes: `@BodyLimit`)                                 |
| `uploads`           | see [Limits](#limits) | `{ maxFileSize, maxFiles, maxParts, maxFieldSize }` of multipart bodies                                            |
| `requestIdHeader`   | `x-request-id`        | Header read (when ≤ 128 chars of `[A-Za-z0-9_-.:@/+=]`) and echoed; `false` to always generate                     |
| `generateRequestId` | `randomUUID`          | Request id generator                                                                                               |
| `drainTimeoutMs`    | `4000`                | Maximum wait for in-flight requests on shutdown (keep it below `shutdown.hookTimeoutMs`; `Infinity`: no own limit) |
| `cors`              | off                   | [CORS](#cors) policy: `{ origin, credentials?, methods?, allowHeaders?, exposeHeaders?, maxAge? }`                 |
| `securityHeaders`   | `true`                | [Security headers](#security-headers): `true`, `false` or settings merged over the defaults                        |
| `trustProxy`        | `false`               | [Trusted proxies](#behind-a-proxy): a number of hops or addresses / CIDR ranges / aliases                          |
| `enforcement`       | `'error'`             | [Route decisions](#route-decisions) not enforced by a guard: `'error'` fails the boot, `'warn'` logs               |
| `cookies`           | —                     | `{ secrets?, defaults? }`: [signing keys](#signed-cookies) (≥ 32 bytes, the first signs) and cookie defaults       |
| `sse`               | see below             | `{ heartbeat?, retry?, shutdownGraceMs? }`: [Server-Sent Events](#server-sent-events) defaults                     |

`sse.heartbeat` defaults to 8 000 ms (an integer ≥ 1 000, or `false`), `sse.retry` to none and
`sse.shutdownGraceMs` (the time an event source gets to finish on shutdown or `maxDuration`) to
1 000 ms; it must be lower than `drainTimeoutMs`. `cookies.defaults` is merged over
`{ path: '/', secure: true, httpOnly: true, sameSite: 'lax' }`. Invalid values, and unknown keys in
`cookies`, `cookies.defaults` and `sse`, fail the boot (ZNIGHT005).

The plugin instance (`app.getPlugin<HttpPlugin>('http')`, or injected as `HttpPlugin`) exposes
`address` (`{ host, port, family, url }`, `String(address)` is the URL; `undefined` when not
listening), `inject(request)`, `injectStream(request)`, `injectSse(request)` (see
[Testing](#testing)), `routes`, `adapter`, `inflight`, `streams` (open event streams),
`signCookie(name, value)`, `prefix` and `initRoots()`.

`routes` lists every registered route (HEAD and trailing-slash variants included):
`{ method, path, controller, handler, source, meta, guards }`, where `source` is `'controller'` or
the name of the plugin declaring a [plugin route](#plugin-routes), `meta` the effective metadata
and `guards` the display names of the guard chain (global, controller, route).

`prefix` is the resolved `prefix` option (`''` or `/api`), for plugins that serve routes or publish
URLs. It is readable at any time when the options are an object; when they are a function of the
container, from the `onBootstrap` of any plugin (before or after `HttpPlugin`'s): the options are
resolved once per application.

`initRoots()` lists the provider classes the plugin resolves at bootstrap although no compiled
metadata references them: the classes of `guards`, `interceptors` and `exceptionMappers` (instances
are left out), in that order. It returns `[]` when the options are a function of the container (they
are only evaluated at bootstrap) and never throws (invalid options are reported by `onBootstrap`).
A boot restricted with `init: { only }` must include them when they, or their dependencies, have an
async factory (an async factory cannot run on demand); `TestApp` from `@znight/testing` adds them
by itself:

```ts
const http = HttpPlugin.configure({ port: 0, guards: [AuthGuard] }) // AuthGuard needs the async JwksStore
const app = await Application.create({
  metadata,
  plugins: [http],
  init: { only: [UserController, ...http.initRoots()] },
})
```

## Plugin routes

Another plugin can ask `HttpPlugin` to serve routes (documentation, status or metrics endpoints) by
implementing `PluginHttpRoutes`. They are registered on every adapter in the same pipeline as the
controllers, whatever the plugin order:

```ts
export class StatusPlugin implements Plugin, PluginHttpRoutes {
  readonly name = 'status'

  httpRoutes({ prefix, container }: PluginHttpRoutesContext): readonly PluginRoute[] {
    return [
      {
        method: 'GET',
        path: '/status', // relative to the HttpPlugin prefix, controller path grammar
        name: 'status', // handler name in HttpPlugin.routes, logs and errors
        handler: ctx => ({ up: true }), // (ctx: HttpContext) => result, serialised like a controller result
        meta: [Public.meta()], // route metadata: read by guards, checked by the route decision check
        guards: [], // extra guards (classes or instances)
      },
    ]
  }
}
```

- `httpRoutes()` is called once in `HttpPlugin.onBootstrap`, after `container.init()` and after the
  compiled routes, with the prefix and the container.
- A request to a plugin route runs the `http:request` hook in a request scope, the global guards,
  then the route `guards`, the handler and the exception mappers. Global interceptors do not wrap
  plugin routes (a response envelope would break a document). The body is read lazily
  (`ctx.parseBody()`). `GET` routes answer `HEAD`; `ALL` works as for controllers.
- `meta` entries (`decorator.meta(value)`, one per group) are the route metadata. A required group
  needs a decision there too: without one the boot fails (ZNIGHT023), with a hint naming the plugin.
- An invalid route (method, path grammar, name, handler, meta) or a collision with another route is
  ZNIGHT007 naming the plugin. `HttpPlugin.routes` lists the routes with `source: '<plugin name>'`.

## Adapters

All adapters share the same pipeline, so responses (bodies, errors, statuses, HEAD, 404/405,
trailing slashes) are identical. They differ in their native objects and integrations.

### `nodeAdapter()` — built-in (`@znight/http` or `@znight/http/node`)

Zero dependencies, `node:http` (works on Bun). Router: a segment trie (static > `:param` > `*`,
with backtracking).

| Option          | Description                                                             |
| --------------- | ----------------------------------------------------------------------- |
| `serverOptions` | Options of `http.createServer()` (`requestTimeout`, `maxHeaderSize`...) |
| `server`        | An existing server (e.g. `https.createServer({ key, cert })`)           |

`adapter.handler` is a request listener you can mount in a server you manage. `inject()` needs the
optional peer `light-my-request`.

### `fastifyAdapter()` — `@znight/http/fastify`

```sh
bun add fastify
```

```ts
import { fastifyAdapter } from '@znight/http/fastify'

HttpPlugin.configure({ adapter: fastifyAdapter({ options: { trustProxy: true } }) })

// or with your instance (plugins, hooks, native routes)
const instance = Fastify()
await instance.register(helmet)
HttpPlugin.configure({ adapter: fastifyAdapter({ instance }) })
```

| Option     | Description                                                                    |
| ---------- | ------------------------------------------------------------------------------ |
| `instance` | An existing Fastify instance (plugins, hooks, native routes)                   |
| `options`  | Options of the instance created otherwise (`trustProxy`, `https`, timeouts...) |

Znight routes are registered in an encapsulated context with their own body handling and 404
handler, so your other routes keep Fastify's parsers. A `content-type` Fastify cannot parse (`foo`,
an empty one) never reaches Fastify's parsers for Znight routes, which then answer like on the other
adapters instead of Fastify's `415`.

Znight parses bodies itself, so a Znight route that no other hook needs is served straight from the
`onRequest` hook of its context: Fastify skips its content type parsing and the steps before the
handler, and a text reply is written on the raw response exactly as `reply.send()` writes it. Your
hooks always run: with a `preParsing`, `preValidation` or `preHandler` hook (or an `onRoute` hook
wrapping the handler, a schema, a subscriber of the `fastify.request.handler` tracing channel), the
request goes through Fastify's whole lifecycle; with an `onSend` or `onResponse` hook, or headers
and trailers set by an `onRequest` hook, the reply goes through `reply.send()`. The adapter reads
these hooks on Fastify's internal route and reply state: should a Fastify release change it, every
request goes through the lifecycle (slower, same responses). Created instances use
`exposeHeadRoutes: false` (Znight serves HEAD), a `maxParamLength` of 8 KiB and a
`frameworkErrors` handler rendering Znight errors (with your own instance, malformed URLs are
answered by Fastify). `inject()` uses `fastify.inject()`. Event streams are sent through
`reply.hijack()`: `onSend` hooks (compression, ETag plugins) never touch them, and the headers your
hooks already set (`onRequest`, helmet) are kept under Znight's (their cookies before Znight's).

### `expressAdapter()` — `@znight/http/express`

```sh
bun add express light-my-request # light-my-request for inject()
```

```ts
import { expressAdapter } from '@znight/http/express'

const app = express()
app.use(cors())
HttpPlugin.configure({ adapter: expressAdapter({ app }) })
```

| Option   | Description                                                           |
| -------- | --------------------------------------------------------------------- |
| `app`    | An existing application: its middleware runs before the Znight routes |
| `server` | The server to listen with (e.g. `https.createServer({ key, cert })`)  |

Routes live on a dedicated router (`adapter.router`) mounted after your middleware. Do not add
body parsers for Znight routes (Znight reads the body itself): a body already read by a parser
(`app.use(express.json())`) answers `500` with an explicit log entry instead of an empty body.

### `honoAdapter()` — `@znight/http/hono`

```sh
bun add hono
bun add @hono/node-server # on Node.js only
```

```ts
import { honoAdapter } from '@znight/http/hono'

HttpPlugin.configure({ adapter: honoAdapter() })
```

On Bun the server is `Bun.serve()`; on Node.js, `@hono/node-server`. Pass `app` (an existing
`Hono` instance) to add Hono middleware (Znight sets its `notFound` and `onError` handlers);
`adapter.fetch` is the Fetch handler of the application. `inject()` uses
`app.request()`. Cookies a middleware sets before the Znight route (`setCookie(c, ...)`) are kept,
before Znight's; other headers set with `c.header()` before `next()` follow Hono's rules for a
handler returning its own `Response`.

| Option         | Description                                                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `app`          | An existing `Hono` application                                                                                                |
| `serveOptions` | Options of `Bun.serve()` (`tls`, `idleTimeout`, `development`, `error`...; Znight sets `port`, `hostname`, `fetch`). Bun only |

On Bun, the body limits are Znight's (`bodyLimit`, `@BodyLimit`): `maxRequestBodySize` defaults to
unlimited instead of Bun's 128 MiB. A body with a `Content-Length` is read at once
(`request.bytes()`, refused with 413 before reading when the length is above the limit), a chunked
one as a stream (413 as soon as it passes the limit). Bun's `idleTimeout` (10 s by default) still closes idle
connections and stalled requests, but is lifted while a streamed response is sent (SSE, slow
producers), then restored. In your own `Bun.serve({ fetch: adapter.fetch })` the adapter cannot
lift it: keep the SSE `heartbeat` below `idleTimeout` (the 8 s default does).

`Bun.serve()` sends streamed bodies with chunked transfer encoding even when a `Content-Length`
header is set (unless the whole stream is available at once): files sent with
`HttpResponse.file()` and `Blob` / `File` results are handed to Bun as blobs, with their length
(`sendfile`), when the `Response` reaches Bun with its body (a Hono middleware replacing the body
gets the stream). With `adapter.fetch` (your own server), they are streams.

`Bun.serve()` gives the adapter the WHATWG-normalised URL only: dot segments are resolved before
routing (`/files/%2e%2e/x` is `/x`), unlike the other adapters. On Node.js the raw request target is
used.

### Optional peer dependencies

| Package             | Needed for                                        |
| ------------------- | ------------------------------------------------- |
| `fastify`           | `@znight/http/fastify`                            |
| `express`           | `@znight/http/express`                            |
| `hono`              | `@znight/http/hono`                               |
| `@hono/node-server` | `@znight/http/hono` on Node.js                    |
| `light-my-request`  | `inject()` with the `node` and `express` adapters |

## Testing

`plugin.inject()` sends a request in memory through the adapter's routing and the whole pipeline,
without listening (`@znight/testing`'s `TestApp.inject()` delegates to it, and `TestApp.create()`
creates the global guards, interceptors and mappers listed by
[`initRoots()`](#plugin-options) at boot):

```ts
const http = HttpPlugin.configure({ port: 0 })
const app = await Application.create({ metadata, plugins: [http], overrides: [[UserRepository, fakeRepository]] })

const response = await http.inject({ method: 'POST', url: '/users', body: { name: 'Ada', email: 'ada@example.com' } })
expect(response.status).toBe(201)
expect(response.json()).toEqual({ id: 1, name: 'Ada', email: 'ada@example.com' })
```

`InjectRequest`: `{ method, url, headers?, body?, query?, cookies?, signedCookies? }` — strings and
bytes are sent as is, a `FormData` as `multipart/form-data` (files included), a `Blob` / `File` with
its type, other bodies as JSON. `InjectResponse`: `{ status, headers, body, bytes, cookies, json() }`
(lower-case header names,
repeated headers joined with `, ` except `set-cookie`, an array with one entry per cookie; `bytes`
holds the raw body, for downloads). For end-to-end tests
over the network, start the application with `port: 0` and use `String(http.address)` as the base
URL.

```ts
const form = new FormData()
form.append('title', 'Me')
form.append('avatar', new File([await Bun.file('test/fixtures/me.png').bytes()], 'me.png', { type: 'image/png' }))
const uploaded = await http.inject({ method: 'POST', url: '/profile/avatar', body: form })

const partial = await http.inject({ method: 'GET', url: '/reports/q1.pdf', headers: { range: 'bytes=0-99' } })
expect(partial.status).toBe(206)
expect(partial.bytes.byteLength).toBe(100)
```

### Testing cookies

`cookies` sends request cookies (encoded like the cookies Znight sets, appended to any
`cookie` header), `signedCookies` are signed with the first secret of `cookies.secrets` before
dispatch (a `TypeError` without secrets), and `response.cookies` holds the parsed `set-cookie`
lines by name (`SetCookieInfo`: `{ name, value, raw, expires?, maxAge?, domain?, path?, secure,
httpOnly, sameSite?, partitioned, priority? }`; the last one wins). The encoding is canonical, so a
value read from `response.cookies` can be sent back as is, signed values included:

```ts
const login = await http.inject({ method: 'POST', url: '/auth/login', body: { email, password } })
expect(login.cookies['__Host-uid']).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' })

const me = await http.inject({
  method: 'GET',
  url: '/auth/me',
  cookies: { '__Host-uid': login.cookies['__Host-uid'].value },
})
const signed = await http.inject({ method: 'GET', url: '/auth/me', signedCookies: { '__Host-uid': 'u-1' } })
const tampered = await http.inject({ method: 'GET', url: '/auth/me', cookies: { '__Host-uid': 'u-2.AAAA' } }) // 400
```

### Testing event streams

`inject()` reads the whole body, so it rejects an event stream (which never
ends) instead of hanging: `inject(): GET /orders/1/events answered an event stream
(text/event-stream): use injectSse() or injectStream()`. `http.injectSse(request)` (and
`TestApp.injectSse()`) reads it in memory like `EventSource`:

```ts
await using stream = await http.injectSse({ url: '/orders/o-1/events' })
expect(stream.status).toBe(200)
expect(stream.retry).toBe(5_000)

hub.publish({ orderId: 'o-1', sequence: 42, type: 'status', status: 'paid' })
const event = await stream.next() // rejects after 2 000 ms by default
expect(event).toMatchObject({ event: 'status', id: '42' })
expect(event.json()).toMatchObject({ status: 'paid' })

const resumed = await stream.reconnect() // same request plus `last-event-id: 42`, like EventSource
await stream.close() // the server sees a client disconnect: ctx.signal aborts, the channel closes
```

| Member                         | Description                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| `status`, `headers`, `cookies` | Available once the stream opened (see below)                                               |
| `body`, `json()`               | `''` for an event stream; otherwise the whole body (an error, a 204...)                    |
| `next({ timeoutMs? })`         | The next event (comments skipped); rejects on timeout (2 000 ms) or when the stream ended  |
| `take(count, { timeoutMs? })`  | The next `count` events                                                                    |
| `comments`                     | Comments received so far (heartbeats are `''`)                                             |
| `lastEventId`, `retry`         | What a browser would send as `Last-Event-ID`; the last `retry` received                    |
| `done`                         | Resolves when the server ends the stream (the remaining events stay available to `next()`) |
| `close()`, `reconnect()`       | Disconnects (idempotent; also `await using`); reconnects with `last-event-id`              |
| `[Symbol.asyncIterator]`       | Every event until the end of the stream                                                    |

Opening never hangs. `injectSse()` resolves at the first chunk of the stream: an `@Sse` stream sends
`retry` or a comment at once, so `retry` is known right after. A stream that sends nothing yet (a
hand-written `ReadableStream`, a quiet proxied upstream) is open after 2 000 ms anyway, and
`next()` reads what it sends later (its timeout message says when the stream has sent nothing since
it opened). Without response headers within 2 000 ms (a handler that never answers), `injectSse()`
rejects with `injectSse(): no response from GET /orders/o-1/events within 2000 ms` and aborts the
request.

Events are read only when asked for, so a test controls the pace of the client. `injectStream()`
resolves at the response headers with `{ status, headers, cookies, body: ReadableStream }`
(cancelling `body` or aborting `signal` disconnects the client). Over real sockets,
`parseSseStream(body, { signal? })` turns any `ReadableStream<Uint8Array>` into its items
(`{ type: 'event', event, data, id, json() }`, `{ type: 'comment', text }`, `{ type: 'retry',
retry }`), following the WHATWG parsing rules (BOM, CR / LF / CRLF, `id` with NUL ignored, an
unterminated final event discarded):

```ts
const response = await fetch(`${http.address}/orders/o-1/events`)
for await (const item of parseSseStream(response.body!)) {
  if (item.type === 'event') console.log(item.event, item.json())
}
```


## Lifecycle and graceful shutdown

| Plugin hook   | What happens                                                                                                                                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `register`    | Declares the request-scoped externals `HttpContext` and `RequestId`, registers the plugin                                                                                                                             |
| `onBootstrap` | Resolves options, controllers, guards, interceptors and mappers; collects plugin routes; checks route decisions (ZNIGHT023); validates and registers routes                                                           |
| `onStart`     | Listens (logs the address)                                                                                                                                                                                            |
| `onStop`      | Closes the event streams gracefully (see below), stops accepting connections, closes idle ones, waits for in-flight requests and streamed or file responses (`drainTimeoutMs`), then closes the remaining connections |
| `onDispose`   | Closes the server and the adapter                                                                                                                                                                                     |

While draining, responses carry `connection: close`. Event streams never end by themselves, so
`onStop` closes them first: their `ctx.signal` aborts (`'shutdown'`), their sources get
`sse.shutdownGraceMs` to send final events, then the clients receive a jittered `retry` and the
streams end, well before `drainTimeoutMs` instead of holding the drain until its timeout. An event
stream requested while draining is served (its guards run) with its signal already aborted: a
well-behaved source ends at once and the client gets the `retry` (a 503 would make `EventSource`
give up for good). Ordinary in-flight requests are not aborted: they drain. Keep
`sse.shutdownGraceMs` < `drainTimeoutMs` < `shutdown.hookTimeoutMs`.

Singletons (controllers, singleton guards,
interceptors and mappers) are resolved at bootstrap; request-scoped and transient ones on every
request. Bootstrap fails with `ZNIGHT007` for invalid or duplicate routes (and invalid `sse`
metadata), `ZNIGHT001` for controllers, guards or interceptors that are not providers, `ZNIGHT005`
for invalid options (and contradicting route decorator groups), `ZNIGHT006` for a route reading a
signed cookie without `cookies.secrets` and `ZNIGHT023` for route decisions that are missing or that
no guard enforces.

A plugin instance serves one application at a time and can serve another one once the previous
application is stopped (a `HttpPlugin.configure()` shared by the tests of a file); using it in two
running applications fails with `ZNIGHT004` (`Call HttpPlugin.configure() once per application`).
An adapter instance serves a single application: pass a function to create one per application
(`HttpPlugin.configure(() => ({ adapter: fastifyAdapter() }))`), otherwise the second bootstrap
fails with `ZNIGHT021`.

## Compiler

`@znight/http/compiler` is loaded automatically by `@znight/compiler` (Vite plugin, `znight
generate`, Bun preload) as soon as your code imports `@znight/http`: there is nothing to configure.
It never loads the HTTP runtime (nor Fastify, Express or Hono) at build time.

For every `@Controller` class it:

1. registers the controller as a provider (`scope` from `@Controller({ scope })`, singleton by
   default) and binds `@UseGuard` / `@UseInterceptor` classes to providers — classes without
   `@Injectable()` are registered as singletons automatically;
2. turns every method carrying `@Get`, `@Post`... into a route (several route decorators on one
   method give several routes), reads `@HttpCode`, `@Header`, `@Validate` and your
   [`createRouteDecorator`](#guards) decorators;
3. generates, for each route, an `invoke` function that extracts every argument from the request,
   coerces it to the declared type or validates it with its schema, and calls the handler;
4. checks the whole application and reports precise diagnostics (below).

### Types of parameters

`@Param('name')`, `@Query('name')`, `@Headers('name')`, `@Cookie('name')` and
`@SignedCookie('name')` values without schema are converted to the declared type of the parameter
(see [Parameters](#parameters)). The compiler reads:

| Declared type                                                     | Conversion                                        |
| ----------------------------------------------------------------- | ------------------------------------------------- |
| `string`, `number`, `boolean`, `bigint`, `Date`                   | `coerce.string` / `.number` / ...                 |
| literal unions (`'asc' \| 'desc'`, `1 \| 2`, `'auto' \| boolean`) | one of the literals                               |
| TypeScript enums (`enum Level { Low, High }`)                     | one of the member values                          |
| branded primitives (`string & { readonly __brand: 'Id' }`)        | the primitive                                     |
| `T[]`, `readonly T[]`, `Array<T>` of the above                    | repeated or single values                         |
| `unknown`                                                         | the raw value (`string \| string[] \| undefined`) |
| no annotation, with a default value (`page = 1`)                  | the type of the default value                     |

Type aliases are followed (`type Sort = 'asc' | 'desc'`). A parameter is optional when it has `?`,
a default value, or `| undefined` / `| null` in its type; route parameters are always present.
Anything else (objects, other unions, tuples, nested arrays) is an error for `@Param` / `@Headers`
/ `@Cookie` / `@SignedCookie` and a ZNIGHT017 warning for `@Query` (the raw value is passed): use a
schema. `@Cookie()` (every cookie) without schema is fine typed `Record<string, string>` or
`unknown`; other types are a ZNIGHT017 warning.

`@Sse` handlers return an `AsyncIterable`, an `Iterable` or a `ReadableStream` (or an
`HttpResponse`): an annotated return type that is (after `Promise`) a primitive, a literal or `void`
— or a union with one, such as `SseEvent[] | undefined` — is an error. References, arrays, type
parameters, `unknown` and sync generator methods (`*events()`) are accepted.

Upload parameters are typed `File` (`@UploadedFile`) or `File[]` / `readonly File[]`
(`@UploadedFiles`); `Blob`, `unknown`, `any`, `node:buffer`'s `File` and missing annotations are
accepted too. `file?: File` / `File | undefined` makes an upload optional (`required: false`).

### Diagnostics

- **ZNIGHT005** (invalid decorator usage): a decorator on the wrong target, outside a controller or
  on a method that is not a route; applied twice; invalid or non-static arguments (`@HttpCode(42)`,
  bad header names, a schema that is not a reference to an exported binding); a handler that is
  static, `private`/`protected`, `#private`, an accessor or has a computed name; a handler parameter
  without HTTP decorator, or with a look-alike imported from another package (`Headers` / `Ctx` of
  `@znight/messaging`: the error names the import to use); `@Validate(S)` combined with
  `@Body(S2)`; an invalid `createRouteDecorator` declaration; upload parameters: a type other than
  `File` / `File[]`, an invalid field or option (unknown key, `maxSize` that is not a size,
  `maxFiles` on `@UploadedFile`, invalid media type patterns), `{ required: false }` on a parameter
  typed `File`, two parameters reading the same field, a parameter without field combined with
  others; an invalid `@BodyLimit`. `@Res()`, `@Body(SomeClass)` (a class is not a schema) and upload
  parameters on `GET` / `HEAD` / `DELETE` / `OPTIONS` routes are warnings. On a class owned by
  another extension (a `@Consumer`), HTTP decorators are reported without suggesting
  `@Controller()`, and those on the parameters of its handlers (`@OnMessage`) are left to that
  extension (`@znight/messaging` reports a `Headers` imported from `@znight/http`), unless the
  parameter is also read through its decorators or is optional. Route decorator groups: invalid
  `createRouteDecorator` options (at the usage, related to the definition), two decisions of one
  group on a class or a method, two definitions of one key with different options, decorators of
  one group disagreeing on `required` (at the second definition). Cookies: an invalid cookie name
  (not an RFC 9110 token), `@SignedCookie` without name, `@Cookie` and `@SignedCookie` on one
  parameter. `@Sse`: applied twice or combined with another route decorator, invalid options
  (unknown key, `heartbeat` / `maxDuration` below 1 000 ms, negative `retry`, non-static), `@HttpCode`,
  `@Header('content-type')` or `@Res()` on an `@Sse` method, a primitive return type; a request body
  or uploads on an `@Sse` route are a warning (EventSource sends `GET` without body: use `@Post()`
  and `HttpResponse.sse()`).
- **ZNIGHT007** (invalid route): path grammar (base path, route path and their combination); a
  `:param` not consumed by `@Param('param')` (a `@Param()`, `@Ctx()` or `@Req()` parameter consumes
  them all); a `@Param('x')` without `:x` in the path; a `@Param` / `@Headers` / `@Cookie` /
  `@SignedCookie` type that cannot be coerced; two routes with the same method and path shape
  anywhere in the application (an `@Sse` route is a `GET` route).
- **ZNIGHT017** (unvalidated input): a non-primitive `@Body()` / `@Query()` / `@Cookie()` without schema (`string`,
  `unknown`, `Uint8Array`, `FormData`, `Record<string, string | string[]>` — the text fields of a
  form — are fine). A warning, an error with the compiler option `strictValidation`.
- **ZNIGHT003** (scope mismatch): a singleton controller uses a request-scoped guard or interceptor
  (directly or through transient ones). Make the controller request-scoped, or the guard a
  singleton (it receives the `HttpContext` as argument).
- **ZNIGHT023** (missing route decision): a route without decision of a required group, neither on
  itself nor on its controller, located at the route decorator and related to the group definition
  and the controller, with a hint listing the decorators of the group (see
  [Route decisions](#route-decisions)). The same code fails the boot when no guard enforces a
  decision.

```
✗ ZNIGHT007: Route GET /users/:id declares ":id" but UserController.find has no @Param('id') parameter
 --> src/users/user.controller.ts:5:8
  |
5 |   @Get('/:id')
  |        ^^^^^^
  = hint: Add a parameter: @Param('id') id: string

✗ ZNIGHT005: @HttpCode has no effect on @Sse route OrderEventsController.events: an event stream answers 200
 --> src/orders/order-events.controller.ts:14:3
   |
14 |   @HttpCode(202)
   |   ^^^^^^^^^^^^^^
   = hint: Throw an HttpException or return an HttpResponse from the handler for other statuses
```

### Route decorators

A decorator is a route metadata decorator when it is a `const` initialised with
`createRouteDecorator(key, options?)` where `key` and `options` (`{ group?, required? }`) are
statically evaluable (literals, `const` references). Its argument is evaluated at build time:
literals, `const` references (across files and packages), simple expressions, and references to
exported bindings (classes, objects), which the generated module imports. Without argument the
value is `true`. Route decorators must be declared in analysed sources (your application, or a
provider library published with its sources): from a declaration file (`.d.ts`) the key and the
options cannot be read and the compiler reports it. The compiler knows every definition of the
analysed sources, applied or not: a required group defined anywhere needs a decision on every
route.

### Limits of the compiler

- Routes are the methods declared by the controller class itself: methods inherited from a base
  class are not routes (the base class decorators are reported).
- The `type` of `params[i]` (informational) is the declared type of coerced values, formatted for
  humans.
- TypeScript has no integer type: `coerce.integer` is never inferred, use a schema
  (`z.coerce.number().int()`) or a check in the handler.

## Compiler contract

This section is the stable contract between the runtime and the compiler extension
(`@znight/http/compiler`). Generated code only uses what is listed here.

### Metadata (`metadata.extensions.http`)

Types: `HttpMetadata`, `HttpControllerDefinition`, `HttpRouteDefinition`, `HttpParamDefinition`,
`HttpUploadDefinition` (exported from `@znight/http`; architecture §9.1).

```ts
extensions: {
  http: {
    controllers: [
      {
        token: 'src/users/user.controller.ts#UserController', // provider token (@Controller registers the provider)
        basePath: '/users',                                     // normalizePath(controller path), '/' when absent
        guards: ['src/auth/auth.guard.ts#AuthGuard'],            // @UseGuard on the class, provider tokens, in order
        interceptors: [],                                       // @UseInterceptor on the class
        meta: { roles: ['admin'] },                             // createRouteDecorator values on the class (one per group)
        routes: [
          {
            method: 'GET',                    // 'GET'|'POST'|'PUT'|'PATCH'|'DELETE'|'HEAD'|'OPTIONS'|'ALL'
            path: '/:id',                     // normalizePath(decorator path)
            fullPath: '/users/:id',           // joinPaths(basePath, path) — WITHOUT the plugin prefix
            handler: 'find',
            status: 202,                      // @HttpCode, omitted when absent
            headers: { 'cache-control': 'no-store' }, // @Header (lower-case names), omitted when absent
            meta: { public: true },           // route createRouteDecorator values (one per group, nearest wins)
            guards: [],                       // @UseGuard on the method
            interceptors: [],                 // @UseInterceptor on the method (top-most first)
            params: [{ index: 0, source: 'param', name: 'id', type: 'number' }],
            rawResponse: true,                // only when the handler takes @Res()
            sse: { retry: 5000 },             // only for @Sse routes (GET): `{}` without options, heartbeat 0 = disabled
            invoke: (c: UserController, ctx: HttpContext) => c.find(coerce.number(ctx.params['id'], 'param "id"')),
          },
          {
            method: 'POST',
            path: '/:id/avatar',
            fullPath: '/users/:id/avatar',
            handler: 'avatar',
            meta: {},
            guards: [],
            interceptors: [],
            params: [
              { index: 0, source: 'param', name: 'id', type: 'string' },
              { index: 1, source: 'file', name: 'avatar' },                 // 'file' / 'files', name = field
              { index: 2, source: 'files', name: 'extra', optional: true },
            ],
            bodyLimit: 10485760,              // @BodyLimit (route, else controller), bytes; omitted when absent
            uploads: [                        // one per upload parameter, in parameter order; omitted when none
              { field: 'avatar', required: true, maxSize: 2097152, mimeTypes: ['image/*'] },
              { field: 'extra', multiple: true, maxFiles: 3 },
            ],
            invoke: (c: UserController, ctx: HttpContext) =>
              c.avatar(coerce.string(ctx.params['id'], 'param "id"'), uploads.file(ctx, 'avatar'), uploads.optionalFiles(ctx, 'extra')),
          },
        ],
      },
    ],
    // route decorator groups the runtime needs (required, several keys, or named differently from
    // their key), sorted, keys sorted; omitted when there is none (byte-identical output otherwise)
    groups: { access: { keys: ['authenticated', 'public', 'roles'], required: true } },
  },
}
```

Rules:
- Optional fields (`status`, `headers`, `bodyLimit`, `uploads`, `rawResponse`, `sse`, param
  `name`/`type`/`optional`/`schema`, upload `field`/`multiple`/`required`/`maxSize`/`maxFiles`/
  `mimeTypes`) are omitted when absent (`exactOptionalPropertyTypes`).
- `meta` values: a `createRouteDecorator` call without argument stores `true`. A decorator is a
  route decorator when its callee is a `const` initialised with a call to
  `@znight/http#createRouteDecorator`; its `key` (first argument) and its options (second
  argument) are static. A target holds at most one key per group.
- `groups` (`HttpRouteGroupDefinition`: `{ keys, required }`): a key belongs to one group at most;
  a key listed nowhere is its own group, not required. A group name is a letter followed by
  letters, digits, `_`, `.` or `-`, or the single key of the group (a decorator without `group`). The plugin computes the effective metadata
  of each route once at boot (the controller's entries whose group the route does not decide, then
  the route's entries). Malformed groups, or two keys of one group on a target, are ZNIGHT007 at
  boot.
- `@Validate(S)` applies `S` to the `@Body()` parameter (`@Validate(S)` + `@Body()` ≡ `@Body(S)`);
  `@Validate(S)` + `@Body(S2)` is ZNIGHT005. Without a `@Body()` parameter the body is still
  validated (and discarded): `invoke: async (c, ctx) => { await validate(S, await ctx.parseBody(), 'body'); return c.m() }`
  (this `async` arrow `await`s its other validations too).
- The plugin parses the body before the interceptors when `params` contains a `source: 'body'`
  entry or `uploads` is not empty; `ctx.body` is `undefined` otherwise (generated code then uses
  `await ctx.parseBody()`).
- `uploads` (`HttpUploadDefinition`: `{ field?, multiple?, required?, maxSize?, maxFiles?, mimeTypes? }`)
  drives the multipart parsing of the route: files are only accepted in these fields (any field for
  an entry without `field`), `maxSize` defaults to the plugin `uploads.maxFileSize`, `maxFiles` to
  `uploads.maxFiles` (always 1 without `multiple`), `mimeTypes` are patterns (`type/subtype`,
  `type/*`, `*/*`). At most one entry per field, and an entry without field stands alone (checked
  at boot, ZNIGHT007). `required` is informational: presence is checked by `invoke` (`uploads.file`
  vs `uploads.optionalFile`). Sizes are bytes (`Infinity` allowed): the compiler converts
  `'2mb'`-like options with `parseByteSize` (binary units).
- `bodyLimit` (bytes, `Infinity` allowed) overrides the plugin `bodyLimit`; without it, routes with
  `uploads` use `bodyLimit + Σ maxSize × maxFiles`.
- `sse` (`HttpSseDefinition`: `{ heartbeat?, retry?, maxDuration? }`, ms; `heartbeat: 0` disables
  the heartbeat, otherwise ≥ 1 000; `maxDuration` ≥ 1 000): the handler result is served as an event
  stream (an `HttpResponse` or a Web `Response` is sent as usual). Only on `GET` routes; invalid
  values are ZNIGHT007 at boot.
- Param sources (`HttpParamSource`): `param`, `query`, `body`, `headers`, `request`, `response`,
  `context`, `file`, `files`, `cookie` and `signedCookie` (`name`: the cookie name; absent for
  `@Cookie()`). A route with a `signedCookie` parameter fails the boot without `cookies.secrets`
  (ZNIGHT006).
- Guards, interceptors and controllers referenced by tokens must be providers (the compiler
  registers injectable helper classes, §6.5 `resolveClassRef`). Request-scoped guards/interceptors
  are allowed.
- Path validation and joining must use `@znight/http/path` (pure module, safe to import from the
  compiler): `joinPaths`, `normalizePath`, `checkRoutePath` (→ `RoutePathIssue | undefined` for
  ZNIGHT007), `parseRoutePath(path).params` (to check `:param` ↔ `@Param` names) and
  `parseRoutePath(path).shape` (duplicate detection: same method + same shape = ZNIGHT007; `ALL`
  conflicts only with another `ALL`).

### `invoke` generation

`invoke(controller, ctx)` extracts every argument in parameter order and calls the handler. It
returns the handler result as is (promises included); the plugin awaits it only when it is a
thenable. Without schema it is a synchronous arrow:
`(c: UserController, ctx: HttpContext) => c.find(coerce.number(ctx.params['id'], 'param "id"'))`.

With schemas it stays synchronous as long as every `validate()` returns a value (Zod, Valibot or
ArkType schemas without async refinements): no promise, no `await` per request. The arguments up to
the last validated one are evaluated in order into `a<index>` constants (`@Ctx()` stays `ctx`), the
later ones are inlined in the call, and each validated argument is followed by a fallback for
asynchronous schemas:

```ts
invoke: (c: UserController, ctx: HttpContext) => {
  const a0 = coerce.number(ctx.params['id'], 'param "id"')
  const a1 = validate(UpdateUser, ctx.body, 'body')
  if (isThenable(a1)) return (async () => c.update(a0, await a1, ctx))()
  return c.update(a0, a1, ctx)
},
```

When `validate()` returns a thenable (an async refinement, or an output that is itself a promise),
the `async` arrow awaits it, then evaluates the remaining arguments (`await`ing their validations)
and calls the handler: the order of evaluation, the error of the first invalid argument and the
values received by the handler are those of an `async` invoke `await`ing every `validate()`. The
expressions of the table below are `validate(S, ...)` calls in both forms.

| Parameter                               | Generated expression                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| `@Param('id') id: T`                    | `coerce.X(ctx.params['id'], 'param "id"')` (see below)                        |
| `@Param('id', S)`                       | `validate(S, ctx.params['id'], 'param "id"')`                                 |
| `@Param()`                              | `ctx.params as never` · with schema: `validate(S, ctx.params, 'params')`      |
| `@Query('page') page: T`                | `coerce.X(ctx.query['page'], 'query "page"')`                                 |
| `@Query('page', S)`                     | `validate(S, ctx.query['page'], 'query "page"')`                              |
| `@Query()` / `@Query(S)`                | `ctx.query as never` / `validate(S, ctx.query, 'query')`                      |
| `@Body()` / `@Body(S)` / `@Validate(S)` | `ctx.body as never` / `validate(S, ctx.body, 'body')`                         |
| `@Headers('X-Api-Key') key: T`          | `coerce.X(ctx.headers['x-api-key'], 'header "x-api-key"')` (name lower-cased) |
| `@Headers()`                            | `ctx.headers as never`                                                        |
| `@Cookie('sid') sid: T`                 | `coerce.X(ctx.cookies['sid'], 'cookie "sid"')` (or `coerce.optional(...)`)    |
| `@Cookie('sid', S)`                     | `validate(S, ctx.cookies['sid'], 'cookie "sid"')`                             |
| `@Cookie()` / `@Cookie(S)`              | `ctx.cookies as never` / `validate(S, ctx.cookies, 'cookies')`                |
| `@SignedCookie('sid') sid: T`           | `coerce.X(ctx.signedCookie('sid'), 'cookie "sid"')`                           |
| `@SignedCookie('sid', S)`               | `validate(S, ctx.signedCookie('sid'), 'cookie "sid"')`                        |
| `@Req()` / `@Res()`                     | `ctx.request as never` / `ctx.response as never` (+ `rawResponse: true`)      |
| `@UploadedFile('f') f: File`            | `uploads.file(ctx, 'f')` · optional: `uploads.optionalFile(ctx, 'f')`         |
| `@UploadedFiles('f') f: File[]`         | `uploads.files(ctx, 'f')` · optional: `uploads.optionalFiles(ctx, 'f')`       |
| `@UploadedFile()` / `@UploadedFiles()`  | the same helpers with `undefined` as field (any field)                        |
| `@Ctx()`                                | `ctx`                                                                         |

`coerce.X` by declared type (`T`):

| Type                                          | Expression                                                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `string`                                      | `coerce.string(v, label)`                                                                                                             |
| `number`                                      | `coerce.number(v, label)`                                                                                                             |
| `boolean`                                     | `coerce.boolean(v, label)`                                                                                                            |
| `bigint`                                      | `coerce.bigint(v, label)`                                                                                                             |
| `Date`                                        | `coerce.date(v, label)`                                                                                                               |
| literal union `'a' \| 'b'` / `1 \| 2`         | `coerce.enum(v, label, ['a', 'b'])`                                                                                                   |
| `T[]` / `readonly T[]` / `Array<T>`           | `coerce.array(v, label, ITEM)` where `ITEM` is `coerce.number` or `(v, l) => coerce.enum(v, l, [...])`                                |
| optional (`?`, `\| undefined`, default value) | `coerce.optional(v, label, ITEM)` where `ITEM` is the coercer of the non-optional type (arrays: `(v, l) => coerce.array(v, l, ITEM)`) |
| other types (objects, unions...)              | ZNIGHT007 for `@Param`/`@Headers`; ZNIGHT017 for `@Query`/`@Body` without schema                                                      |

Labels are `param "<name>"`, `query "<name>"`, `header "<lower-case name>"`, `cookie "<name>"`;
validation locations are the same, or `params`, `query`, `body`, `cookies` for whole objects.
Coercion errors of labels starting with `cookie ` never echo the received value, and validation
errors of the locations `cookie "<name>"` and `cookies` replace the issue messages with
`Invalid value` (paths kept). A route parameter is always present
(the route matched), so `@Param('id') id?: string` is still `coerce.string`.

### Runtime helpers (exported from `@znight/http`)

```ts
type Coercer<T> = (value: unknown, label: string) => T

const coerce: {
  string: Coercer<string>
  number: Coercer<number>
  integer: Coercer<number>
  boolean: Coercer<boolean>
  bigint: Coercer<bigint>
  date: Coercer<Date>
  enum<const T extends readonly (string | number | boolean)[]>(value: unknown, label: string, values: T): T[number]
  array<T>(value: unknown, label: string, item: Coercer<T>): T[]
  optional<T>(value: unknown, label: string, item: Coercer<T>): T | undefined
}

function validate<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
  location: string,
): InferSchemaOutput<S> | Promise<InferSchemaOutput<S>>

function isThenable(value: unknown): value is PromiseLike<unknown> // a `then` method: validate() result to await

const uploads: {
  file(ctx: HttpContext, field: string | undefined): File // 400 `Missing file "field"` when absent
  optionalFile(ctx: HttpContext, field: string | undefined): File | undefined
  files(ctx: HttpContext, field: string | undefined): File[] // 400 `Missing files "field"` when empty
  optionalFiles(ctx: HttpContext, field: string | undefined): File[]
}
```

Every coercion failure throws `BadRequestException` (400); `validate` throws `ValidationException`
(400, `details: [{ path, message }]`) and `TypeError` when `schema` is not a Standard Schema; the
`uploads` helpers read `ctx.files` (`undefined` field: every field) and throw `BadRequestException`
for missing required files (`Expected a file in field "f", received a text value` when the field
was sent as text). `validate` returns the output synchronously when the schema validates
synchronously, a promise otherwise. Generated modules import them with
`import { coerce, isThenable, uploads, validate } from '@znight/http'` and the context type with
`import type { HttpContext } from '@znight/http'`.

### Manifest

```jsonc
"znight": {
  "apiVersion": 1,
  "compiler": "@znight/http/compiler",
  "provides": [
    { "export": "HttpContext", "plugin": "HttpPlugin", "scope": "request" },
    { "export": "RequestId", "plugin": "HttpPlugin", "scope": "request" },
    { "export": "HttpPlugin", "plugin": "HttpPlugin", "scope": "singleton" }
  ]
}
```

Tokens: `@znight/http#HttpContext`, `@znight/http#RequestId`, `@znight/http#HttpPlugin`
(`HttpTokens`). `RequestId` is a branded string type alias. Decorator identities:
`@znight/http#Controller`, `#Get`, `#Post`, `#Put`, `#Patch`, `#Delete`, `#Head`, `#Options`,
`#All`, `#Param`, `#Query`, `#Body`, `#Headers`, `#Req`, `#Res`, `#Ctx`, `#HttpCode`, `#Header`,
`#BodyLimit`, `#UploadedFile`, `#UploadedFiles`, `#UseGuard`, `#UseInterceptor`, `#Validate`,
`#Cookie`, `#SignedCookie`, `#Sse`, `#createRouteDecorator`. `@Param`/`@Query`/`@Cookie`/
`@SignedCookie` take either a static name (string) and an optional schema, or a schema alone
(`@SignedCookie` requires the name); `@Sse` a static path and/or static options; `@UploadedFile`/`@UploadedFiles` a static field and/or static options;
`@BodyLimit` a static size (class or method).

## Compiler contract for other extensions

Other compiler extensions (`@znight/openapi`) read the data stored by the http extension through
`ctx.graph.extensions` (`{ name: 'http', stored }`). The types are exported from
`@znight/http/compiler` and follow the lockstep release line (a matching compiler is guaranteed by
ZNIGHT018):

| Type                 | Content                                                                                                                                                                                                                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HttpControllerData` | `token`, `identity` (canonical identity of the class), `displayName`, `rawBasePath`, `basePath`, `guards` / `interceptors` (`ClassRef`), `meta`, `routes`, `location`, `pathLocation`                                                                                                                    |
| `HttpRouteData`      | `method`, `rawPath`, `path`, `fullPath` (without prefix), `handler`, `status`, `headers`, `meta`, `guards`, `interceptors`, `params`, `complete` (`false`: skip, http reported an error), `bodySchema`, `bodyLimit`, `rawResponse`, `sse` (`SseRouteData`, `@Sse` routes), `location`, `pathLocation`    |
| `HttpParamData`      | `index`, `name`, `source` (`cookie` / `signedCookie` for cookies, `key` = the cookie name), `key`, `type`, `optional`, `schema` (`ValueRef`), `coercion` (`ParamCoercion`: plan and cast), `upload`, `defaultValue` (statically evaluable default value: `page = 1` → `1`, absent otherwise), `location` |
| `UploadData`         | `field`, `multiple`, `required`, `maxSize`, `maxFiles`, `mimeTypes`, `cast`                                                                                                                                                                                                                              |
| `MetaEntry`          | `key`, `value` (`StaticValue`), `group`, `required`, `decorator` (name of the `const`), `identity` (canonical identity of the decorator `const`: `src/auth/access.ts#Public`), `definition` and `location`                                                                                               |

Controllers are stored in identity order of the classes; sort them by `token` for deterministic
output. The effective metadata of a route is the controller's entries whose `group` has no entry on
the route, then the route's entries.

## Writing an adapter

An adapter implements `HttpAdapter` (exported types): it routes requests to the handlers given by
the plugin with its native router and translates I/O. The plugin does everything else.

```ts
interface HttpAdapter {
  readonly name: string
  registerRoute(route: AdapterRoute): void // { method (never 'ALL'), path: RoutePath, handler }
  setFallbackHandler(handler: FallbackHandler): void // unmatched requests (404/405/OPTIONS) and framework errors
  listen(port: number, host: string): Promise<HttpServerAddress>
  close(options?: { force?: boolean }): Promise<void>
  inject(request: InjectRequest): Promise<InjectResponse>
  injectStream?(request: InjectStreamRequest): Promise<InjectStreamResponse> // optional
}
```

- Translate `route.path` with `@znight/http/path` (`toFastifyPath`, `toHonoPath`, `toRegExpSource`)
  or match it with `matchRoutePath` / the segment trie. Routes arrive sorted (HEAD first, most
  specific first), ready for first-match routers.
- Build an `AdapterRequest` (`method`, raw `url`, lower-case `headers`, `ip`, `readBody(limit)`,
  native `raw`/`rawResponse`; also `remoteAddress`, the socket peer, **never** read from headers,
  where `trustProxy` starts walking `x-forwarded-for`, and `encrypted` for TLS connections, which
  gives `ctx.protocol`) and write the `AdapterReply` (`status`, `headers` — already validated, every
  name and value can be sent —, `body`: bytes, a stream or `null`; write nothing when `raw`).
  Never rethrow a failure to write a reply into the framework's error handler (the request would be
  served twice): release the body and answer a plain 500.
- When the native router misses a request (it normalises paths...), call the fallback handler: the
  plugin routes the raw path itself.
- Optionally implement `streamBody(limit)`: the body as a pull-based Web stream (pause the source
  while the consumer does not read), erroring with `PayloadTooLargeException` past `limit` bytes
  (check `content-length` first) and with `BadRequestException` when the client aborts; cancelling
  it must **discard** the rest of the body without closing the connection (the error response is
  still written). Without it, multipart bodies are buffered with `readBody` before being parsed and
  `ctx.bodyStream()` streams the buffered bytes. `hasBody()` tells whether a request without
  `content-length` / `transfer-encoding` has a body (Web `Request`s built in memory; `false` for a
  request read from an HTTP/1.1 connection). A body stream the request did not finish is cancelled
  by the plugin once the request is over.
- A stream `body` MUST be read to its end or cancelled (client gone, response not sent): the request
  scope and the in-flight count are released then. Files are such streams, reading the `Blob` given
  in `reply.blob` (with its `content-length`): an adapter may send that `Blob` natively instead
  (`new Response(blob)` on `Bun.serve()`: `sendfile`), and then MUST cancel `body` once the server
  holds the blob (its file opened), which releases the request scope.
- `inject()` accepts `FormData` and `Blob` bodies (encode them with `new Response(body)`), a
  `cookies` record (append `name=encodeCookieValue(value)` pairs to the `cookie` header; the plugin
  signs `signedCookies` before calling the adapter) and returns the raw body in
  `InjectResponse.bytes` and the parsed `set-cookie` lines in `InjectResponse.cookies`
  (`parseSetCookie`). The built-in adapters build `inject()` on `injectStream()` and reject an event
  stream (`text/event-stream`) with a hint instead of buffering it forever.
- Optionally implement `injectStream(request)`: an in-memory request resolving at the response
  headers, its body (`ReadableStream<Uint8Array>`) read as it is produced; cancelling the body, or
  aborting `request.signal`, must disconnect the client (the server sees `onAbort` and a cancelled
  reply body). `HttpPlugin.injectStream()` / `injectSse()` require it.
- Optionally implement `AdapterRequest.onAbort(listener)`: call the listener once when the client
  disconnects before the response was fully written (on the next microtask when that already
  happened), never after a complete response. Without it, `ctx.signal` only aborts when the reply
  body is cancelled or an event stream is closed by the server.
- `AdapterReply.text` is the string a body was serialised from (JSON, text), next to its UTF-8
  bytes in `body`: an adapter that writes strings (`ServerResponse.end()`, `new Response()`) may
  send it instead, which writes the same bytes; on Node.js a string is written with the headers at
  once, where bytes take a second write.
- `AdapterReply.eventStream` marks a long-lived event stream (any streamed `text/event-stream`
  body): send the headers without waiting for the first chunk, do not apply idle or inactivity
  timeouts to the response while it is sent (`response.setTimeout(0)`, Bun's `server.timeout()`),
  write each chunk as soon as it is read, and keep compression and payload-rewriting hooks away
  from it (Fastify: `reply.hijack()`).
- Repeated `Cookie` request header fields must reach the plugin joined with `; ` (Node.js and the
  Fetch `Headers` of Node.js and Bun do it): rebuild the header from the raw values if your runtime
  joins them with `, `.
- Parameters, query, body parsing, HEAD bodies and errors are handled by the plugin: do not parse
  bodies or decode parameters in the adapter.

## Limitations

- No built-in compression or static files yet: use the native ecosystem through the Fastify /
  Express / Hono adapters (their middleware runs before Znight routes).
- No sessions, encrypted cookies or CSRF middleware (built-in sessions are out of scope: the
  [security guide](https://github.com/znight-org/znight/blob/main/docs/guide/security.md) has
  cookie-session and CSRF recipes), and no cookie jar in `inject()` (tests pass cookies explicitly).
- Event streams: `EventChannel` is in-process (no cross-instance fan-out), hooks measure the time
  to open a stream (no stream-lifetime hook), and there is no built-in cap on open streams (count
  them with `plugin.streams` in a guard).
- No per-route CORS settings, no Private Network Access, and the `Forwarded` header is not read.
- Request bodies read with `@Body()` and uploaded files are buffered in memory (within the limits):
  stream large bodies with `ctx.bodyStream()` or upload to object storage (see
  [Large files](#large-files)). There is no streaming API for multipart parts yet.
- Compressed request bodies are rejected (415).
- `HttpResponse.file()` honours a single byte range (several ranges get the whole file) and no
  `Cache-Control` by default (add it with `.withHeader()`).
- `inject()` with the `node` and `express` adapters needs `light-my-request`.
