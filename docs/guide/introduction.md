---
description: What Znight is, how compile-time dependency injection works and how it compares to runtime DI frameworks such as NestJS.
---

# Introduction

Znight is a backend framework for TypeScript in the spirit of NestJS and Spring Boot: you write
**providers** (services, repositories, controllers, consumers...) and let a container wire them
together. The difference is _when_ the wiring happens.

In Znight, **dependency injection is resolved at compile time**. A compiler (a Vite plugin, also
usable from the CLI and Bun) reads your TypeScript sources, binds every constructor parameter to a
provider, validates the whole graph and generates a plain TypeScript module. At runtime, the
container only calls the generated factories, in an order computed ahead of time.

```ts
@Injectable()
export class NotificationService {
  constructor(
    private readonly email: EmailService, // bound by the compiler
    private readonly users: UserRepository, // an interface: bound to its implementation
  ) {}
}
```

It is the approach of [Micronaut](https://micronaut.io/) and [Dagger](https://dagger.dev/) in the
JVM world, brought to TypeScript.

## Principles

1. **Compile-time DI.** No `reflect-metadata`, no `emitDecoratorMetadata`, no runtime type lookup.
2. **Decorators are markers.** Every Znight decorator is a no-op at runtime: the compiler reads them
   from the source code, and the Vite plugin strips them from the bundle.
3. **Flat DI.** One container, no modules. Providers are discovered by scanning your sources (and
   provider libraries).
4. **Composable.** HTTP, messaging, configuration and observability are separate packages, each made
   of marker decorators, a compiler extension and a runtime plugin.
5. **Runtime agnostic.** Runtime packages run on Node.js 24+ and Bun 1.3+ (ESM only), using standard
   APIs only.
6. **Fast.** The compiler is built on [oxc](https://oxc.rs) with per-file caches; the runtime creates
   independent async singletons concurrently.
7. **Fail loudly, early, precisely.** Everything that can be detected at build time is a `ZNIGHTxxx`
   diagnostic with a source location and hints. Runtime errors carry a code, the dependency path and
   the original `cause`.

## Runtime DI vs compile-time DI

With a runtime container, the dependency graph is discovered while the application boots:
decorators record metadata, TypeScript emits constructor parameter types (`design:paramtypes`), and
the container reflects on all of it to create instances. Every wiring mistake becomes a startup
crash, and interfaces (erased at runtime) need string tokens.

With Znight, that work happens once, in the compiler:

| Concern                   | Runtime DI (NestJS, InversifyJS, tsyringe)                  | Znight                                                                                                         |
| ------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| How types are known       | `emitDecoratorMetadata` + `reflect-metadata` at runtime     | Read from the source by the compiler                                                                           |
| Interfaces                | Erased: you inject string or symbol tokens with `@Inject()` | Injected by type; the compiler finds the implementation (`implements` / `extends`)                             |
| Missing provider, cycle   | Discovered at boot (or on first use)                        | [`ZNIGHT001`](/reference/error-codes#znight001), [`ZNIGHT002`](/reference/error-codes#znight002) at build time |
| Singleton → request scope | Silent bug or runtime error                                 | [`ZNIGHT003`](/reference/error-codes#znight003) at build time                                                  |
| Organisation              | Modules with `imports`/`exports`/`providers`                | Flat: every `@Injectable()` in `src/` is a provider                                                            |
| Startup work              | Reflection, graph resolution, sorting                       | Call generated factories in a precomputed order                                                                |
| Debugging the wiring      | Read framework internals                                    | Read `container.generated.ts`                                                                                  |
| Bundle                    | Decorator calls and metadata kept at runtime                | Decorators stripped; unused providers can be pruned                                                            |

What you keep from runtime frameworks: decorators, constructor injection, scopes, lifecycle hooks,
plugins, guards and interceptors, testing utilities with auto-mocking.

## How it fits together

```txt
 your code (src/**/*.ts)                      build time
 ─────────────────────────────────────────────────────────────────────────
  @Injectable() classes       ┌──────────────────────────────────────┐
  @Controller() classes  ───▶ │ @znight/compiler (Vite plugin / CLI) │
  @Consumer(), @Config()...   │  scan → analyse → bind → validate    │
                              └──────────────────┬───────────────────┘
                                                 │ generates
                                                 ▼
                              src/.znight/container.generated.ts
                                (__ZNIGHT_METADATA__)
 ─────────────────────────────────────────────────────────────────────────
                                                 │ imported by main.ts   run time
                                                 ▼
                              Application.create({ metadata, plugins })
                                @znight/core container + lifecycle
                                + HttpPlugin, MessagingPlugin, ConfigPlugin...
```

- [`@znight/compiler`](/packages/compiler) analyses the code and generates `__ZNIGHT_METADATA__`.
- [`@znight/core`](/packages/core) executes it: container, scopes, lifecycle, plugins, hooks, AOP.
- Feature packages ([HTTP](/packages/http), [messaging](/packages/messaging),
  [config](/packages/config), [observability](/packages/observability)) add decorators, a compiler
  extension and a runtime plugin each.

## When to use Znight

Znight is a good fit for HTTP APIs, message consumers and workers, serverless functions where cold
starts matter, and teams that want NestJS-style structure without modules and runtime reflection.

It is not a frontend framework, and it does not try to hide the build step: the compiler is part of
your toolchain (through Vite, the CLI or the Bun preload).

## Project status

::: warning Before 1.0
Znight is preparing its first release (`v0.1`). Every package is implemented and tested on Node.js
24 and Bun: the runtime, the compiler (Vite plugin, Bun preload, CLI), HTTP, messaging,
configuration, observability and the testing utilities, with runnable example applications in the
repository. Until 1.0, minor versions may still change APIs. Feedback and contributions are welcome
on [GitHub](https://github.com/ugho49/Znight).
:::

## Next steps

- [Getting started](./getting-started): create your first application.
- [Dependency injection](./dependency-injection): providers, interfaces, qualifiers, factories.
- [The compiler](./compiler): what happens at build time, options and the generated module.
- [Migrating from NestJS](./migrating-from-nestjs): a decorator-by-decorator mapping.
