# @znight/http

HTTP for [Znight](../../README.md): controllers, routing, parameter coercion, validation with any
[Standard Schema](https://standardschema.dev) library (Zod, Valibot, ArkType...), guards,
interceptors, exception mappers, request scopes and graceful shutdown. It ships a zero-dependency
server on `node:http` and adapters for **Fastify**, **Express** and **Hono**, and behaves the same
on every one of them.

Like the rest of Znight, routes are resolved **at build time**: `@znight/http/compiler` reads your
decorators and generates the route table and one `invoke` function per handler (argument
extraction, coercion, validation). At runtime the plugin only registers the generated routes: no
reflection, no metadata lookup per request.

```sh
bun add @znight/core @znight/http zod
bun add -d @znight/compiler vite
```

Runs on Node.js >= 24 and Bun >= 1.3 (ESM only). Decorators require `"experimentalDecorators": true`.

- [Quick start](#quick-start)
- [Controllers and routes](#controllers-and-routes)
- [Parameters](#parameters)
- [Validation](#validation)
- [Request bodies](#request-bodies)
- [Responses](#responses)
- [Errors](#errors)
- [Guards](#guards)
- [Interceptors](#interceptors)
- [The request context](#the-request-context)
- [Hooks and observability](#hooks-and-observability)
- [Plugin options](#plugin-options)
- [Adapters](#adapters)
- [Testing](#testing)
- [Lifecycle and graceful shutdown](#lifecycle-and-graceful-shutdown)
- [Compiler contract](#compiler-contract)
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
import { __ZNIGHT_METADATA__ } from './.znight/container.generated.ts'

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

| Decorator                                | Target         | Description                                                                            |
| ---------------------------------------- | -------------- | -------------------------------------------------------------------------------------- |
| `@Controller(path?)`                     | class          | A provider (singleton) whose decorated methods are routes                              |
| `@Controller({ path?, scope? })`         | class          | `scope: 'request'` creates one controller instance per request                         |
| `@Get` `@Post` `@Put` `@Patch` `@Delete` | method         | Route; `path` is relative to the controller path (default: the controller path)        |
| `@Head(path?)` `@Options(path?)`         | method         | Explicit `HEAD` / `OPTIONS` routes                                                     |
| `@All(path?)`                            | method         | GET, HEAD, POST, PUT, PATCH, DELETE and OPTIONS, for methods without their own route   |
| `@HttpCode(status)`                      | method         | Status of successful responses                                                         |
| `@Header(name, value)`                   | method         | Header of successful responses (repeatable)                                            |
| `@UseGuard(...guards)`                   | class / method | [Guards](#guards)                                                                      |
| `@UseInterceptor(...interceptors)`       | class / method | [Interceptors](#interceptors)                                                          |
| `@Validate(schema)`                      | method         | Sugar for `@Body(schema)`                                                              |
| `createRouteDecorator<T>(key)`           | —              | Your own metadata decorators (`@Roles(['admin'])`, `@Public()`), see [Guards](#guards) |

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
at boot for hand-written metadata). Matching is case-sensitive.

When several routes match a path, the most specific one wins on every adapter: static segments
beat parameters, which beat the wildcard (`/users/me` before `/users/:id`).

### Automatic HEAD, OPTIONS, 404 and 405

- Every `GET` route answers `HEAD` (same status and headers, no body) unless a `@Head` route
  exists for the same path.
- A path that exists with other methods answers `405 Method Not Allowed` with an `allow` header,
  and `OPTIONS` with `204` and `allow` (unless an `@Options` route exists).
- Unknown paths answer `404 Not Found`. Both go through [exception mappers](#exception-mappers) and
  [hooks](#hooks-and-observability).

### Trailing slashes and prefix

`trailingSlash` applies to every adapter: `'strict'` (default: `/users/` does not match `/users`),
`'ignore'` (it does) or `'redirect'` (`308` to `/users`, query string kept). `prefix: '/api'` is
prepended to every route.

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
| `@Ctx()`                | The [`HttpContext`](#the-request-context)                                              |
| `@Req()` / `@Res()`     | The native request / response of the adapter (escape hatch, see [Adapters](#adapters)) |

`@Param`, `@Query` and `@Body` take an optional Standard Schema (`@Param('id', IdSchema)`,
`@Query(SearchQuery)`, `@Body(CreateUser)`): the **schema output** is injected (no coercion then).

Without a schema, typed parameters are coerced:

| Declared type                      | Accepted input                                    | Example            |
| ---------------------------------- | ------------------------------------------------- | ------------------ |
| `string`                           | any single value                                  | `abc`              |
| `number`                           | finite decimal number (no hex, `NaN`, `Infinity`) | `-1.5`, `1e3`      |
| `boolean`                          | `true`/`false`/`1`/`0` (case-insensitive)         | `true`             |
| `bigint`                           | integer                                           | `9007199254740993` |
| `Date`                             | ISO 8601 date or millisecond timestamp            | `2024-01-02`       |
| literal unions (`'asc' \| 'desc'`) | one of the literals                               | `asc`              |
| `T[]`                              | repeated or single values, each coerced as `T`    | `?id=1&id=2`       |

Invalid values answer `400` naming the input (`Invalid query "page": expected a number, received
"x"`). A missing required value answers `400 Missing query "page"`. Optional parameters (`?`,
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
interceptors, for routes declaring `@Body()`:

| `content-type`                      | Body                                  |
| ----------------------------------- | ------------------------------------- |
| (empty body)                        | `undefined`                           |
| `application/json`, `*/*+json`      | parsed JSON (`400` when malformed)    |
| `text/*`                            | string (charset honoured)             |
| `application/x-www-form-urlencoded` | record, repeated keys as arrays       |
| `multipart/form-data`               | `FormData` (files are `File` objects) |
| anything else / none                | `Uint8Array`                          |
- Bodies above `bodyLimit` (default 1 MiB) answer `413` (checked on `content-length` first, then
  while reading; the connection is closed).
- A `content-encoding` other than `identity` answers `415` (decompress upstream).
- Other routes do not read the body: call `await ctx.parseBody()` (memoised) or
  `await ctx.rawBody()` (bytes, e.g. to verify a webhook signature), or stream it from `@Req()`.

## Responses

| Handler result                               | Response                                                      |
| -------------------------------------------- | ------------------------------------------------------------- |
| object, array, number, boolean, `null`       | JSON (`application/json; charset=utf-8`), `toJSON()` honoured |
| `string`                                     | `text/plain; charset=utf-8`                                   |
| `Uint8Array`, `Buffer`, `ArrayBuffer`, views | `application/octet-stream`                                    |
| `ReadableStream`, Node.js `Readable`         | streamed `application/octet-stream`                           |
| `Blob` / `File`                              | streamed with the blob type                                   |
| `undefined`                                  | empty body, `204` (`201` for `@Post`)                         |
| `HttpResponse`                               | its body (same rules), status and headers                     |
| Web `Response`                               | sent as is (`@HttpCode` / `@Header` do not apply)             |

**Status precedence:** `@HttpCode` > `HttpResponse.status` > default (`201` for `@Post` routes,
`204` without body, `200` otherwise).

**Header precedence:** content type < `@Header` < `ctx.setHeader()` < `HttpResponse` headers.
Headers set with `ctx.setHeader()` / `ctx.appendHeader()` are also sent with error responses (a
guard can set `www-authenticate` and throw). Every response carries the request id header.

```ts
return HttpResponse.ok(user)
return HttpResponse.created(user, `/users/${user.id}`) // location header
return HttpResponse.accepted()
return HttpResponse.noContent()
return HttpResponse.redirect('/login', 303)
return new HttpResponse(csv, { status: 200, headers: { 'content-type': 'text/csv' } }).withHeader('x-total', '42')
```

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
handler. `5xx` exceptions are logged too. Every error is also recorded on the
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
export const Roles = createRouteDecorator<readonly string[]>('roles')
export const Public = createRouteDecorator('public') // flag: @Public()

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly tokens: TokenService) {}

  async canActivate(ctx: HttpContext): Promise<boolean> {
    if (Public.get(ctx)) return true
    const user = await this.tokens.verify(ctx.header('authorization'))
    if (user === undefined) throw new UnauthorizedException()
    ctx.state.set('user', user)
    const roles = Roles.get(ctx)
    return roles === undefined || roles.some(role => user.roles.includes(role))
  }
}

@Controller('/admin')
@Roles(['admin'])
export class AdminController {
  @Get('/health')
  @Public()
  health() {
    return 'ok'
  }
}

HttpPlugin.configure({ guards: [AuthGuard] })
```

Route metadata (`ctx.route.meta`) merges controller and route values (the route wins).
`decorator.get(ctx)` reads it with its type. Guards, interceptors and mappers are providers: they
may be request-scoped (resolved per request) and have dependencies. Plugin options also accept
instances (`guards: [new IpAllowList(['10.0.0.0/8'])]`).

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

| Member                                             | Description                                                            |
| -------------------------------------------------- | ---------------------------------------------------------------------- |
| `requestId`                                        | Incoming `x-request-id` (when valid) or a generated UUID               |
| `method`, `url`, `path`                            | Upper-case method, raw target (`/a%20b?x=1`), raw path                 |
| `params`                                           | Decoded route parameters (`'*'` for the wildcard)                      |
| `query`                                            | Parsed query, repeated keys as arrays (parsed on first access)         |
| `headers`, `header(name)`                          | Request headers (lower-case names)                                     |
| `body`, `parseBody()`, `rawBody()`                 | Parsed body ([when](#request-bodies)), lazy parsing, raw bytes         |
| `route`                                            | `{ method, path, controller, handler, meta }`, `undefined` for 404/405 |
| `state`                                            | `Map` shared by guards, interceptors and handlers                      |
| `setHeader()`, `appendHeader()`, `responseHeaders` | Response headers, also sent with errors                                |
| `request`, `response`                              | Native objects of the adapter                                          |
| `adapter`, `ip`                                    | Adapter name, remote address                                           |

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

Request-scoped instances are disposed when the request completes (before a streamed body has been
fully sent).

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

`@znight/observability` uses this hook for request logs, RED metrics and tracing.

## Plugin options

`HttpPlugin.configure(options)` — `options` may also be a function of the container, evaluated
once at bootstrap: `HttpPlugin.configure(c => ({ port: c.get(AppConfig).port }))`.

| Option              | Default         | Description                                                                                    |
| ------------------- | --------------- | ---------------------------------------------------------------------------------------------- |
| `adapter`           | `nodeAdapter()` | Server implementation                                                                          |
| `port`              | `3000`          | Port (`0`: a free port, see `plugin.address`)                                                  |
| `host`              | `0.0.0.0`       | Interface to bind                                                                              |
| `prefix`            | —               | Static path prefixed to every route (`/api`)                                                   |
| `guards`            | `[]`            | Global guards: provider classes or instances                                                   |
| `interceptors`      | `[]`            | Global interceptors (outermost first)                                                          |
| `exceptionMappers`  | `[]`            | Exception mappers, tried in order                                                              |
| `trailingSlash`     | `'strict'`      | `'strict'`, `'ignore'` or `'redirect'`                                                         |
| `exposeErrors`      | `false`         | Send the message of unexpected errors in 500 responses                                         |
| `bodyLimit`         | `1048576`       | Maximum body size in bytes                                                                     |
| `requestIdHeader`   | `x-request-id`  | Header read (when ≤ 128 chars of `[A-Za-z0-9_-.:@/+=]`) and echoed; `false` to always generate |
| `generateRequestId` | `randomUUID`    | Request id generator                                                                           |
| `drainTimeoutMs`    | `4000`          | Maximum wait for in-flight requests on shutdown (keep it below `shutdown.hookTimeoutMs`)       |

The plugin instance (`app.getPlugin<HttpPlugin>('http')`, or injected as `HttpPlugin`) exposes
`address` (`{ host, port, family, url }`, `String(address)` is the URL; `undefined` when not
listening), `inject(request)`, `routes`, `adapter` and `inflight`.

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
handler, so your other routes keep Fastify's parsers. Created instances use
`exposeHeadRoutes: false` (Znight serves HEAD), a `maxParamLength` of 8 KiB and a
`frameworkErrors` handler rendering Znight errors (with your own instance, malformed URLs are
answered by Fastify). `inject()` uses `fastify.inject()`.

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
body parsers for Znight routes (Znight reads the body itself).

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
`app.request()`.

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
without listening (`@znight/testing`'s `TestApp.inject()` delegates to it):

```ts
const http = HttpPlugin.configure({ port: 0 })
const app = await Application.create({ metadata, plugins: [http], overrides: [[UserRepository, fakeRepository]] })

const response = await http.inject({ method: 'POST', url: '/users', body: { name: 'Ada', email: 'ada@example.com' } })
expect(response.status).toBe(201)
expect(response.json()).toEqual({ id: 1, name: 'Ada', email: 'ada@example.com' })
```

`InjectRequest`: `{ method, url, headers?, body?, query? }` — strings and bytes are sent as is,
other bodies as JSON. `InjectResponse`: `{ status, headers, body, json() }` (lower-case header
names, repeated headers joined with `, `). For end-to-end tests over the network, start the
application with `port: 0` and use `String(http.address)` as the base URL.

## Lifecycle and graceful shutdown

| Plugin hook   | What happens                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `register`    | Declares the request-scoped externals `HttpContext` and `RequestId`, registers the plugin                                             |
| `onBootstrap` | Resolves options, controllers, guards, interceptors and mappers; validates and registers routes                                       |
| `onStart`     | Listens (logs the address)                                                                                                            |
| `onStop`      | Stops accepting connections, closes idle ones, waits for in-flight requests (`drainTimeoutMs`), then closes the remaining connections |
| `onDispose`   | Closes the server and the adapter                                                                                                     |

While draining, responses carry `connection: close`. Singletons (controllers, singleton guards,
interceptors and mappers) are resolved at bootstrap; request-scoped and transient ones on every
request. Bootstrap fails with `ZNIGHT007` for invalid or duplicate routes and `ZNIGHT001` for
controllers, guards or interceptors that are not providers.

## Compiler contract

This section is the stable contract between the runtime and the compiler extension
(`@znight/http/compiler`). Generated code only uses what is listed here.

### Metadata (`metadata.extensions.http`)

Types: `HttpMetadata`, `HttpControllerDefinition`, `HttpRouteDefinition`, `HttpParamDefinition`
(exported from `@znight/http`; architecture §9.1).

```ts
extensions: {
  http: {
    controllers: [
      {
        token: 'src/users/user.controller.ts#UserController', // provider token (@Controller registers the provider)
        basePath: '/users',                                     // normalizePath(controller path), '/' when absent
        guards: ['src/auth/auth.guard.ts#AuthGuard'],            // @UseGuard on the class, provider tokens, in order
        interceptors: [],                                       // @UseInterceptor on the class
        meta: { roles: ['admin'] },                             // createRouteDecorator values on the class
        routes: [
          {
            method: 'GET',                    // 'GET'|'POST'|'PUT'|'PATCH'|'DELETE'|'HEAD'|'OPTIONS'|'ALL'
            path: '/:id',                     // normalizePath(decorator path)
            fullPath: '/users/:id',           // joinPaths(basePath, path) — WITHOUT the plugin prefix
            handler: 'find',
            status: 202,                      // @HttpCode, omitted when absent
            headers: { 'cache-control': 'no-store' }, // @Header (lower-case names), omitted when absent
            meta: { public: true },           // route createRouteDecorator values
            guards: [],                       // @UseGuard on the method
            interceptors: [],                 // @UseInterceptor on the method (top-most first)
            params: [{ index: 0, source: 'param', name: 'id', type: 'number' }],
            rawResponse: true,                // only when the handler takes @Res()
            invoke: (c: UserController, ctx: HttpContext) => c.find(coerce.number(ctx.params['id'], 'param "id"')),
          },
        ],
      },
    ],
  },
}
```

Rules:
- Optional fields (`status`, `headers`, `rawResponse`, param `name`/`type`/`optional`/`schema`)
  are omitted when absent (`exactOptionalPropertyTypes`).
- `meta` values: a `createRouteDecorator` call without argument stores `true`. A decorator is a
  route decorator when its callee is a `const` initialised with a call to
  `@znight/http#createRouteDecorator`; its `key` (first argument) is static.
- `@Validate(S)` applies `S` to the `@Body()` parameter (`@Validate(S)` + `@Body()` ≡ `@Body(S)`);
  `@Validate(S)` + `@Body(S2)` is ZNIGHT005. Without a `@Body()` parameter the body is still
  validated (and discarded): `invoke: async (c, ctx) => { await validate(S, await ctx.parseBody(), 'body'); return c.m() }`.
- The plugin parses the body before the interceptors when `params` contains a `source: 'body'`
  entry; `ctx.body` is `undefined` otherwise (generated code then uses `await ctx.parseBody()`).
- Guards, interceptors and controllers referenced by tokens must be providers (the compiler
  registers injectable helper classes, §6.5 `resolveClassRef`). Request-scoped guards/interceptors
  are allowed.
- Path validation and joining must use `@znight/http/path` (pure module, safe to import from the
  compiler): `joinPaths`, `normalizePath`, `checkRoutePath` (→ `RoutePathIssue | undefined` for
  ZNIGHT007), `parseRoutePath(path).params` (to check `:param` ↔ `@Param` names) and
  `parseRoutePath(path).shape` (duplicate detection: same method + same shape = ZNIGHT007; `ALL`
  conflicts only with another `ALL`).

### `invoke` generation

`invoke(controller, ctx)` extracts every argument in parameter order and calls the handler. It is
`async` and `await`s every `validate()` call when the route has at least one schema; otherwise it
is synchronous. It returns the handler result as is (promises included).

| Parameter                               | Generated expression                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| `@Param('id') id: T`                    | `coerce.X(ctx.params['id'], 'param "id"')` (see below)                         |
| `@Param('id', S)`                       | `await validate(S, ctx.params['id'], 'param "id"')`                            |
| `@Param()`                              | `ctx.params as never` · with schema: `await validate(S, ctx.params, 'params')` |
| `@Query('page') page: T`                | `coerce.X(ctx.query['page'], 'query "page"')`                                  |
| `@Query('page', S)`                     | `await validate(S, ctx.query['page'], 'query "page"')`                         |
| `@Query()` / `@Query(S)`                | `ctx.query as never` / `await validate(S, ctx.query, 'query')`                 |
| `@Body()` / `@Body(S)` / `@Validate(S)` | `ctx.body as never` / `await validate(S, ctx.body, 'body')`                    |
| `@Headers('X-Api-Key') key: T`          | `coerce.X(ctx.headers['x-api-key'], 'header "x-api-key"')` (name lower-cased)  |
| `@Headers()`                            | `ctx.headers as never`                                                         |
| `@Req()` / `@Res()`                     | `ctx.request as never` / `ctx.response as never` (+ `rawResponse: true`)       |
| `@Ctx()`                                | `ctx`                                                                          |

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

Labels are `param "<name>"`, `query "<name>"`, `header "<lower-case name>"`; validation locations
are the same, or `params`, `query`, `body` for whole objects. A route parameter is always present
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
```

Every coercion failure throws `BadRequestException` (400); `validate` throws `ValidationException`
(400, `details: [{ path, message }]`) and `TypeError` when `schema` is not a Standard Schema.
Generated modules import them with `import { coerce, validate } from '@znight/http'` and the context
type with `import type { HttpContext } from '@znight/http'`.

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
`#UseGuard`, `#UseInterceptor`, `#Validate`, `#createRouteDecorator`. `@Param`/`@Query` take
either a static name (string) and an optional schema, or a schema alone.

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
}
```

- Translate `route.path` with `@znight/http/path` (`toFastifyPath`, `toHonoPath`, `toRegExpSource`)
  or match it with `matchRoutePath` / the segment trie. Routes arrive sorted (HEAD first, most
  specific first), ready for first-match routers.
- Build an `AdapterRequest` (`method`, raw `url`, lower-case `headers`, `readBody(limit)`, native
  `raw`/`rawResponse`) and write the `AdapterReply` (`status`, `headers`, `body`: bytes, stream or
  `null`; write nothing when `raw`).
- Parameters, query, body parsing, HEAD bodies and errors are handled by the plugin: do not parse
  bodies or decode parameters in the adapter.

## Limitations

- No built-in CORS, compression, static files or cookies parsing yet: use the native ecosystem
  through the Fastify / Express / Hono adapters (their middleware runs before Znight routes).
- Request bodies are buffered (up to `bodyLimit`); stream large uploads from `@Req()`.
- Compressed request bodies are rejected (415).
- Request-scoped instances are disposed before a streamed response body is fully sent.
- `inject()` with the `node` and `express` adapters needs `light-my-request`.
