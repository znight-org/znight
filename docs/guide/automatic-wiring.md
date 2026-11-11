---
description: Znight has no modules. Providers are discovered by scanning your sources, interfaces are bound through implements, and the whole graph is checked at build time. What replaces NestJS modules.
---

# Automatic wiring

Znight has **no modules**. You never declare where a provider lives, who may use it or in which
order things are created: write a class, export it, and inject it by type anywhere. The compiler
finds it, wires it and checks the whole graph at build time, and tells you precisely when it cannot.

## Side by side {#side-by-side}

The same feature, a repository behind an interface, a service and a controller:

::: code-group

```ts [NestJS]
// users/users.module.ts
@Module({
  imports: [DatabaseModule],
  controllers: [UserController],
  providers: [UserService, { provide: USER_REPOSITORY, useClass: PgUserRepository }],
  exports: [UserService],
})
export class UsersModule {}

// app.module.ts
@Module({ imports: [DatabaseModule, UsersModule, OrdersModule] })
export class AppModule {}

// users/user.service.ts
@Injectable()
export class UserService {
  constructor(@Inject(USER_REPOSITORY) private readonly users: UserRepository) {}
}

// main.ts
const app = await NestFactory.create(AppModule)
```

```ts [Znight]
// users/pg-user.repository.ts
import { Injectable } from '@znight/core'

@Injectable()
export class PgUserRepository implements UserRepository {
  // ...
}

// users/user.service.ts
@Injectable()
export class UserService {
  constructor(private readonly users: UserRepository) {} // → PgUserRepository
}

// users/user.controller.ts
import { Controller } from '@znight/http'

@Controller('/users')
export class UserController {
  constructor(private readonly users: UserService) {}
}

// main.ts: createApplication() is written by the compiler from the classes above
const app = await createApplication({ plugins: [HttpPlugin.configure({ port: 3000 })] })

// That is all: no users.module.ts, no app.module.ts, no token.
```

:::

`OrderService`, in another folder, injects `UserService` directly: there is nothing to export or
import. `createApplication()` lives in the generated module (`src/.znight/container.generated.ts`):
where NestJS needs the `AppModule` you write and maintain, Znight's equivalent is written by the
compiler on every build.

## What the compiler does for you {#what-the-compiler-does}

