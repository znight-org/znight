---
layout: home
title: Znight
titleTemplate: Compile-time dependency injection for TypeScript
description: Znight is a TypeScript backend framework with compile-time dependency injection. A compiler resolves and validates your providers at build time; the runtime only runs generated factories.

hero:
  name: Znight
  text: Compile-time dependency injection for TypeScript
  tagline: A backend framework whose compiler resolves and validates your dependency graph at build time. The runtime only runs generated code.
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
      link: https://github.com/ugho49/Znight

features:
  - icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/></svg>
    title: Compile-time DI
    details: A compiler reads your TypeScript at build time, binds every constructor parameter to a provider and generates the container. No reflect-metadata, no runtime type lookup.
    link: /guide/compiler
    linkText: How the compiler works
  - icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>
    title: Errors at build time
    details: Missing providers, cycles, scope mismatches and ambiguous injections fail the build with a ZNIGHT code, a code frame and a hint, before anything is deployed.
    link: /reference/error-codes
    linkText: Browse error codes
  - icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="12" cy="18" r="3"/><path d="M9 6h6M7.5 8.6l3 6.8M16.5 8.6l-3 6.8"/></svg>
    title: Flat and auto-discovered
    details: One container, no modules. Providers are found by scanning your sources. Inject classes, interfaces, qualified, optional, lazy and multi dependencies.
    link: /guide/dependency-injection
    linkText: Dependency injection
  - icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="m10 13-2 2 2 2M14 13l2 2-2 2"/></svg>
    title: Transparent by design
    details: The container is a deterministic, type-checked TypeScript module you can read, diff and step through. Decorators are markers, stripped from the bundle.
    link: /guide/compiler#the-generated-module
    linkText: See the generated code
  - icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M17.5 14v7M14 17.5h7"/></svg>
    title: Composable plugins
    details: HTTP (Fastify, Express, Hono), messaging (RabbitMQ, SQS, Kafka), typed config and observability (Pino, Prometheus, OpenTelemetry) are independent packages.
    link: /packages/
    linkText: Explore the packages
  - icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2c3 2.5 4.5 6 4.5 10.5L14 17h-4l-2.5-4.5C7.5 8 9 4.5 12 2z"/><circle cx="12" cy="9" r="1.5"/><path d="m10 17-1 4 3-2 3 2-1-4"/></svg>
    title: Fast everywhere
    details: Factories run in a precomputed order, independent async singletons start concurrently, cold starts are instant. Runs on Node.js 24+ and Bun 1.3+.
    link: /guide/deployment
    linkText: Deploy anywhere
---

## Write plain classes. Get a compiled container.

You write services and controllers with familiar decorators. At build time, the compiler turns them
into a plain module: every provider, its dependencies, its scope and the order to create them in.

::: code-group

```ts [user.service.ts]
import { Injectable } from '@znight/core'
import { UserRepository } from './user.repository.js'

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
import { Application } from '@znight/core'
import { HttpPlugin } from '@znight/http'
import { __ZNIGHT_METADATA__ } from './.znight/container.generated.js'

const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins: [HttpPlugin.configure({ port: 3000 })],
})
await app.start()
```

```ts [.znight/container.generated.ts]
// AUTO-GENERATED by @znight/compiler. Do not edit.
export const __ZNIGHT_METADATA__: ZnightMetadata = {
  version: 1,
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
  aliases: { ['src/users/user.repository.ts#UserRepository']: 'src/users/pg-user.repository.ts#PgUserRepository' },
}
```

:::

`UserRepository` is an interface: the compiler found its only implementation, `PgUserRepository`, and
bound it. Nothing is looked up by name or reflected at runtime.

## Why Znight

Runtime DI containers (NestJS, InversifyJS, tsyringe...) discover your dependency graph **while the
application boots**, using `reflect-metadata` and decorator side effects. Znight does that work
**once, in the compiler**.

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

## Mistakes surface while you build

```txt
$ vite build

✗ ZNIGHT001: Missing provider for 'EmailService' required by NotificationService
  --> src/notification/notification.service.ts:12:5
   |
12 |     private readonly email: EmailService,
   |                             ^^^^^^^^^^^^
   = hint: Add @Injectable() to EmailService (src/email/email.service.ts:3)

Build failed with 1 error.
```

Every diagnostic has a stable code documented in the [error reference](/reference/error-codes), with
an example and the usual fixes.

<div class="zn-home-cta">

**Ready?** [Create your first application →](/guide/getting-started) &nbsp;·&nbsp; Coming from
NestJS? [Read the migration guide →](/guide/migrating-from-nestjs)

</div>
