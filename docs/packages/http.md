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
import { HttpPlugin } from '@znight/http'
import { createApplication } from './.znight/container.generated.js'

const app = await createApplication({
  plugins: [HttpPlugin.configure({ port: 3000, prefix: '/api' })], // built-in node:http adapter
})
await app.start() // SIGINT / SIGTERM: stop accepting connections, drain, close
```

```ts [with Fastify]
import { HttpPlugin } from '@znight/http'
import { fastifyAdapter } from '@znight/http/fastify'

HttpPlugin.configure({ adapter: fastifyAdapter(), port: 3000, trustProxy: 1 }) // one load balancer in front
```

:::

The complete reference (every option, the compiler contract, how to write an adapter) is the
[package README](../../packages/http/README.md).
::: tip Guide
This page is the reference. To learn how to build an API, read the guides:
[Controllers and routes](/guide/http), [Validation](/guide/validation),
[Files and streaming](/guide/files-and-streaming) and [Security](/guide/security).
:::

## Entry points

| Import                 | What it provides                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `@znight/http`         | Decorators, `HttpPlugin`, `HttpResponse`, exceptions, `nodeAdapter()` (built-in server) |
| `@znight/http/fastify` | `fastifyAdapter()` (peer: `fastify`)                                                    |
| `@znight/http/express` | `expressAdapter()` (peer: `express`)                                                    |
| `@znight/http/hono`    | `honoAdapter()` (peers: `hono`, `@hono/node-server` on Node.js)                         |

## Controllers and routes

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

How to write controllers: [Controllers and routes](/guide/http#controllers).

## Parameters

| Decorator                    | Injects                                                              |
| ---------------------------- | -------------------------------------------------------------------- |
| `@Param(name?, schema?)`     | A path parameter (or all of them without `name`)                     |
| `@Query(name?, schema?)`     | A query parameter (or the whole query object)                        |
| `@Body(schema?)`             | The parsed request body                                              |
| `@Headers(name?)`            | A header (lower-cased name) or all headers                           |
| `@Cookie(name?, schema?)`    | A request cookie (or all of them), coerced like a header             |
| `@SignedCookie(name, s?)`    | The verified value of a [signed cookie](#signed-cookies)             |
| `@UploadedFile(field?, o?)`  | An uploaded `File` of a multipart body ([uploads](#uploads))         |
| `@UploadedFiles(field?, o?)` | The uploaded files of a field (`File[]`)                             |
| `@Ctx()`                     | The adapter-neutral `HttpContext`                                    |
| `@Req()` / `@Res()`          | The native adapter request / response (escape hatch; `@Res()` warns) |

**Coercion.** Path, query and header values are coerced from the **declared parameter type** in
generated code: `string`, `number`, `boolean`, `bigint`, `Date`, literal unions, enums, branded
primitives and arrays of those (`T[]` also accepts a single value). A `Date` is an ISO 8601 date
(`2024-01-02`), a date-time **with** an offset (`2024-01-02T10:00:00Z`, `+02:00`) or a millisecond
timestamp: impossible dates and date-times without offset are rejected. An invalid value is a
`400 Bad Request` naming the parameter. A type that cannot be coerced from a string is a build error
([`ZNIGHT007`](/reference/error-codes#znight007)) for `@Param` / `@Headers`. Parameters with a
default value, `?` or `| undefined` may be absent (`undefined` is injected, so default values
apply).

## Validation

Moved to the [Validation guide](/guide/validation): Standard Schema libraries, the schema output,
the error format and `ValidationException`, and [`ZNIGHT017`](/reference/error-codes#znight017)
for unvalidated inputs.

## Request bodies

Bodies are parsed by Znight (identically on every adapter), after the guards and before the
interceptors, for routes declaring `@Body()` or upload parameters; other routes read them lazily
with `ctx.parseBody()`, `ctx.rawBody()` or `ctx.bodyStream()`
([how](/guide/http#request-bodies)).

| `content-type`                      | Body                                                                  |
| ----------------------------------- | --------------------------------------------------------------------- |
| (empty body)                        | `undefined`                                                           |
| `application/json`, `*/*+json`      | parsed JSON (`400` when malformed)                                    |
| `text/*`                            | string (charset honoured)                                             |
| `application/x-www-form-urlencoded` | record, repeated keys as arrays                                       |
| `multipart/form-data`               | record of the text fields; files in `ctx.files` ([uploads](#uploads)) |
| anything else / none                | `Uint8Array`                                                          |

Bodies above the body limit answer `413` (plugin `bodyLimit`, 1 MiB by default, or
`@BodyLimit('10mb')` on a route or a controller); a `content-encoding` other than `identity` answers
`415`.

## Responses

| Handler returns                                 | Response                                                       |
| ----------------------------------------------- | -------------------------------------------------------------- |
| Object / array / number / boolean / `null`      | JSON                                                           |
| `string`                                        | `text/plain; charset=utf-8`                                    |
| `Uint8Array` / `ArrayBuffer`                    | `application/octet-stream`                                     |
| `ReadableStream` / Node.js `Readable`           | streamed `application/octet-stream`                            |
| `Blob` / `File`                                 | its bytes, with its type and size                              |
| `HttpResponse.file()` / `HttpResponse.stream()` | a file or a stream ([Files](/guide/files-and-streaming#files)) |
| `HttpResponse`                                  | its body, status and headers                                   |
| Web `Response`                                  | sent as is                                                     |
| `undefined`                                     | empty body, `204` (`201` for `POST`)                           |

Status precedence: `@HttpCode(status)` > `HttpResponse.status` > default (`201` for `POST`, `204`
without body, `200` otherwise). Headers: content type < `@Header` < `ctx.setHeader()` <
`HttpResponse` headers.

## Files

Moved to [Files and streaming](/guide/files-and-streaming#files): uploads, downloads, lazy files,
streaming responses, large files and their security. The options and limits stay here.

### Upload options {#uploads}

`@UploadedFile(field?, options?)` and `@UploadedFiles(field?, options?)`; without a field, they take
the files of any field.

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

Moved to [Downloads](/guide/files-and-streaming#downloads):
`HttpResponse.file(path | URL | Blob | LazyFile, { root?, dotfiles?, filename?, disposition?, contentType? })`,
and [lazy files](/guide/files-and-streaming#lazy-files) for content stored elsewhere.

### Streaming responses

Moved to [Streaming responses](/guide/files-and-streaming#streaming-responses):
`HttpResponse.stream(source, options?)`.

### Large files

Moved to [Large files](/guide/files-and-streaming#large-files).

### Security {#security}

Moved to [Security](/guide/files-and-streaming#file-security): client file names and types, `root`,
where to store uploads and limits.

## Errors

Moved to [Controllers and routes](/guide/http#errors): `HttpException` and its subclasses, the error
body, `exposeErrors` and exception mappers (the `exceptionMappers` option). The
[package README](../../packages/http/README.md) lists every exception class.

## Guards

A guard is a provider implementing `CanActivate` (`canActivate(ctx)`: anything but `true` answers
`403`), applied with `@UseGuard()` on a controller or a route, or globally with the `guards` option.
Order: global guards → controller guards → route guards. A guard that enforces
[route decisions](#route-metadata-and-decisions) declares them in a static `enforces` array, checked
when the plugin boots. How to write one:
[Guards and interceptors](/guide/http#guards-and-interceptors).

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

Moved to [Guards and interceptors](/guide/http#guards-and-interceptors): `@UseInterceptor()` wraps
route execution (global → controller → route, the first one being the outermost). For
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
`true` is refused at boot: trusting every hop lets any client choose its `ctx.ip`. The same goes for
`trustProxy: true` in the options of `fastifyAdapter()` and for an Express application whose
`trust proxy` trusts any address, unless the `trustProxy` option of `HttpPlugin` is set: `ctx.ip`
then follows the Znight option and ignores the framework's address.

## Cookies

How to read, set, sign and test cookies: [Cookies](/guide/http#cookies). The reference follows.

### Reading cookies

| Decorator / member          | Injects                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `@Cookie('name') v: T`      | The decoded cookie, coerced to `T` like a header; absent and required: 400 `Missing cookie`  |
| `@Cookie('name', schema)`   | The decoded value (or `undefined`) validated with a Standard Schema (its output is injected) |
| `@Cookie()` / `@Cookie(S)`  | Every cookie (`Record<string, string>`), validated by `S` when given                         |
| `@SignedCookie('name', S?)` | The verified value of a [signed cookie](#signed-cookies): tampered or unsigned means absent  |
| `ctx.cookies`               | Every request cookie (a frozen record without prototype, parsed on first access)             |
| `ctx.signedCookie(name)`    | The verified value, or `undefined`                                                           |

### Cookie options {#setting-cookies}

`ctx.setCookie(name, value, options?)`, `ctx.clearCookie(name, options?)` and
`HttpResponse.withCookie(name, value, options?)` / `withoutCookie(name, options?)`:

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

Moved to [Testing cookies](/guide/http#testing-cookies).

## Server-Sent Events

Moved to [Files and streaming](/guide/files-and-streaming#server-sent-events): `@Sse()`, the event
sources, `EventChannel`, the stream lifecycle and shutdown. The options of `@Sse(path?, options?)`
and `HttpResponse.sse(source, options?)`:

| Option        | Default                           | Description                                                                                              |
| ------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `heartbeat`   | plugin `sse.heartbeat` (8 000 ms) | Keep-alive comment after this many ms without an event (1 000 to 2^31 − 1), or `false`                   |
| `retry`       | plugin `sse.retry` (none)         | Client reconnection delay, sent first                                                                    |
| `maxDuration` | none                              | Ends the stream gracefully after this many ms (1 000 to 2^31 − 1, about 24.8 days): rebalancing, re-auth |

`encodeSseEvent()` and `parseSseStream()` (a `ReadableStream` to its events) are exported.

### Stream lifecycle

Moved to [Stream lifecycle](/guide/files-and-streaming#stream-lifecycle): backpressure, client
disconnects, errors, `maxDuration` and shutdown.

### Testing event streams

Moved to [Files and streaming](/guide/files-and-streaming#testing-event-streams): `injectSse()` and
`injectStream()`, on the plugin and on `TestApp`.

## Request context

`HttpContext` (the adapter-neutral request and response) and `RequestId` are request-scoped
externals: inject them in request-scoped providers, or through `Lazy<HttpContext>` in singletons.
[The request context](/guide/http#request-context) shows how; the
[package README](../../packages/http/README.md) lists every member of `HttpContext`.

## The request pipeline

Moved to [The request pipeline](/guide/http#pipeline).

## Plugin options

`HttpPlugin.configure(options)`, or `HttpPlugin.configure(container => options)`:

| Option              | Default               | Description                                                                                 |
| ------------------- | --------------------- | ------------------------------------------------------------------------------------------- |
| `adapter`           | `nodeAdapter()`       | `fastifyAdapter()`, `expressAdapter()`, `honoAdapter()`...                                  |
| `port`, `host`      | `3000`, `0.0.0.0`     | Listening address (`port: 0`: a free port)                                                  |
| `prefix`            | —                     | Path prefix for every route (`/api`)                                                        |
| `guards`            | `[]`                  | Global guards (classes or instances)                                                        |
| `interceptors`      | `[]`                  | Global interceptors                                                                         |
| `exceptionMappers`  | `[]`                  | Map error types to responses                                                                |
| `trailingSlash`     | `'strict'`            | `'strict'`, `'ignore'` or `'redirect'`                                                      |
| `exposeErrors`      | `false`               | Include messages of unexpected errors in `500` responses                                    |
| `bodyLimit`         | 1 MiB                 | Maximum request body size (bytes or `'10mb'`)                                               |
| `uploads`           | see [Files](#uploads) | `{ maxFileSize, maxFiles, maxParts, maxFieldSize }`                                         |
| `requestIdHeader`   | `x-request-id`        | Header read and echoed (`false`: always generate)                                           |
| `generateRequestId` | `crypto.randomUUID()` | Request id generator, used when the header is absent, invalid or `requestIdHeader: false`   |
| `drainTimeoutMs`    | `4000`                | Maximum wait for in-flight requests on shutdown (`Infinity`: no limit)                      |
| `cors`              | off                   | [CORS](#cors) policy: `{ origin, credentials?, methods?, ... }`                             |
| `securityHeaders`   | `true`                | [Security headers](#security-headers): `true`, `false` or settings                          |
| `trustProxy`        | `false`               | [Trusted proxies](#behind-a-proxy): a hop count or addresses / CIDRs                        |
| `enforcement`       | `'error'`             | Unenforced [route decisions](#route-metadata-and-decisions): fail or warn                   |
| `cookies`           | —                     | `{ secrets?, defaults? }`: [signing keys](#signed-cookies) and [defaults](#setting-cookies) |
| `sse`               | —                     | `{ heartbeat?, retry?, shutdownGraceMs? }` of [event streams](#server-sent-events)          |

## Plugin routes

Other plugins can serve routes through `HttpPlugin` (the OpenAPI document, status endpoints) by
implementing `PluginHttpRoutes`: `httpRoutes({ prefix, container })` returns
`{ method, path, name, handler, meta?, guards?, bodyLimit? }` entries. They are registered on every
adapter in the same pipeline as the controllers (the `http:request` hook, the global guards, then
their own), take their route decisions from `meta` (`[Public.meta()]`), and are listed in
`HttpPlugin.routes` with the plugin name as `source`. `bodyLimit` (`'100kb'`, bytes, `Infinity`)
replaces the plugin `bodyLimit` for that route only: a larger body answers `413`. An invalid route
or a path collision is [`ZNIGHT007`](/reference/error-codes#znight007) naming the plugin. An optional
`onHttpDrain()` is called when `HttpPlugin` starts draining, whatever the plugin order: the plugin
ends there the long-lived streams its routes serve, so that the drain does not wait for them.

## Adapters

| Adapter                                     | Peer dependencies           | Notes                                                                                 |
| ------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------- |
| `nodeAdapter()` (`@znight/http`)            | none                        | Built-in `node:http` server (also works on Bun)                                       |
| `fastifyAdapter()` (`@znight/http/fastify`) | `fastify`                   | `exposeHeadRoutes` disabled: Znight serves HEAD; `instance`, `notFound` (see below)   |
| `expressAdapter()` (`@znight/http/express`) | `express`                   | Your middleware runs before the Znight routes                                         |
| `honoAdapter()` (`@znight/http/hono`)       | `hono`, `@hono/node-server` | `Bun.serve()` on Bun (`serveOptions`, no 128 MiB cap), `@hono/node-server` on Node.js |

With your own Fastify instance (`fastifyAdapter({ instance })`), Znight registers its routes in an
encapsulated context without a prefix, which shares the not-found handler of the root instance
(Fastify 5 allows one per level). When your instance already has one (a rate-limited 404, the
routes you are migrating), Znight leaves unknown URLs to it; `notFound: 'instance'` does so even
for a handler set after Znight's context loads, and `notFound: 'znight'` refuses such an instance.
Either way, the paths of Znight routes keep Znight's `405`, automatic `OPTIONS` and CORS preflights,
without any extra route (your routes, wildcards included, keep the requests they match):

```ts
import { HttpPlugin } from '@znight/http'
import { fastifyAdapter } from '@znight/http/fastify'
import Fastify from 'fastify'

const instance = Fastify()
instance.setNotFoundHandler((request, reply) => {
  reply.code(404).send({ message: `No route for ${request.url}` })
})

HttpPlugin.configure({ adapter: fastifyAdapter({ instance, notFound: 'instance' }) })
```

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