| Step     | What happens                                                                                                                                                                                                                                                                                                                                                                                                                            | Details                                                                                                                               |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Discover | Scans `include` (`src/**/*.{ts,tsx,mts}`) minus `exclude` (tests, `.d.ts`). Every **exported** class with a provider decorator (`@Injectable`, `@Controller`, `@Consumer`, `@Config`, `@Factory`, `@Resolver`, `@Gateway`...) is a provider. Classes holding `@Cron` jobs or `@OnEvent` listeners need no class decorator, nor do guards and interceptors referenced by `@UseGuard()` or `@Intercept()`. Provider libraries are merged. | [What the compiler scans](/guide/project-structure#what-the-compiler-scans), [Provider libraries](/guide/compiler#provider-libraries) |
| Bind     | Each constructor parameter's declared type selects a provider: the class itself, or the class whose `implements` / `extends` names it. `@Primary()` / `@Named()` choose among several, `T[]` takes them all, `Lazy<T>` and optional parameters are supported.                                                                                                                                                                           | [How a dependency is bound](/guide/dependency-injection#how-a-dependency-is-bound)                                                    |
| Order    | The creation order is computed once. At boot, factories run in that order, with independent async singletons running concurrently.                                                                                                                                                                                                                                                                                                      | [Lifecycle](/guide/lifecycle)                                                                                                         |
| Check    | Missing provider ([`ZNIGHT001`](/reference/error-codes#znight001)), cycle (`ZNIGHT002`), singleton depending on a request-scoped provider (`ZNIGHT003`), duplicate (`ZNIGHT004`) or ambiguous injection (`ZNIGHT008`), invalid routes, consumers or jobs: the build fails with a location and a hint.                                                                                                                                   | [Error codes](/reference/error-codes)                                                                                                 |
| Emit     | `container.generated.ts`: the `metadata` of the graph and the `createApplication()` function, plain TypeScript you can read and step through.                                                                                                                                                                                                                                                                                           | [The generated module](/guide/compiler#the-generated-module)                                                                          |

## Adding a feature is adding files {#adding-files}

Create `src/invoices/invoice.service.ts` with an exported `@Injectable()` class and inject it in a
controller: `znight dev` rebuilds, binds it and restarts. There is nothing to register. Remove a
provider and every class that still needs it fails the build with `ZNIGHT001`, at its constructor:

```txt
✗ ZNIGHT001: Missing provider for 'InvoiceService' required by InvoiceController
  --> src/invoices/invoice.controller.ts:8:31
```

The plugins you list in `createApplication({ plugins })` are the only thing you register by hand:
they add runtime features (an HTTP server, a broker connection, a scheduler), not providers.

## What modules gave you, and what replaces them {#what-replaces-modules}

| You used modules for                             | In Znight                                                                                                                                                                                                |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Encapsulation (`exports`)                        | The language: do not export internals, or keep a feature in a workspace package with a narrow entry, used as a [provider library](/guide/compiler#provider-libraries).                                   |
| Configurable modules (`forRoot`, `forRootAsync`) | Plugins: `XxxPlugin.configure(options)` or `configure(container => options)` ([options computed from the container](/guide/plugins#options-computed-from-the-container)).                                |
| Integrations (`TypeOrmModule.forFeature`...)     | A `@Factory()` with `@Provides()` methods ([Data access](/guide/data-access#factory)).                                                                                                                   |
| One implementation per environment               | A `@Provides()` method reading a `@Config()` class (sample below), or `@Primary()`.                                                                                                                      |
| `@Global()`                                      | Not needed: every provider is visible everywhere.                                                                                                                                                        |
| `forwardRef()` between modules                   | No module cycles exist. A real cycle between providers is `ZNIGHT002`; break it with [`Lazy<T>`](/guide/dependency-injection#lazy-dependencies).                                                         |
| `Test.createTestingModule()`                     | `TestBed.create(X, { metadata })` builds `X` and auto-mocks its dependencies; `TestApp.create({ metadata, overrides })` starts the application in memory ([Testing](/guide/testing)).                    |
| Splitting a large application                    | One entry per application, `include` / `exclude`, shared provider libraries, `reportUnused` ([`ZNIGHT019`](/reference/error-codes#znight019)) and `prune` ([compiler options](/guide/compiler#options)). |

Choosing an implementation from the configuration is a factory method, not a module:

```ts
import { Config } from '@znight/config'
import { Factory, Provides } from '@znight/core'

@Config('mail')
export class MailConfig {
  smtpUrl?: string // MAIL_SMTP_URL
}

@Factory()
export class MailerFactory {
  @Provides()
  mailer(config: MailConfig): Mailer {
    return config.smtpUrl === undefined ? new ConsoleMailer() : new SmtpMailer(config.smtpUrl)
  }
}
```

Every class that injects `Mailer` gets the implementation chosen at boot, and the compiler checked
at build time that `MailConfig` exists and that nothing else provides a `Mailer`.

## Is a flat container a big ball of mud? {#flat-container}

No hidden graph: it is written out in `container.generated.ts` (`znight generate` writes it,
`znight generate --check` guards it in CI), and every dependency is a constructor parameter you can
read. Boundaries live where TypeScript already enforces them: what a file exports, and what a
package's entry exposes. When a part of the application must stay private, make it a workspace
package with a narrow entry: its providers are merged as a
[provider library](/guide/compiler#provider-libraries), and only its exports are importable.

## Next steps

- [Dependency injection](./dependency-injection): the binding rules in detail (interfaces,
  qualifiers, multi, optional and lazy dependencies, factories).
- [Project structure](./project-structure): the recommended layout and what the compiler scans.
- [Migrating from NestJS](./migrating-from-nestjs#modules-to-flat-di): every module feature mapped
  to Znight.
