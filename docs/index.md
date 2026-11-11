---
layout: home
title: Znight
titleTemplate: Compile-time dependency injection for TypeScript
description: Znight is a TypeScript backend framework with compile-time dependency injection. A compiler resolves and validates your providers at build time; the runtime only runs generated factories.
pageClass: zn-home

hero:
  name: Znight
  text: Compile-time dependency injection for TypeScript
  tagline: "Write classes, not modules: the compiler finds your providers, wires every constructor and checks the whole graph at build time. In production, only generated code runs."
  image:
    src: /mark.svg
    alt: Znight
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Why Znight?
      link: /guide/introduction
    - theme: alt
      text: View on GitHub
      link: https://github.com/znight-org/znight

features:
  - icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/></svg>
    title: No modules, automatic wiring
    details: Mark a class, export it, inject it by type anywhere. The compiler finds every provider by scanning your sources, binds interfaces to the class that implements them and orders the factories. No @Module, no providers arrays, no tokens, no reflect-metadata.
    link: /guide/automatic-wiring
    linkText: How wiring works
  - icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>
    title: Errors at build time
    details: Missing providers, cycles, scope mismatches, ambiguous injections and invalid routes, consumers or jobs fail the build with a ZNIGHT code, a code frame and a hint, before anything is deployed.
    link: /reference/error-codes
    linkText: Browse error codes
  - icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="m10 13-2 2 2 2M14 13l2 2-2 2"/></svg>
    title: Transparent by design
    details: The container is a deterministic, type-checked TypeScript module you can read, diff and step through. Decorators are markers, stripped from the bundle.
    link: /guide/compiler#the-generated-module
    linkText: See the generated code
  - icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/><path d="M12 15v2"/></svg>
    title: Secure by default
    details: Declare an access decision group and a route without a decision fails the build. CORS, security headers (on by default) and trusted proxies are built in, with tested recipes for JWT, API keys, sessions and CSRF.
    link: /guide/security
    linkText: Secure an API
  - icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2c3 2.5 4.5 6 4.5 10.5L14 17h-4l-2.5-4.5C7.5 8 9 4.5 12 2z"/><circle cx="12" cy="9" r="1.5"/><path d="m10 17-1 4 3-2 3 2-1-4"/></svg>
    title: Fast everywhere
    details: No graph to discover at boot. Factories run in a precomputed order and independent async singletons start concurrently, with the same behaviour on Node.js 24+ and Bun 1.3+, on every HTTP adapter.
    link: /benchmarks
    linkText: See the benchmarks
  - icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 2v7.5a2 2 0 0 1-.2.9L4.7 20.6a1 1 0 0 0 .9 1.4h12.8a1 1 0 0 0 .9-1.4l-5.1-10.2a2 2 0 0 1-.2-.9V2"/><path d="M8.5 2h7"/><path d="M7 16h10"/></svg>
    title: Tests without the wiring
    details: TestBed builds a provider with its generated factory and auto-mocks its dependencies. TestApp starts the real application in memory for HTTP, event streams and WebSockets, with Bun, Vitest or Jest.
    link: /guide/testing
    linkText: Write tests
---

<div class="zn-section-head">

<p class="zn-eyebrow">How it works</p>

## Write plain classes. Get a compiled container. {#how-it-works}

The work a runtime container does at every boot, Znight does once, in the compiler.

</div>

<HowItWorks />

::: code-group

```ts [user.service.ts]
import { Injectable } from '@znight/core'
import type { UserRepository } from './user.repository.js'

@Injectable()
export class UserService {
  constructor(private readonly users: UserRepository) {}

  findById(id: number) {
    return this.users.findById(id)
  }
}
```

```ts [user.controller.ts]
import { Controller, Get, Param } from '@znight/http'
import { UserService } from './user.service.js'

@Controller('/users')
export class UserController {
  constructor(private readonly users: UserService) {}

  @Get('/:id')
  getUser(@Param('id') id: number) {
    return this.users.findById(id)
  }
}
```

```ts [main.ts]
import { HttpPlugin } from '@znight/http'
import { createApplication } from './.znight/container.generated.js'

const app = await createApplication({
  plugins: [HttpPlugin.configure({ port: 3000 })],
})
await app.start()
```

```ts [.znight/container.generated.ts]
// AUTO-GENERATED by @znight/compiler 0.6.2. Do not edit.
import type { ZnightMetadata } from '@znight/core'
import { PgUserRepository } from '../users/pg-user.repository.js'
import { UserService } from '../users/user.service.js'
// ...

export const metadata: ZnightMetadata = {
  version: 1,
  compiler: '0.6.2',
  providers: {
    ['src/users/pg-user.repository.ts#PgUserRepository']: {
      scope: 'singleton',
      class: PgUserRepository,
      deps: ['src/db/db.factory.ts#DbFactory.createPool'],
      factory: d => new PgUserRepository(d[0]),
    },
    ['src/users/user.service.ts#UserService']: {
      scope: 'singleton',
      class: UserService,
      deps: ['src/users/pg-user.repository.ts#PgUserRepository'],
      factory: d => new UserService(d[0]),
    },
    // ...
  },
  resolutionOrder: [
    'src/db/db.factory.ts#DbFactory',
    'src/db/db.factory.ts#DbFactory.createPool',
    'src/users/pg-user.repository.ts#PgUserRepository',
    'src/users/user.service.ts#UserService',
    'src/users/user.controller.ts#UserController',
  ],
  aliases: {
    ['src/users/user.repository.ts#UserRepository']: 'src/users/pg-user.repository.ts#PgUserRepository',
  },
  // the routes of UserController, each with a generated invoke()
  extensions: {
    ['http']: {
      ['controllers']: [
        /* ... */
      ],
    },
  },
}
```

