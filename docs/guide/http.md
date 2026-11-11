---
description: Build an HTTP API with @znight/http - controllers and routes, parameter coercion, request bodies, responses and status codes, errors and exception mappers, guards and interceptors, cookies, the request context and route tests.
---

# Controllers and routes

`@znight/http` serves your controllers on the built-in `node:http` server, Fastify, Express or Hono,
with the same behaviour on every adapter, on Node.js 24+ and Bun 1.3+. The compiler reads every
route at build time (paths, parameters and their types, schemas, guards) and generates the code that
extracts, coerces and validates the inputs: a malformed path or an untyped parameter is a build
error, not a surprise on the first request.

This page shows how to write an API. The [package reference](/packages/http) lists every decorator,
option and adapter; [Validation](./validation), [Files and streaming](./files-and-streaming) and
[Security](./security) cover the rest of the HTTP features.

## Set up the plugin {#setup}

```sh
npm install @znight/core @znight/http
npm install fastify     # optional: or express, or hono (+ @hono/node-server on Node.js)
```

```ts
import { HttpPlugin } from '@znight/http'
import { fastifyAdapter } from '@znight/http/fastify'
import { createApplication } from './.znight/container.generated.js'

const app = await createApplication({
  plugins: [HttpPlugin.configure({ adapter: fastifyAdapter(), port: 3000, prefix: '/api' })],
})
await app.start() // SIGINT / SIGTERM: stop accepting connections, drain in-flight requests, close
```

