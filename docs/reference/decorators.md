---
description: Every Znight decorator by package, with its target and how the compiler evaluates its arguments.
---

# Decorators

Znight decorators are **markers**: they do nothing at runtime and are stripped from the bundle. The
compiler recognises them by identity (renamed imports and re-exports work) and evaluates their
arguments at build time. A `const` alias (`export const Service = Injectable`) or a function
returning a decorator (`const Timed = () => Intercept(TimingInterceptor)`) is not followed: the
compiler never runs your code, so it ignores the decorator with a
[`ZNIGHT005`](/reference/error-codes#znight005) warning. Re-export it under another name instead
(`export { Injectable as Service } from '@znight/core'`), or declare a shorthand in a package
manifest ([below](#znight-core)).

Arguments come in two kinds:

- **static**: must evaluate at build time (literals, `const` references across files and packages,
  template literals, arithmetic, `as const`...). Paths, names, scopes, queue and env names, retry
  policies, `@Default` values, body limits and upload options are static.
- **value**: evaluated when possible, otherwise a reference to an **exported** binding that the
  generated module imports. Schemas, guards, interceptors and interceptor options are values.

Anything else is [`ZNIGHT005`](/reference/error-codes#znight005), with the fix-it "extract to
`export const X = ...`".

## `@znight/core`

| Decorator                                                     | Target                              | Arguments                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@Injectable(opts?)`                                          | class                               | static `{ scope?, name?, primary? }`                                                                                                                                                                                                                                             |
| `@Factory()`                                                  | class                               | —: a singleton whose `@Provides` methods produce providers                                                                                                                                                                                                                       |
| `@Provides(opts?)`                                            | method of a `@Factory`              | static `{ scope?, name?, primary?, dispose? }`. The explicit return type is the provided type (`Promise<T>` → async, singletons only); parameters are injected                                                                                                                   |
| `@Inject(name)`                                               | constructor / `@Provides` parameter | static string qualifier                                                                                                                                                                                                                                                          |
| `@Optional()`                                                 | constructor / `@Provides` parameter | —                                                                                                                                                                                                                                                                                |
| `@Named(name)`                                                | class / `@Provides` method          | static string                                                                                                                                                                                                                                                                    |
| `@Primary()`                                                  | class / `@Provides` method          | —                                                                                                                                                                                                                                                                                |
| `@Intercept(Interceptor, options?)`                           | instance method of a provider       | `Interceptor`: value (a provider class implementing `MethodInterceptor<O>`); `options`: value, required unless `O` accepts `undefined`. The top-most is the outermost; inherited from analysable base classes; not on a static, `#private` or computed-name method               |
| `@X(options?)` declared in `package.json#znight.interceptors` | instance method of a provider       | `options`: value; the same as `@Intercept(XInterceptor, options)`: how `@Logged()` works ([AOP](/guide/aop#shorthand-decorators-in-your-own-packages))                                                                                                                           |
| `createParamDecorator<T, D>(resolvers)`                       | an exported top-level `const`       | `T` (required): the injected type; `D`: the data argument (none by default); `resolvers`: an object literal, one entry per transport (`http`, `graphql`, `messaging`), a function `(ctx, data) => T \| PromiseLike<T>` or a provider class implementing `ParamResolver<C, T, D>` |

`createParamDecorator` (RFC 0010) defines your own parameter decorators, such as `@CurrentUser()`
or `@Claim('sub')`, for HTTP routes, GraphQL fields and message handlers. Their data argument is a
value, required when `D` excludes `undefined`. The generated `invoke` of each handler calls the
resolver of its transport directly (`CurrentUser.resolvers.http(ctx, data)`). A definition that is
not exported or has no type argument, and a use that is not called, sits on a constructor or rest
parameter, next to another parameter decorator, on a handler whose transport has no resolver or on
a parameter that does not accept `T`, are [`ZNIGHT005`](/reference/error-codes#znight005).

```ts
import { createParamDecorator } from '@znight/core'
import type { User } from './user.ts'

export const CurrentUser = createParamDecorator<User>({
  http: ctx => ctx.state.get('user') as User,
})

// @Get('/me') me(@CurrentUser() user: User) { ... }
```

Type helpers: `Lazy<T>`, read by the compiler (a handle resolved when `get()` is called, in the
current scope: it breaks cycles and lets a singleton use a request-scoped provider, see
[`ZNIGHT003`](/reference/error-codes#znight003)); `MethodInterceptor<O>` and `MethodInvocation` to
write interceptors.
Lifecycle members found on a provider or its analysable bases: `onStart()`, `onReady()`, `onStop()`
(interfaces `OnStart`, `OnReady`, `OnStop`), `[Symbol.asyncDispose]()` and `[Symbol.dispose]()`,
checked by [`ZNIGHT009`](/reference/error-codes#znight009).

Guides: [Dependency injection](/guide/dependency-injection) · [Scopes](/guide/scopes) ·
[AOP](/guide/aop) · [Lifecycle](/guide/lifecycle) · [Custom parameter decorators](/guide/custom-parameters)

## `@znight/http`

| Decorator                                                                    | Target              | Arguments / notes                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@Controller(path?)` / `@Controller({ path?, scope? })`                      | class               | static; a provider (singleton by default)                                                                                                                                                                                                                                                                                                                       |
| `@Get` `@Post` `@Put` `@Patch` `@Delete` `@Head` `@Options` `@All` `(path?)` | method              | static path: static segments, `:params`, trailing `*`; several per method allowed                                                                                                                                                                                                                                                                               |
| `@Sse(path?, options?)` / `@Sse(options)`                                    | method              | static; a `GET` route serving a Server-Sent Events stream (`{ heartbeat?, retry?, maxDuration? }`, in ms; `heartbeat` and `maxDuration` at least 1000, `heartbeat: false` turns heartbeats off); not combinable with another route decorator; `@HttpCode`, `@Header('content-type')`, `@Res()` and a primitive return type are errors, a request body a warning |
| `@Param()` / `@Param(name, schema?)` / `@Param(schema)`                      | parameter           | static name, value schema; coerced to the parameter type (`number`, `boolean`, `Date`, literal unions...); without name: every route parameter, which consumes every `:param`                                                                                                                                                                                   |
| `@Query()` / `@Query(name, schema?)` / `@Query(schema)`                      | parameter           | static name, value schema; `T[]` accepts repeated and single values; without name: the whole query                                                                                                                                                                                                                                                              |
| `@Body(schema?)`                                                             | parameter           | value schema (its output is injected); on an upload route: the text fields of the form; a class that is not a schema is a warning                                                                                                                                                                                                                               |
| `@Headers(name?)`                                                            | parameter           | static name (case-insensitive), coerced to the parameter type; without name: all headers                                                                                                                                                                                                                                                                        |
| `@Cookie()` / `@Cookie(name, schema?)` / `@Cookie(schema)`                   | parameter           | static name, value schema; a request cookie coerced like a header (`400` when absent, unless optional); without name: every cookie                                                                                                                                                                                                                              |
| `@SignedCookie(name, schema?)`                                               | parameter           | static name, value schema; the verified value of a signed cookie (needs the plugin option `cookies.secrets`)                                                                                                                                                                                                                                                    |
| `@UploadedFile(field?, opts?)` / `@UploadedFile(opts)`                       | parameter           | static; the `File` of a `multipart/form-data` field (`File \| undefined` when optional); no field: the single file of the body                                                                                                                                                                                                                                  |
| `@UploadedFiles(field?, opts?)` / `@UploadedFiles(opts)`                     | parameter           | static; the `File[]` of a field, in body order; no field: every file of the body                                                                                                                                                                                                                                                                                |
| `@Req()` / `@Res()`                                                          | parameter           | raw adapter request / response (escape hatch); `@Req()` consumes every `:param`; `@Res()` is a warning (the handler writes the native response itself)                                                                                                                                                                                                          |
| `@Ctx()`                                                                     | parameter           | `HttpContext`                                                                                                                                                                                                                                                                                                                                                   |
| `createParamDecorator` decorators of `@znight/core`                          | parameter           | with an `http` resolver, which receives the `HttpContext`; runs in `invoke`, after the guards and the interceptors ([above](#znight-core))                                                                                                                                                                                                                      |
| `@HttpCode(status)`                                                          | method              | static integer from 100 to 599; the status of successful responses, wins over `HttpResponse.status` and the defaults                                                                                                                                                                                                                                            |
| `@Header(name, value)`                                                       | method (repeatable) | static strings; a header of successful responses                                                                                                                                                                                                                                                                                                                |
| `@BodyLimit(size)`                                                           | class / method      | static size: bytes or `'10mb'` (`kb` = 1024), `Infinity` for no limit; the method wins over the class                                                                                                                                                                                                                                                           |
| `@UseGuard(...guards)`                                                       | class / method      | value references to guard classes                                                                                                                                                                                                                                                                                                                               |
| `@UseInterceptor(...interceptors)`                                           | class / method      | value references to interceptor classes                                                                                                                                                                                                                                                                                                                         |
| `@Validate(schema)`                                                          | method              | sugar for `@Body(schema)`; using both is `ZNIGHT005`                                                                                                                                                                                                                                                                                                            |
| `createRouteDecorator<T>(key, options?)`                                     | —                   | creates metadata decorators (`@Roles(['admin'])`) for classes and methods; static options `{ group?, required? }` (below)                                                                                                                                                                                                                                       |

The errors and warnings of the table are [`ZNIGHT005`](/reference/error-codes#znight005). A body,
a whole query (`@Query()`) or every cookie (`@Cookie()`) injected without schema into a type that
is not a primitive is [`ZNIGHT017`](/reference/error-codes#znight017) (a warning, an error with
`strictValidation`).

Options of the upload decorators (static, evaluated at build time):

| Option      | Default                                  | Description                                                                        |
| ----------- | ---------------------------------------- | ---------------------------------------------------------------------------------- |
| `required`  | `true`, unless the parameter is optional | `400` when no file is sent; an optional parameter receives `undefined` (or `[]`)   |
| `maxSize`   | plugin `uploads.maxFileSize` (10 MiB)    | maximum size of **each** file: bytes, `'512kb'`, `'5mb'`, `Infinity` (`413` above) |
| `maxFiles`  | plugin `uploads.maxFiles` (10)           | `@UploadedFiles` only: maximum number of files (`413` above)                       |
| `mimeTypes` | any                                      | accepted media types: `'image/png'`, `'image/*'` (`415` otherwise)                 |

Each field is read by one upload parameter, and a parameter without field cannot be combined with
other upload parameters (`ZNIGHT005`). Upload parameters on a `GET`, `HEAD`, `DELETE` or `OPTIONS`
route are a `ZNIGHT005` warning. Routes with upload parameters only accept `multipart/form-data`
bodies (`415` otherwise).

```ts
@Post('/avatar')
@BodyLimit('3mb')
avatar(
  @UploadedFile('avatar', { maxSize: '2mb', mimeTypes: ['image/png', 'image/jpeg'] }) avatar: File,
  @Body(AvatarForm) form: z.output<typeof AvatarForm>,
) {}
```

Route decorators created with `createRouteDecorator` take their argument as a value (`true` when
omitted) and store it in the route metadata. Decorators sharing a `group` are alternatives: one per
class or method ([`ZNIGHT005`](/reference/error-codes#znight005) otherwise), and the method's
decision replaces the class's. With `required: true`, every route needs a decision of the group
([`ZNIGHT023`](/reference/error-codes#znight023)), and guards declare the decorators they enforce
in a static `enforces` array, checked at boot: a decision of a required group, or of a group a
guard class of the application enforces, needs such a guard in the chain of its route. A `group` is
a name of letters, digits, `_`, `.` and `-` starting with a letter; without `group`, any non-empty
key is its own group (`'auth:public'`). A route decorator is a `const` initialised with
`createRouteDecorator(key, options?)` in analysed sources (your application, or a provider library
published with its sources): from a declaration file (`.d.ts`) the compiler cannot read its key and
options, and reports it. Every definition of the analysed sources counts, applied or not: a required
group defined anywhere needs a decision on every route.

```ts
export const Public = createRouteDecorator('public', { group: 'access', required: true })
export const Roles = createRouteDecorator<readonly Role[]>('roles', { group: 'access', required: true })
```

At runtime, `Decorator.get(ctx)` reads the effective value of a decorator. `ctx` is any
`RouteMetaCarrier`, an object with an optional `route: { meta }`: the `HttpContext` of a request,
or the context of another transport that reuses route decorators. `Decorator.meta(value?)` returns
the same metadata as data, for [plugin routes](/packages/http#plugin-routes). Compiler extensions
read route decorators on their own classes and methods with `readRouteMeta`, `effectiveRouteMeta`
and `requiredRouteGroups` from `@znight/http/compiler`
([reference](../../packages/http/README.md#route-metadata-in-other-extensions)).

Guide: [HTTP](/packages/http) · [Files](/packages/http#files) · [Security](/guide/security)

## `@znight/messaging`

| Decorator                                                                                         | Target    | Arguments / notes                                                                                                                                         |
| ------------------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@Consumer(queue)` / `@Consumer({ queue, scope?, concurrency?, deadLetter?, ...driver options })` | class     | static; a provider (singleton by default)                                                                                                                 |
| `@OnMessage(type?)`                                                                               | method    | static; matches `message.type` exactly or as a pattern (`'order.*'`); none = default handler; several per method                                          |
| `@Retry({ attempts, backoff?, delay?, maxDelay? })`                                               | method    | static; `backoff`: `'fixed'` or `'exponential'` (default); unknown keys are `ZNIGHT011`                                                                   |
| `@OnError()`                                                                                      | method    | `(error, message) => void \| 'ack'`, when a message will not be retried anymore                                                                           |
| `@Message(schema?)`                                                                               | parameter | value schema (Standard Schema); the payload                                                                                                               |
| `@Headers(name?)`                                                                                 | parameter | static name; without name: all headers (`Record<string, string>`); with a name: `string \| undefined` (a parameter type without `undefined` is a warning) |
| `@Ctx()`                                                                                          | parameter | `InboundMessage`                                                                                                                                          |
| `createParamDecorator` decorators of `@znight/core`                                               | parameter | with a `messaging` resolver, which receives the `InboundMessage`; what it throws fails the delivery like a handler error ([above](#znight-core))          |

Every required parameter of an `@OnMessage` handler carries exactly one parameter decorator: none is
[`ZNIGHT011`](/reference/error-codes#znight011); several, or `Headers` / `Ctx` imported from
`@znight/http`, is [`ZNIGHT005`](/reference/error-codes#znight005). `@Message()` without schema on
a parameter that is not `unknown` or a primitive is [`ZNIGHT017`](/reference/error-codes#znight017)
(a warning, an error with `strictValidation`). Handlers and `@OnError` are inherited from base
classes the compiler can analyse.

Guide: [Messaging](/packages/messaging)

## `@znight/openapi`

| Decorator                                                                              | Target                    | Arguments / notes                                                                                           |
| -------------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `@OpenApiDocument(options?)`                                                           | class                     | value; the options of the document (one per application); the class is never instantiated                   |
| `@ApiOperation({ summary?, description?, operationId?, deprecated?, ... })`            | method                    | static; overrides the JSDoc and the defaults of the operation                                               |
| `@ApiTags(...names)`                                                                   | class / method            | static; class tags first                                                                                    |
| `@ApiResponse<T>(status, { description?, schema?, contentType?, headers?, example? })` | method (repeatable)       | static, `schema` value; `status` is a code, `'2XX'`-like or `'default'`; the body type from `T` or `schema` |
| `@ApiBody<T>({ description?, required?, contentType?, schema? })`                      | method                    | static, `schema` value; a body the handler reads itself                                                     |
| `@ApiQuery<T>(name, opts?)` / `@ApiHeader<T>(name, opts?)`                             | method / class and method | static; a parameter read outside the signature                                                              |
| `@ApiSecurity(...requirements)`                                                        | class / method            | value (`securityScheme()` constants); no argument: public                                                   |
| `@ApiExclude()`                                                                        | class / method            | —; left out of the document                                                                                 |

Type arguments (`@ApiResponse<Book[]>(200)`) are read by the compiler. `securityScheme(name,
definition)` declares a security scheme, statically evaluated like a route decorator. Parameters
with a [custom parameter decorator](/guide/custom-parameters) are not documented: describe the
header or cookie it reads with `@ApiHeader` or `@ApiSecurity`.

Guide: [OpenAPI](/packages/openapi)

## `@znight/schedule`

| Decorator                     | Target | Arguments / notes                                                                                                               |
| ----------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `@Cron(expression, options?)` | method | static; 5 or 6 fields, names, `L`, `#`, nicknames; `{ name?, enabled?, lock?, maxDuration?, timeZone?, overlap?, runOnStart? }` |
| `@Interval(every, options?)`  | method | static duration (`'30s'`, ms); `{ name?, enabled?, lock?, maxDuration?, overlap?, runOnStart? }`                                |
| `@Timeout(delay, options?)`   | method | static duration; runs once after the scheduler started; `{ name?, enabled?, lock?, maxDuration? }`                              |

A class with jobs becomes a singleton provider when nothing else registers it; any provider can
host jobs (`@Injectable`, `@Controller`, `@Consumer`...). A job is a public method declared by the
class itself: methods inherited from a base class are not jobs, and job decorators on an abstract
or generic class are [`ZNIGHT005`](/reference/error-codes#znight005), like a method that is also an
HTTP route or a message handler. Job methods take no parameter or one `ctx: JobContext`. A method
may carry several triggers when each has its own `name`; names are unique across the application
and its libraries ([`ZNIGHT041`](/reference/error-codes#znight041)). Invalid values are
[`ZNIGHT040`](/reference/error-codes#znight040), with the faulty field underlined.

Guide: [Schedule](/packages/schedule)

## `@znight/graphql`

| Decorator / function                                      | Target                          | Arguments / notes                                                                                                                                                                                                                                                  |
| --------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@Resolver(opts?)` / `@Resolver(type, opts?)`             | class                           | static `{ scope? }`; a provider (singleton by default); not on a `@Controller`. Schema-first: `type` names the SDL object type of its `@ResolveField` methods (an interface, a non-object or a root type is `ZNIGHT068`); a type name in code-first is `ZNIGHT005` |
| `@Query(name?)` `@Mutation(name?)` `@Subscription(name?)` | method                          | static name (default: the method name); a root field. Code-first: the explicit return type is the field type (`Promise<T>` unwrapped). Schema-first: binds the SDL root field of that name. `@Subscription` returns an `AsyncIterable<T>`                          |
| `@ResolveField(name?)`                                    | method                          | static name (default: the method name). Code-first: adds (or replaces) a field of the type of the `@Parent()` parameter, which is mandatory. Schema-first: binds the field of the type named by `@Resolver('Type')`, `@Parent()` optional                          |
| `@Args(name?, schema?)` / `@Args(schema)`                 | parameter                       | static name, value schema (Standard Schema, failure: `BAD_USER_INPUT`); without name: the properties of the parameter type are the arguments (schema-first: every argument as an object)                                                                           |
| `@Parent()` `@Ctx()` `@Info()`                            | parameter                       | —; the parent object (field resolvers only), the `GraphQLContext`, graphql-js `GraphQLResolveInfo`                                                                                                                                                                 |
| `@Loader()`                                               | parameter                       | —; typed `Loader<L>`, `L` a provider implementing `BatchLoad<K, V>`: the DataLoader of the current execution                                                                                                                                                       |
| `createParamDecorator` decorators of `@znight/core`       | parameter                       | with a `graphql` resolver, which receives the field's `ResolverContext`; runs after the guards, never a GraphQL argument ([above](#znight-core))                                                                                                                   |
| `@UseGuard(...guards)`                                    | class / method of a `@Resolver` | value references to guard classes implementing `GraphQLGuard`; run after the global guards                                                                                                                                                                         |
| `createRouteDecorator` decorators of `@znight/http`       | class / method of a `@Resolver` | field decisions (RFC 0001 groups), read by guards with `Decorator.get(ctx: ResolverContext)`                                                                                                                                                                       |
| `scalar<T>(name, definition)`                             | an exported `const`             | `T` read by the compiler, static `name`, value `definition` (`ScalarDefinition` or graphql-js `GraphQLScalarType`, whose name must be `name`); schema-first: binds the SDL scalar of that name                                                                     |

Every parameter of a field method carries exactly one parameter decorator: one of the table, or a
custom one with a `graphql` resolver. `Ctx`, `Query`, `Param`, `Body` or `UseGuard` imported from
`@znight/http` by mistake is [`ZNIGHT005`](/reference/error-codes#znight005) with the import to use.
Field methods are not inherited. In code-first, the JSDoc tags `@param`, `@deprecated`, `@default`,
`@gqlHidden` and `@gqlName` complete the schema; schema-first ignores them (the SDL is the only
source). Type problems are [`ZNIGHT060`](/reference/error-codes#znight060)–[`ZNIGHT065`](/reference/error-codes#znight065)
(a `@ResolveField` without its type, a subscription not returning an async iterable:
[`ZNIGHT062`](/reference/error-codes#znight062)), boot problems
[`ZNIGHT066`](/reference/error-codes#znight066). In schema-first, SDL problems (a custom scalar
without `scalar()` included) are [`ZNIGHT067`](/reference/error-codes#znight067), and resolvers that
do not cover or conform to the SDL [`ZNIGHT068`](/reference/error-codes#znight068).

Guide: [GraphQL](/guide/graphql)

## `@znight/websocket`

| Decorator                                           | Target        | Arguments / notes                                                                                                                             |
| --------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `@Gateway(path?)`                                   | class         | static path (`'/chat'`, `'/docs/:docId'`) or `{ path?, scope?, protocol?, protocols?, maxPayload?, concurrency?, rateLimit?, backpressure? }` |
| `@OnConnect()`                                      | method        | once per gateway; runs before any message; throwing closes the connection                                                                     |
| `@OnMessage(event?)`                                | method        | static event name (`$` reserved); without event: the default handler (every frame of a `raw` gateway)                                         |
| `@OnDisconnect()`                                   | method        | once per gateway; after the running handlers                                                                                                  |
| `@Payload(schema?)`                                 | parameter     | the message `data` (or the raw frame), validated by a Standard Schema                                                                         |
| `@Conn()`                                           | parameter     | the `WsConnection`                                                                                                                            |
| `@Ctx()`                                            | parameter     | the `WsMessageContext` (`@OnMessage` handlers)                                                                                                |
| `@UseHandshakeGuard(...guards)`                     | class         | HTTP guards (`CanActivate`) of the handshake, after the `HttpPlugin` global guards                                                            |
| `@UseMessageGuard(...guards)`                       | class, method | `WsGuard`s (`canHandle(ctx)`) run before each handler                                                                                         |
| `createRouteDecorator` decorators of `@znight/http` | class, method | class: decide the handshake and the messages; method: the messages of that handler (nearest wins per group)                                   |

A gateway is a provider (`singleton` or `request`: one instance per connection). Handlers are
inherited from base classes; `@OnConnect` and `@OnDisconnect` methods take `@Conn()` only. Invalid
gateways are [`ZNIGHT050`](/reference/error-codes#znight050), invalid paths
[`ZNIGHT007`](/reference/error-codes#znight007), a structured `@Payload()` without schema
[`ZNIGHT017`](/reference/error-codes#znight017) and a missing required route decision
[`ZNIGHT023`](/reference/error-codes#znight023).

Guide: [WebSockets](/guide/websockets) · Reference: [`@znight/websocket`](/packages/websocket)

## `@znight/events`

| Decorator            | Target | Arguments / notes                                                                                                                                                                                                                                                                                                                 |
| -------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@OnEvent(options?)` | method | static `{ order?, detached? }`; a public instance method with exactly one parameter typed with the event class (a class, a union of classes, or a base class: its subclasses are delivered too); `order` ascending (default `0`); `detached: true` runs after the publication in a fresh scope, errors reported instead of thrown |

A class with `@OnEvent` methods becomes a singleton provider when nothing else registers it.
Listeners declared on an abstract class run on each concrete provider extending it; a subclass that
redeclares the method replaces the inherited listener. A string event name
(`@OnEvent('user.created')`), an interface, a type alias, a primitive or an optional parameter is
[`ZNIGHT070`](/reference/error-codes#znight070); an accessor, static, `#private`, non-public,
generic or generator method is [`ZNIGHT005`](/reference/error-codes#znight005).

Guide: [Application events](/guide/events) · Reference: [`@znight/events`](/packages/events)

## `@znight/config`

| Decorator          | Target   | Arguments / notes                                                                        |
| ------------------ | -------- | ---------------------------------------------------------------------------------------- |
| `@Config(prefix?)` | class    | static; a singleton provider; `prefix` namespaces the default env names and key paths    |
| `@Env(name)`       | property | static env name (default: `CONSTANT_CASE` of `<prefix>_<property>`)                      |
| `@Secret(name?)`   | property | static env name (optional); value masked in logs, serialisation and errors               |
| `@Default(value)`  | property | static; checked against the property type (use an initializer for computed values)       |
| `@Key(path)`       | property | static; key in structured sources (JSON/YAML, Vault, AWS), default `<prefix>.<property>` |

Every instance property of a `@Config` class is a field, decorated or not, including properties
inherited from base classes (which need no `@Config`); methods, static members, `#private` fields,
accessors and computed keys are ignored. A property is required unless it is optional, has
`@Default` or an initializer. Config classes are created with `new Class()` (no constructor
injection). Problems with a field, its type or its names are
[`ZNIGHT012`](/reference/error-codes#znight012); a decorator on a wrong target, applied twice or with
a non-evaluable argument is [`ZNIGHT005`](/reference/error-codes#znight005).

Guide: [Config](/packages/config)

## `@znight/observability`

Interceptor decorators declared in the package manifest, applied to any provider method (route
handlers, message handlers and jobs included); the top-most decorator runs first. Options are
literals (or exported constants), validated when the application is created: an invalid option
fails `Application.create()` with [`ZNIGHT005`](/reference/error-codes#znight005).

| Decorator        | Interceptor         | Effect                                     | Options                                            |
| ---------------- | ------------------- | ------------------------------------------ | -------------------------------------------------- |
| `@Logged(opts?)` | `LoggedInterceptor` | One log entry per call: duration, or error | `level`, `errorLevel`, `args`, `result`, `message` |
| `@Traced(opts?)` | `TracedInterceptor` | A span per call                            | `name`, `attributes`, `kind`                       |
| `@Metric(opts?)` | `MetricInterceptor` | A duration histogram (or a call counter)   | `type`, `name`, `help`, `labels`, `buckets`        |

Guide: [Observability](/packages/observability)