:::

`UserRepository` is an interface: the compiler found its only implementation, `PgUserRepository`, and
bound it. Nothing is looked up by name or reflected at runtime. You registered none of these classes:
there is no module and no providers list. Add a file with an exported provider and it is part of the
graph at the next build.

<div class="zn-section-head">

<p class="zn-eyebrow">Packages</p>

## Install what you use {#packages}

Each feature is a package: marker decorators, a compiler extension found through its manifest and a
runtime plugin. Third-party integrations are optional peer dependencies.

</div>

<PackageGrid />

<div class="zn-section-head">

<p class="zn-eyebrow">No modules</p>

## Add a file, not a module entry {#no-modules}

In NestJS, every provider is declared in a module, and modules import and export what the others
need. In Znight there is nothing to declare: the compiler scans `src/`, and the graph is the code.

</div>

<div class="zn-split zn-compare">

<div class="zn-split-item">

### NestJS {#no-modules-nestjs}

```ts
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
```

</div>

<div class="zn-split-item">

### Znight {#no-modules-znight}

```ts
// users/pg-user.repository.ts
@Injectable()
export class PgUserRepository implements UserRepository {}

// users/user.service.ts
@Injectable()
export class UserService {
  constructor(private readonly users: UserRepository) {} // → PgUserRepository
}

// users/user.controller.ts
@Controller('/users')
export class UserController {
  constructor(private readonly users: UserService) {}
}

// No users.module.ts, no app.module.ts, no token.
```

</div>

</div>

[How automatic wiring works →](/guide/automatic-wiring)

<div class="zn-section-head">

<p class="zn-eyebrow">Why Znight</p>

## Resolved once, not on every boot {#why-znight}

Runtime DI containers (NestJS, InversifyJS, tsyringe...) discover the graph **while the application
boots**, from `reflect-metadata` and decorator side effects. Znight does it **once, in the compiler**.

</div>

|                       | Runtime DI                                   | Znight                                                    |
| --------------------- | -------------------------------------------- | --------------------------------------------------------- |
| Dependency resolution | Reflection at boot (`emitDecoratorMetadata`) | Static analysis at build time                             |
| Wiring mistakes       | Crash at startup, or on the first request    | Build error with a code, a location and a fix             |
| What runs in prod     | Decorators, metadata maps, resolution logic  | Generated factories called in a precomputed order         |
| Interfaces as tokens  | Erased at runtime: string tokens + `@Inject` | Injected by type, implementation found by the compiler    |
| Structure             | Modules, imports/exports, `forwardRef`       | One flat container, providers discovered by scanning      |
| Cold start            | Graph discovered and sorted on every boot    | Only your constructors run: the graph was solved at build |
| Debugging             | Framework internals                          | A readable `container.generated.ts` you can step through  |

[Read the full comparison →](/guide/introduction#runtime-di-vs-compile-time-di)

<div class="zn-split">

<div class="zn-split-item">

### Mistakes surface while you build {#mistakes-surface-while-you-build}

A wiring mistake is a build error with a stable code, a location and a hint, documented in the
[error reference](/reference/error-codes) with an example and the usual fixes.

<div class="zn-terminal">

```txt
$ vite build

✗ ZNIGHT001: Missing provider for 'EmailService' required by NotificationService
  --> src/notification/notification.service.ts:12:29
   |
12 |     private readonly email: EmailService,
   |                             ^^^^^^^^^^^^
   = hint: EmailService (src/email/email.service.ts:3) is not a provider: add @Injectable()

Build failed with 1 error
```

</div>

</div>

<div class="zn-split-item">

### Your database, your library {#your-database-your-library}

Znight wires your data layer; it does not replace it. A `@Factory()` opens the client at boot (async,
awaited before the first request) and closes it on shutdown; repositories behind interfaces keep
services testable with mocks. Use the library that fits your data: for SQL, we recommend
[Drizzle](https://orm.drizzle.team).

[Read the data access guide →](/guide/data-access)

</div>

</div>

<div class="zn-section-head">

<p class="zn-eyebrow">Examples</p>

## Learn from complete applications {#examples}

Nine production-shaped [example applications](/examples), each tested at every level, end to end on
Node.js and Bun.

</div>

<ExampleGrid />

<div class="zn-cta">

<p class="zn-eyebrow">Get started</p>

## Build your first service in minutes {#get-started}

Scaffold an application, write a provider, and let the compiler wire it.

<div class="zn-cta-actions">

[Create your first application](/guide/getting-started){.zn-cta-button .zn-cta-brand}
[Migrate from NestJS](/guide/migrating-from-nestjs){.zn-cta-button}
[Read the roadmap](/roadmap){.zn-cta-button}

</div>

</div>