**Choose an adapter.** Without `adapter`, the built-in `node:http` server serves the routes: no
dependency, and enough for most APIs. Pick Fastify, Express or Hono when you already have middleware
or an instance to reuse, or on Bun for Hono's `Bun.serve()`. Routes, validation, errors, cookies,
CORS and event streams behave the same everywhere: the [adapters table](/packages/http#adapters)
lists what each one adds.

## Controllers and routes {#controllers}

A controller is a provider whose decorated methods are routes. Like every provider, it is found by
the compiler: export it, there is no list to add it to.

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

- **Paths** are static segments, `:name` parameters and a trailing `*` wildcard. Anything else
  (regular expressions, optional segments), a duplicate method and path, or a `:param` without its
  `@Param()` is [`ZNIGHT007`](/reference/error-codes#znight007) at build time. The most specific
  route wins: static, then `:param`, then `*`.
- **Paths can use constants**: ``@Controller(`${API_V1}/users`)`` is evaluated at build time.
- **Methods you do not write**: `HEAD` is served for every `GET` route; an unknown path answers
  `404`, a known path with another method `405` with `allow`, and an unmatched `OPTIONS` `204`.
- **Trailing slashes** follow the `trailingSlash` option: `'strict'` (the default: `/users/` is not
  `/users`), `'ignore'` or `'redirect'` (a same-origin `308`).
- **Raw paths.** Routes match the request path as sent: dot segments are not resolved
  (`/files/a/../b` gives `ctx.params['*'] = 'a/../b'`). Never build a file path from a parameter
  without the `root` option of [`HttpResponse.file()`](./files-and-streaming#downloads).
- A controller is a singleton by default; `@Controller({ path, scope: 'request' })` creates one per
  request.

## Parameters and coercion {#parameters}

Path, query and header values are strings on the wire. Znight coerces them from the **declared
parameter type**, in generated code: `string`, `number`, `boolean`, `bigint`, `Date`, literal unions,
enums, branded primitives and arrays of those (`T[]` also accepts a single value).

```ts
@Get('/reports')
reports(
  @Query('from') from: Date, // 2024-01-02, 2024-01-02T10:00:00Z, or a millisecond timestamp
  @Query('status') status: 'open' | 'closed' = 'open', // anything else: 400
  @Query('limit') limit = 20, // number, from the default value
  @Headers('x-tenant') tenant?: string, // may be absent
) {}
```

- An invalid value answers `400 Bad Request` naming the parameter. A `Date` must carry its offset
  (`2024-01-02T10:00:00` alone would depend on the server time zone) and exist (`2024-02-30` is
  refused).
- A parameter with a default value, `?` or `| undefined` may be absent: `undefined` is injected, so
  default values apply.
- A type that cannot come from a string (an object on `@Param()` or `@Headers()`) is a build error
  ([`ZNIGHT007`](/reference/error-codes#znight007)). For structured inputs, use a schema:
  [Validation](./validation).

The [parameter decorators table](/packages/http#parameters) lists the rest: `@Headers()`,
`@Cookie()`, `@UploadedFile()`, `@Ctx()`, and the `@Req()` / `@Res()` escape hatches. Your own
parameter decorators (`@CurrentUser()`) are [custom parameter decorators](./custom-parameters).

## Request bodies {#request-bodies}

A route declaring `@Body()` (or an upload parameter) gets its body parsed by Znight, identically on
every adapter, after the guards and before the interceptors: an unauthenticated client never makes
the server parse a large body. JSON, text, URL-encoded forms and multipart forms are recognised by
their `content-type` ([table](/packages/http#request-bodies)); anything else arrives as bytes.

Other routes read the body only when they need it:

```ts
@Post('/webhooks/payments')
async payment(@Ctx() ctx: HttpContext) {
  const bytes = await ctx.rawBody() // the exact bytes, to check a signature
  this.signatures.verify(bytes, ctx.header('x-signature'))
  const event = JSON.parse(new TextDecoder().decode(bytes))
  // ...
}
```

`ctx.parseBody()` parses lazily, `ctx.rawBody()` gives the bytes (webhook signatures: see the
[recipe](./security#webhooks)), `ctx.bodyStream()` a Web stream, nothing buffered
([large files](./files-and-streaming#large-files)).

**Limits.** A body above the limit answers `413`: 1 MiB by default (plugin `bodyLimit`), raised or
lowered per route or controller with `@BodyLimit('10mb')`. A compressed body (`content-encoding`
other than `identity`) answers `415`.

## Responses and status codes {#responses}

Return a value and Znight serialises it: objects and arrays as JSON, strings as `text/plain`, bytes
as `application/octet-stream`, `undefined` as an empty `204`. The complete mapping, streams and Web
`Response` included, is in the [responses table](/packages/http#responses).

Use `HttpResponse` when the status or the headers depend on the outcome:

```ts
import { Header, HttpCode, HttpResponse } from '@znight/http'

@Post()
async create(@Body(CreateUser) input: CreateUser) {
  const user = await this.users.create(input)
  return HttpResponse.created(user, `/users/${user.id}`) // 201 + location
}

@Post('/:id/archive')
@HttpCode(202) // the status of every response of this route
@Header('cache-control', 'no-store')
archive(@Param('id') id: number) {
  return this.users.archive(id)
}
```

The default status is `201` for `POST`, `204` without a body and `200` otherwise. `@HttpCode()` wins
over `HttpResponse.status`, which wins over the default. Headers set by `HttpResponse` win over
`ctx.setHeader()`, which wins over `@Header()`.

## Errors {#errors}

Throw an `HttpException` (or a subclass: `NotFoundException`, `ConflictException`...) for an
expected failure:

```ts
import { HttpException, NotFoundException } from '@znight/http'

if (user === undefined) throw new NotFoundException(`User ${id} not found`)
throw new HttpException(409, 'Email already used', { field: 'email' })
```

```json
{ "statusCode": 409, "error": "Conflict", "message": "Email already used", "details": { "field": "email" } }
```

Any other error becomes `{ "statusCode": 500, "error": "Internal Server Error" }`: its message is
only sent with `exposeErrors: true` (development), and the error is logged and reported to the
`error:report` hook ([report errors](./plugins#report-errors-error-report)).

### Map domain errors {#exception-mappers}

Services should not know about HTTP. Let them throw domain errors, and turn those into responses in
one place with an **exception mapper**: a provider whose `map(error, ctx)` returns an
`HttpException`, an `HttpResponse`, a Web `Response`, or `undefined` to let the next mapper (then
the default rendering) handle it. From the `rest-api` example:

<!-- sample: examples/rest-api/src/shared/domain-error.mapper.ts -->

```ts
import { Injectable } from '@znight/core'
import {
  ConflictException,
  type ExceptionMapper,
  type ExceptionMapperResult,
  NotFoundException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@znight/http'

import {
  BookNotFoundError,
  CoverChangedError,
  CoverNotFoundError,
  DuplicateIsbnError,
  UnsupportedCoverError,
} from '../books/book.js'

/**
 * Turns the domain errors into HTTP errors, so that services throw meaningful errors without
 * knowing about HTTP. Registered in `src/app.ts` (`exceptionMappers`); mappers are tried in order for
 * every error and the first one returning something wins. `undefined` lets the default rendering
 * apply (`HttpException`s keep their status, anything else is a 500).
 */
@Injectable()
export class DomainErrorMapper implements ExceptionMapper {
  map(error: unknown): ExceptionMapperResult {
    if (error instanceof BookNotFoundError || error instanceof CoverNotFoundError) {
      return new NotFoundException(error.message)
    }
    if (error instanceof DuplicateIsbnError) return new ConflictException(error.message, { isbn: error.isbn })
    if (error instanceof UnsupportedCoverError) return new UnsupportedMediaTypeException(error.message)
    if (error instanceof CoverChangedError) {
      return new ServiceUnavailableException(error.message, undefined, { headers: { 'retry-after': '1' } })
    }
    return undefined
  }
}
```

Register it with `HttpPlugin.configure({ exceptionMappers: [DomainErrorMapper] })`. Mappers see every
error of the pipeline, guards and the `404` / `405` answers included. In the
[data access guide](./data-access#drizzle), the repositories behind these errors run on Drizzle.

## Guards and interceptors {#guards-and-interceptors}

A **guard** decides whether a request may proceed: `canActivate(ctx)` returns `true`, or anything
else for a `403` (throw an `HttpException` for another status). Apply it with `@UseGuard()` on a
controller or a route, or globally with the `guards` option; global guards run first, then the
controller's, then the route's.

```ts
import { type CanActivate, type HttpContext, UseGuard } from '@znight/http'

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly config: SecurityConfig) {}

  canActivate(ctx: HttpContext): boolean {
    return ctx.header('x-api-key') === this.config.apiKey
  }
}

@Controller('/admin')
@UseGuard(ApiKeyGuard)
export class AdminController {}
```

Guards are providers, so they inject services and config classes, and the
[scope rules](./scopes#rules-between-scopes) apply to them. For access control, do not scatter guards:
declare an access decision on every route (`@Public()`, `@Roles(...)`), checked at build time and at
boot. The [Security guide](./security#route-decisions) builds authentication and authorization on
those [route decisions](/packages/http#route-metadata-and-decisions).

An **interceptor** wraps the handler, after the guards: global, then controller, then route, the
first being the outermost. `next()` resolves with the handler result, before serialisation:

```ts
import type { CallHandler, HttpContext, HttpInterceptor } from '@znight/http'

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

Apply it with `@UseInterceptor(TimingInterceptor)` or the `interceptors` option. HTTP interceptors
see the request (the data access guide runs
[a whole request in one transaction](./data-access#transactions) with one); for cross-cutting
behaviour on any provider method (caching, retries, logging), use [method interceptors](./aop)
instead: they work the same for HTTP, messages and jobs.

## Cookies {#cookies}

Cookies are handled by the plugin itself, identically on every adapter: no `cookie-parser`,
`@fastify/cookie` or `hono/cookie`, secure defaults, strict validation and optional signing.

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

- **Reading.** `@Cookie('name')` coerces the value to the parameter type like a header;
  `@Cookie('name', schema)` validates it. Cookies outlive deployments: give the ones that may go
  stale a schema with a fallback (`.catch()`), as above, rather than answering `400` until they
  expire. An invalid value never appears in the error message.
- **Setting.** `ctx.setCookie()` and `ctx.clearCookie()` apply to every response of the request,
  errors and redirects included (a guard can clear a cookie, then throw a `401`);
  `HttpResponse.ok(body).withCookie(...)` and `.withoutCookie(...)` attach them to one response.
  The defaults are `Path=/; Secure; HttpOnly; SameSite=Lax`, host-only: change them per cookie or
  for the whole application with the plugin option `cookies.defaults`
  ([options](/packages/http#setting-cookies)).
- **Mistakes throw where you make them**: a cookie browsers would drop silently (a name that is not
  a token, more than 4096 bytes, `SameSite=None` without `Secure`, an invalid `__Host-` cookie) is an
  error at the `setCookie()` call, not a cookie that never arrives.

### Signed cookies {#signed-cookies}

Sign a cookie when the client must not change it (a user id, a preference the server trusts):

```ts
HttpPlugin.configure(c => ({ cookies: { secrets: c.get(AppConfig).cookieSecrets } })) // the first signs, all verify

return HttpResponse.ok({ id: user.id }).withCookie('__Host-uid', user.id, { signed: true, maxAge: 8 * 3600 })
```

Read it with `@SignedCookie('__Host-uid')` or `ctx.signedCookie('__Host-uid')`: a tampered value, or
one signed with a retired key, reads as absent. Load the secrets with `@Secret` (at least 32 bytes
each), and rotate by deploying `[next, current]`, then `[next]` once the longest cookie lifetime has
passed. Signing gives integrity, not confidentiality. For cookie authentication, read the
[cookie session](./security#csrf) and CSRF recipes of the Security guide; the
[signing rules](/packages/http#signed-cookies) are in the reference.

### Testing cookies {#testing-cookies}

`inject()` (and [`TestApp.inject()`](./testing#cookies)) sends request cookies with `cookies`, signs
`signedCookies` with the current secret, and returns the parsed `set-cookie` lines by name in
`response.cookies`:

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

## The request context {#request-context}

Each request runs in its own [request scope](./scopes#request-scopes), seeded with two
request-scoped values you can inject:

- `HttpContext`: the adapter-neutral request and response (`params`, `query`, `headers`, `body`,
  `files`, `cookies`, `route`, `state`, `ip`, `protocol`, `signal`, `setHeader()`, `setCookie()`,
  `parseBody()`, `rawBody()`, `bodyStream()`...);
- `RequestId`: the request identifier, the incoming `x-request-id` when valid, a UUID otherwise.

```ts
import { Injectable, type Lazy } from '@znight/core'
import type { HttpContext } from '@znight/http'

@Injectable({ scope: 'request' })
export class CurrentTenant {
  constructor(private readonly ctx: HttpContext) {}

  get id(): string | undefined {
    return this.ctx.header('x-tenant')
  }
}

@Injectable() // a singleton reaches the request through Lazy
export class AuditService {
  constructor(private readonly ctx: Lazy<HttpContext>) {}
}
```

A singleton cannot inject `HttpContext` directly ([`ZNIGHT003`](/reference/error-codes#znight003)):
use `Lazy<HttpContext>`, or make the provider request-scoped. Request-scoped instances are disposed
once the response has been sent, streams and files included.

## The request pipeline {#pipeline}

![HTTP request pipeline: in a request scope (HttpContext, RequestId) and inside the http:request hook, a CORS preflight is answered directly (204, 403, 404); otherwise guards, body parsing, interceptors around the invocation (extract, coerce, validate, handler) and serialisation run, anything thrown becoming an error response; then cookies, request id, CORS and security headers are added and the scope closes once the body has been sent](/diagrams/http-pipeline.svg)

Plugins observe the pipeline through the `http:request` hook: `@znight/observability` wraps it to
log, measure and trace every request ([Observability](./observability)). CORS, security headers and
trusted proxies are options of the plugin, covered in
[Security](./security#cors-headers-and-proxies).

## Testing routes {#testing}

`TestApp` starts the application in memory and `inject()` sends requests without a socket, on every
adapter:

```ts
import { HttpPlugin } from '@znight/http'
import { TestApp } from '@znight/testing'
import { metadata } from '../src/.znight/container.generated.js'

test('GET /users/:id', async () => {
  await using app = await TestApp.create({ metadata, plugins: [HttpPlugin.configure({ port: 0 })] })

  const response = await app.inject({ method: 'GET', url: '/users/1' })
  expect(response.status).toBe(200)
  expect(response.json()).toMatchObject({ id: 1 })

  expect((await app.inject({ url: '/users/abc' })).status).toBe(400) // coercion
})
```

Replace a provider with `overrides`, run the production plugin list with
[`plugins()` from `src/app.ts`](./testing#production-wiring), and test uploads, downloads and event
streams as described in [Files and streaming](./files-and-streaming). The [Testing guide](./testing)
covers the rest.
