---
description: Every Znight decorator by package, with its target and how the compiler evaluates its arguments.
---

# Decorators

Znight decorators are **markers**: they do nothing at runtime and are stripped from the bundle. The
compiler recognises them by identity (renamed imports and re-exports work) and evaluates their
arguments at build time.

Arguments come in two kinds:

- **static**: must evaluate at build time (literals, `const` references across files and packages,
  template literals, arithmetic, `as const`...). Paths, names, scopes, queue and env names are static.
- **value**: evaluated when possible, otherwise a reference to an **exported** binding that the
  generated module imports. Schemas, guards, interceptors, defaults and options are values.

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

<!-- TODO(api): verify against implementation -->

| Decorator                                                                    | Target         | Arguments / notes                                                             |
| ---------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------- |
| `@Controller(path?)` / `@Controller({ path?, scope? })`                      | class          | static; a provider (singleton by default)                                     |
| `@Get` `@Post` `@Put` `@Patch` `@Delete` `@Head` `@Options` `@All` `(path?)` | method         | static path: static segments, `:params`, trailing `*`                         |
| `@Param(name?, schema?)`                                                     | parameter      | static name, value schema                                                     |
| `@Query(name?, schema?)`                                                     | parameter      | static name, value schema                                                     |
| `@Body(schema?)`                                                             | parameter      | value schema                                                                  |
| `@Headers(name?)`                                                            | parameter      | static name                                                                   |
| `@Req()` / `@Res()`                                                          | parameter      | raw adapter request / response (escape hatch, warning)                        |
| `@Ctx()`                                                                     | parameter      | `HttpContext`                                                                 |
| `@HttpCode(status)`                                                          | method         | static number                                                                 |
| `@Header(name, value)`                                                       | method         | static strings                                                                |
| `@UseGuard(...guards)`                                                       | class / method | value references to guard classes                                             |
| `@UseInterceptor(...interceptors)`                                           | class / method | value references to interceptor classes                                       |
| `@Validate(schema)`                                                          | method         | sugar for `@Body(schema)`; using both is `ZNIGHT005`                          |
| `createRouteDecorator<T>(key)`                                               | —              | creates metadata decorators (`@Roles(['admin'])`) stored in `route.meta[key]` |

Guide: [HTTP](/packages/http)

## `@znight/messaging`

<!-- TODO(api): verify against implementation -->

| Decorator                                                                            | Target    | Arguments / notes                                      |
| ------------------------------------------------------------------------------------ | --------- | ------------------------------------------------------ |
| `@Consumer(queue)` / `@Consumer({ queue, scope?, concurrency?, ...driver options })` | class     | static; a provider                                     |
| `@OnMessage(type?)`                                                                  | method    | static; matches `message.type`, none = default handler |
| `@Retry({ attempts, backoff?, delay?, maxDelay? })`                                  | method    | static; `backoff`: `'fixed'` or `'exponential'`        |
| `@OnError()`                                                                         | method    | `(error, message) => void \| 'ack'`                    |
| `@Message(schema?)`                                                                  | parameter | value schema                                           |
| `@Headers(name?)`                                                                    | parameter | static name                                            |
| `@Ctx()`                                                                             | parameter | `InboundMessage`                                       |

Guide: [Messaging](/packages/messaging)

## `@znight/config`

<!-- TODO(api): verify against implementation -->

| Decorator          | Target   | Arguments / notes                                          |
| ------------------ | -------- | ---------------------------------------------------------- |
| `@Config(prefix?)` | class    | static; a singleton provider                               |
| `@Env(name)`       | property | static env name                                            |
| `@Secret(name)`    | property | static env name; value masked in logs and serialisation    |
| `@Default(value)`  | property | value (a literal initializer works too)                    |
| `@Key(path)`       | property | static; key in file sources, default `<prefix>.<property>` |

Guide: [Config](/packages/config)

## `@znight/observability`

<!-- TODO(api): verify against implementation -->

Interceptor decorators declared in the package manifest:

| Decorator        | Interceptor         | Effect                             |
| ---------------- | ------------------- | ---------------------------------- |
| `@Logged(opts?)` | `LoggedInterceptor` | Logs calls, durations and failures |
| `@Traced(opts?)` | `TracedInterceptor` | Creates a span per call            |
| `@Metric(opts?)` | `MetricInterceptor` | Records duration and error metrics |

Guide: [Observability](/packages/observability)
