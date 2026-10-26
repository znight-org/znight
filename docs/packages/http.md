---
description: "@znight/http - controllers, routing, parameter coercion, schema validation, guards, interceptors and error handling on Fastify, Express or Hono."
---

# @znight/http <Badge type="warning" text="in development" />

HTTP controllers for Znight. Routes are analysed by the compiler (paths, parameters, types, schemas,
guards) and served by the adapter of your choice: Fastify, Express or Hono.

<!-- TODO(api): verify against implementation (this page follows the specification; names and options may change) -->

```sh
npm install @znight/http fastify     # or: express, or hono + @hono/node-server
```

::: code-group

```ts [src/main.ts]
import { Application } from '@znight/core'
import { HttpPlugin } from '@znight/http'
import { fastify } from '@znight/http/fastify'
import { __ZNIGHT_METADATA__ } from './.znight/container.generated.js'

const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins: [HttpPlugin.configure({ adapter: fastify(), port: 3000, prefix: '/api' })],
})
await app.start()
```

:::

## Controllers and routes

```ts
import { Controller, Delete, Get, HttpCode, Param, Post, Body, Query } from '@znight/http'

@Controller('/users')
export class UserController {
  constructor(private readonly users: UserService) {}

  @Get('/')
  list(@Query('page') page: number = 1, @Query('tags') tags: string[] = []) {
    return this.users.list({ page, tags })
  }

  @Get('/:id')
  get(@Param('id') id: number) {
    return this.users.get(id)
  }

  @Post('/')
  create(@Body(CreateUserSchema) input: CreateUser) {
    return this.users.create(input) // 201 Created
  }

  @Delete('/:id')
  @HttpCode(204)
  async remove(@Param('id') id: number) {
    await this.users.remove(id)
  }
}
```

- `@Controller(path?)` or `@Controller({ path?, scope? })`: a provider (singleton by default) whose
  methods are routes.
