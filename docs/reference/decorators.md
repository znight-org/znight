---
description: Every Znight decorator by package, with its target and how the compiler evaluates its arguments.
---

# Decorators

Znight decorators are **markers**: they do nothing at runtime and are stripped from the bundle. The
compiler recognises them by identity (renamed imports and re-exports work) and evaluates their
arguments at build time.

Arguments come in two kinds:

- **static**: must evaluate at build time (literals, `const` references across files and packages,
  template literals, arithmetic, `as const`...). Paths, names, scopes, queue and env names, retry
  policies, `@Default` values, body limits and upload options are static.
- **value**: evaluated when possible, otherwise a reference to an **exported** binding that the
  generated module imports. Schemas, guards, interceptors and interceptor options are values.

Anything else is [`ZNIGHT005`](/reference/error-codes#znight005), with the fix-it "extract to
`export const X = ...`".

## `@znight/core`

| Decorator                           | Target                              | Arguments                                                                                                                                                      |
| ----------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@Injectable(opts?)`                | class                               | static `{ scope?, name?, primary? }`                                                                                                                           |
| `@Factory()`                        | class                               | —: a singleton whose `@Provides` methods produce providers                                                                                                     |
| `@Provides(opts?)`                  | method of a `@Factory`              | static `{ scope?, name?, primary?, dispose? }`. The explicit return type is the provided type (`Promise<T>` → async, singletons only); parameters are injected |
| `@Inject(name)`                     | constructor / `@Provides` parameter | static string qualifier                                                                                                                                        |
| `@Optional()`                       | constructor / `@Provides` parameter | —                                                                                                                                                              |
| `@Named(name)`                      | class / `@Provides` method          | static string                                                                                                                                                  |
| `@Primary()`                        | class / `@Provides` method          | —                                                                                                                                                              |
| `@Intercept(Interceptor, options?)` | method                              | `Interceptor`: value (a provider class implementing `MethodInterceptor`); `options`: value                                                                     |

Type helpers: `Lazy<T>`; lifecycle interfaces `OnStart`, `OnReady`, `OnStop`.

Guides: [Dependency injection](/guide/dependency-injection) · [AOP](/guide/aop) ·
[Lifecycle](/guide/lifecycle)

## `@znight/http`

| Decorator                                                                    | Target         | Arguments / notes                                                                                                              |
| ---------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `@Controller(path?)` / `@Controller({ path?, scope? })`                      | class          | static; a provider (singleton by default)                                                                                      |
| `@Get` `@Post` `@Put` `@Patch` `@Delete` `@Head` `@Options` `@All` `(path?)` | method         | static path: static segments, `:params`, trailing `*`; several per method allowed                                              |
| `@Param(name?, schema?)`                                                     | parameter      | static name, value schema; coerced to the parameter type (`number`, `boolean`, `Date`, literal unions...)                      |
| `@Query(name?, schema?)`                                                     | parameter      | static name, value schema; without name: the whole query                                                                       |
| `@Body(schema?)`                                                             | parameter      | value schema; on an upload route: the text fields of the form                                                                  |
| `@Headers(name?)`                                                            | parameter      | static name (case-insensitive); without name: all headers                                                                      |
| `@UploadedFile(field?, opts?)`                                               | parameter      | static; the `File` of a `multipart/form-data` field (`File \| undefined` when optional); no field: the single file of the body |
| `@UploadedFiles(field?, opts?)`                                              | parameter      | static; the `File[]` of a field, in body order; no field: every file of the body                                               |
| `@Req()` / `@Res()`                                                          | parameter      | raw adapter request / response (escape hatch, warning)                                                                         |
| `@Ctx()`                                                                     | parameter      | `HttpContext`                                                                                                                  |
| `@HttpCode(status)`                                                          | method         | static number                                                                                                                  |
| `@Header(name, value)`                                                       | method         | static strings                                                                                                                 |
| `@BodyLimit(size)`                                                           | class / method | static size: bytes or `'10mb'` (`kb` = 1024), `Infinity` for no limit; the method wins over the class                          |
| `@UseGuard(...guards)`                                                       | class / method | value references to guard classes                                                                                              |
| `@UseInterceptor(...interceptors)`                                           | class / method | value references to interceptor classes                                                                                        |
| `@Validate(schema)`                                                          | method         | sugar for `@Body(schema)`; using both is `ZNIGHT005`                                                                           |
| `createRouteDecorator<T>(key)`                                               | —              | creates metadata decorators (`@Roles(['admin'])`) stored in `route.meta[key]`                                                  |

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

Guide: [HTTP](/packages/http) · [Files](/packages/http#files)

## `@znight/messaging`

| Decorator                                                                                         | Target    | Arguments / notes                                                                                                |
| ------------------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------- |
| `@Consumer(queue)` / `@Consumer({ queue, scope?, concurrency?, deadLetter?, ...driver options })` | class     | static; a provider (singleton by default)                                                                        |
| `@OnMessage(type?)`                                                                               | method    | static; matches `message.type` exactly or as a pattern (`'order.*'`); none = default handler; several per method |
| `@Retry({ attempts, backoff?, delay?, maxDelay? })`                                               | method    | static; `backoff`: `'fixed'` or `'exponential'` (default); unknown keys are `ZNIGHT011`                          |
| `@OnError()`                                                                                      | method    | `(error, message) => void \| 'ack'`, when a message will not be retried anymore                                  |
| `@Message(schema?)`                                                                               | parameter | value schema (Standard Schema); the payload                                                                      |
| `@Headers(name?)`                                                                                 | parameter | static name; without name: all headers                                                                           |
| `@Ctx()`                                                                                          | parameter | `InboundMessage`                                                                                                 |

Handlers and `@OnError` are inherited from base classes the compiler can analyse.

Guide: [Messaging](/packages/messaging)

## `@znight/config`

| Decorator          | Target   | Arguments / notes                                                                        |
| ------------------ | -------- | ---------------------------------------------------------------------------------------- |
| `@Config(prefix?)` | class    | static; a singleton provider; `prefix` namespaces the default env names and key paths    |
| `@Env(name)`       | property | static env name (default: `CONSTANT_CASE` of `<prefix>_<property>`)                      |
| `@Secret(name?)`   | property | static env name (optional); value masked in logs, serialisation and errors               |
| `@Default(value)`  | property | static; checked against the property type (use an initializer for computed values)       |
| `@Key(path)`       | property | static; key in structured sources (JSON/YAML, Vault, AWS), default `<prefix>.<property>` |

Guide: [Config](/packages/config)

## `@znight/observability`

Interceptor decorators declared in the package manifest. Options are literals (or exported
constants), validated when the application is created:

| Decorator        | Interceptor         | Effect                                     | Options                                            |
| ---------------- | ------------------- | ------------------------------------------ | -------------------------------------------------- |
| `@Logged(opts?)` | `LoggedInterceptor` | One log entry per call: duration, or error | `level`, `errorLevel`, `args`, `result`, `message` |
| `@Traced(opts?)` | `TracedInterceptor` | A span per call                            | `name`, `attributes`, `kind`                       |
| `@Metric(opts?)` | `MetricInterceptor` | A duration histogram (or a call counter)   | `type`, `name`, `help`, `labels`, `buckets`        |

Guide: [Observability](/packages/observability)