- Route decorators: `@Get`, `@Post`, `@Put`, `@Patch`, `@Delete`, `@Head`, `@Options`, `@All`.
- **Path grammar**: static segments, `:name` parameters and a trailing `*` wildcard. Anything else
  (regular expressions, optional segments) is [`ZNIGHT007`](/reference/error-codes#znight007), as are
  duplicate method + path pairs and `:params` without a matching `@Param()`.
- `HEAD` is served for every `GET` route. A trailing-slash policy (strict by default) is applied the
  same way on every adapter.
- Paths can be built from constants: ``@Controller(`${API_V1}/users`)`` is evaluated at build time.

## Parameters

| Decorator                | Injects                                                    |
| ------------------------ | ---------------------------------------------------------- |
| `@Param(name?, schema?)` | A path parameter (or all of them without `name`)           |
| `@Query(name?, schema?)` | A query parameter (or the whole query object)              |
| `@Body(schema?)`         | The parsed request body                                    |
| `@Headers(name?)`        | A header (lower-cased name) or all headers                 |
| `@Ctx()`                 | The adapter-neutral `HttpContext`                          |
| `@Req()` / `@Res()`      | The raw adapter request / response (escape hatch, warning) |

**Coercion.** Path and query values are strings on the wire; Znight coerces them from the
**declared parameter type** in generated code: `string`, `number`, `boolean`, literal unions, and
arrays of those (`T[]` also accepts a single value). An invalid value is a `400 Bad Request` naming
the parameter. A type that cannot be coerced from a string is a build error
([`ZNIGHT007`](/reference/error-codes#znight007)).

Parameters with a default value or marked optional (`?`) may be absent.

## Validation

Pass a schema to `@Body()`, `@Query()` or `@Param()` (or use `@Validate(schema)` on the method as
sugar for `@Body(schema)`):

```ts
import { z } from 'zod'

export const CreateUserSchema = z.object({
  email: z.email(),
  name: z.string().min(2),
  role: z.enum(['admin', 'member']).default('member'),
})
export type CreateUser = z.infer<typeof CreateUserSchema>

@Post('/')
create(@Body(CreateUserSchema) input: CreateUser) {
  // input.role is 'member' when omitted: handlers receive the schema output
}
```

- Handlers receive the schema **output** (defaults, transforms, stripped keys).
- Failures answer `400` with `details: [{ path, message }]`.
- Schemas must be **exported** (the generated module imports them).
- Zod and Valibot are supported.
- A non-primitive `@Body()`, `@Query()` or `@Message()` without a schema is reported as
  [`ZNIGHT017`](/reference/error-codes#znight017): a warning, or an error with the compiler's
  `strictValidation` option.

<!-- TODO(api): verify against implementation (supported schema libraries, Standard Schema support) -->

## Responses

| Handler returns                 | Response                                         |
| ------------------------------- | ------------------------------------------------ |
| Object / array                  | JSON                                             |
| `string`                        | `text/plain`                                     |
| `Uint8Array` / `ReadableStream` | `application/octet-stream`                       |
| Web `Response`                  | Sent as is                                       |
| `undefined`                     | Empty body, `204` (unless `POST` or `@HttpCode`) |

Status precedence: `@HttpCode(status)` > `HttpResponse.status` > default (`201` for `POST`, `200`
otherwise). Add static headers with `@Header(name, value)`.

## Errors

Throw `HttpException(status, message, details?)` (or one of its subclasses) for expected failures:

```ts
import { HttpException } from '@znight/http'

if (user === undefined) throw new HttpException(404, `User ${id} not found`)
```

```json
{ "statusCode": 404, "error": "Not Found", "message": "User 42 not found" }
```

Any other error becomes `{ "statusCode": 500, "error": "Internal Server Error" }`: the message is
only exposed with `exposeErrors: true`, and the error is reported to hooks and the logger. Map your
own error types to responses with the `exceptionMappers` option.

## Guards

A guard is a provider deciding whether a request may proceed. Apply it with `@UseGuard()` on a
controller or a route, or globally with the `guards` option:

```ts
@Injectable()
export class ApiKeyGuard implements Guard {
  constructor(private readonly config: SecurityConfig) {}

  canActivate(ctx: HttpContext): boolean {
    return ctx.headers['x-api-key'] === this.config.apiKey
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

export const Roles = createRouteDecorator<string[]>('roles')
export const Public = createRouteDecorator<true>('public')

@Get('/stats')
@Roles(['admin'])
stats() {}
```

## Interceptors

`@UseInterceptor()` wraps route execution (global → controller → route), seeing the context and the
result: response mapping, caching, timing. For business-level interception of any provider method,
use [`@Intercept()`](/guide/aop).

## Request context

Each request runs in its own [request scope](/guide/scopes#request-scopes) seeded with request-scoped
externals:

- `HttpContext`: the adapter-neutral request/response context (params, query, headers, route...);
- `RequestId`: the request identifier.

Inject them in request-scoped providers, or through `Lazy<HttpContext>` in singletons.

## The request pipeline

```txt
container.runInScope({ HttpContext, RequestId })
└─ hooks.run('http:request', event)
   ├─ global guards → controller guards → route guards
   ├─ global → controller → route interceptors
   │  └─ invoke: extract → coerce → validate → handler
   ├─ serialise the result
   └─ map exceptions to a response (event.status / event.error are set)
```

Observers such as `@znight/observability` wrap `http:request` to log, measure and trace every
request.

## Plugin options

`HttpPlugin.configure(options)`, or `HttpPlugin.configure(container => options)`:

| Option             | Description                                              |
| ------------------ | -------------------------------------------------------- |
| `adapter`          | `fastify()`, `express()` or `hono()`                     |
| `port`, `host`     | Listening address                                        |
| `prefix`           | Path prefix for every route (`/api`)                     |
| `guards`           | Global guards (classes)                                  |
| `interceptors`     | Global interceptors (classes)                            |
| `exceptionMappers` | Map error types to responses                             |
| `trailingSlash`    | Trailing-slash policy (strict by default)                |
| `exposeErrors`     | Include messages of unexpected errors in `500` responses |
| `bodyLimit`        | Maximum request body size                                |

## Adapters

| Adapter   | Peer dependencies           | Notes                                           |
| --------- | --------------------------- | ----------------------------------------------- |
| `fastify` | `fastify`                   | `exposeHeadRoutes` disabled: Znight serves HEAD |
| `express` | `express`                   | In-memory injection via `light-my-request`      |
| `hono`    | `hono`, `@hono/node-server` | Fetch-style handler                             |

Every adapter implements `inject(request)`: requests handled in memory, without a socket, which is
what [`TestApp`](/guide/testing#testapp-end-to-end-tests) uses.
