---
description: Create a Znight application with the CLI or by hand, write a first service and controller, then build and run it on Node.js or Bun.
---

# Getting started

This page takes you from an empty folder to a running HTTP API with a service, an interface-based
repository and a controller.

**Prerequisites**

- [Node.js](https://nodejs.org) 24 or later, or [Bun](https://bun.sh) 1.3 or later.
- A TypeScript-aware editor. Znight is ESM-only.

## Create a project with the CLI

The quickest way to start is the `znight` CLI:

::: code-group

```sh [npm]
npx @znight/cli new my-service
```

```sh [pnpm]
pnpm dlx @znight/cli new my-service
```

```sh [bun]
bunx @znight/cli new my-service
```

:::

The CLI asks for a package manager and an HTTP adapter (Fastify, Express or Hono), then creates the
project described below. Start it in development mode:

```sh
cd my-service
npm run dev # znight dev: rebuilds and restarts on every change
```

<!-- TODO(api): verify against implementation (CLI prompts, template names and generated files) -->

Prefer to understand every file? Set the project up by hand instead.

## Manual setup

### 1. Install the packages

::: code-group

```sh [npm]
npm install @znight/core @znight/http fastify
npm install -D @znight/compiler @znight/cli vite typescript @types/node
```

```sh [pnpm]
pnpm add @znight/core @znight/http fastify
pnpm add -D @znight/compiler @znight/cli vite typescript @types/node
```

```sh [bun]
bun add @znight/core @znight/http fastify
bun add -d @znight/compiler @znight/cli vite typescript @types/node
```

:::

| Package            | Role                                                                        |
| ------------------ | --------------------------------------------------------------------------- |
| `@znight/core`     | Runtime: container, application lifecycle, plugins, decorators              |
| `@znight/http`     | HTTP controllers and the `HttpPlugin` (Fastify here; Express/Hono work too) |
| `@znight/compiler` | Build time only: Vite plugin that generates the container                   |
| `@znight/cli`      | Optional: `znight dev`, `znight generate`, code generators                  |

### 2. Configure TypeScript

Znight decorators use TypeScript's `experimentalDecorators` (parameter decorators such as `@Param()`
need them). You do **not** need `emitDecoratorMetadata` nor `reflect-metadata`.

::: code-group

```json [tsconfig.json]
{
  "compilerOptions": {
    "target": "ES2024",
    "lib": ["ES2024", "ESNext.Disposable"],
    "module": "preserve",
    "moduleResolution": "bundler",
    "strict": true,
    "experimentalDecorators": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

:::

### 3. Add the Vite plugin

The compiler is a Vite plugin. With its defaults it also configures Vite to build a server
application: entry `src/main.ts`, output `dist/`, target `node24`, source maps on.

::: code-group

```ts [vite.config.ts]
import { znight } from '@znight/compiler'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [znight()],
})
```

:::

### 4. Scripts and ignored files

::: code-group

```json [package.json]
{
  "name": "my-service",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "znight dev",
    "build": "vite build",
    "start": "node dist/main.js",
    "typecheck": "znight generate && tsc --noEmit"
  }
}
```

:::

The generated container is rebuilt from your sources every time: do not commit it.

::: code-group

```txt [.gitignore]
node_modules
dist
.znight
```

:::

## Write your first provider

A **provider** is any class the container creates for you. Mark it with `@Injectable()` and declare
its dependencies as constructor parameters: the compiler reads their types.

Start with a model and a repository **interface**:

::: code-group

```ts [src/users/user.repository.ts]
export interface User {
  id: number
  name: string
}

export interface UserRepository {
  findById(id: number): Promise<User | undefined>
}
```

:::

Implement it with an in-memory class. `implements UserRepository` is what lets the compiler bind the
interface to this class:

::: code-group

```ts [src/users/in-memory-user.repository.ts]
import { Injectable } from '@znight/core'
import type { User, UserRepository } from './user.repository.js'

@Injectable()
export class InMemoryUserRepository implements UserRepository {
  readonly #users = new Map<number, User>([[1, { id: 1, name: 'Ada Lovelace' }]])

  async findById(id: number): Promise<User | undefined> {
    return this.#users.get(id)
  }
}
```

:::

Then a service that depends on the interface, not on the implementation:

::: code-group

```ts [src/users/user.service.ts]
import { Injectable } from '@znight/core'
import type { User, UserRepository } from './user.repository.js'

@Injectable()
export class UserService {
  constructor(private readonly users: UserRepository) {}

  findById(id: number): Promise<User | undefined> {
    return this.users.findById(id)
  }
}
```

:::

::: tip Type-only imports are fine
The compiler reads types from the source, so `import type` works for injected interfaces. Injected
classes can be imported either way.
:::

## Add a controller

Controllers are providers too. Route parameters are extracted and coerced for you: `id` arrives as a
`number` (an invalid value is answered with `400 Bad Request`).

::: code-group

```ts [src/users/user.controller.ts]
import { Controller, Get, HttpException, Param } from '@znight/http'
import type { User } from './user.repository.js'
import { UserService } from './user.service.js'

@Controller('/users')
export class UserController {
  constructor(private readonly users: UserService) {}

  @Get('/:id')
  async getUser(@Param('id') id: number): Promise<User> {
    const user = await this.users.findById(id)
    if (user === undefined) throw new HttpException(404, `User ${id} not found`)
    return user
  }
}
```

:::

<!-- TODO(api): verify against implementation (HttpException signature, adapter import path) -->

## Bootstrap the application

`main.ts` imports the generated metadata and creates the application with its plugins:

::: code-group

```ts [src/main.ts]
import { Application } from '@znight/core'
import { HttpPlugin } from '@znight/http'
import { fastify } from '@znight/http/fastify'
import { __ZNIGHT_METADATA__ } from './.znight/container.generated.js'

const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins: [HttpPlugin.configure({ adapter: fastify(), port: 3000 })],
})

await app.start() // Ctrl+C (SIGINT) or SIGTERM stops it gracefully
```

:::

::: warning Only entry points import the generated module
Import `container.generated` from `main.ts` and from tests, never from a provider file: that would
create an ESM import cycle ([`ZNIGHT020`](/reference/error-codes#znight020)). Inject the
`Container` instead if a provider really needs it.
:::

## Build and run

```sh
npm run build   # vite build: compiles the container, bundles to dist/
npm start       # node dist/main.js
```

```sh
curl http://localhost:3000/users/1
# {"id":1,"name":"Ada Lovelace"}
curl -i http://localhost:3000/users/abc
# HTTP/1.1 400 Bad Request
```

During development, `npm run dev` (`znight dev`) rebuilds in watch mode and restarts the process after
every successful build.

::: details Running on Bun
The build output runs on Bun as is: `bun dist/main.js`. Bun can also run your sources directly
(`bun src/main.ts`): register the compiler's Bun preload so the container is regenerated before the
app and tests start. See [Bun preload](./compiler#bun-preload).
:::

::: details Why not `node src/main.ts`?
Node.js can run TypeScript by stripping types, but decorators are not erasable syntax. Run the Vite
build output with Node.js (the plugin strips Znight decorators from the bundle), or use Bun for
sources.
:::

## Look at what the compiler generated

Open `src/.znight/container.generated.ts` (run `npx znight generate` to create it without building).
It is plain TypeScript:

```ts
export const __ZNIGHT_METADATA__: ZnightMetadata = {
  version: 1,
  compiler: '0.1.0',
  providers: {
    ['src/users/in-memory-user.repository.ts#InMemoryUserRepository']: {
      scope: 'singleton',
      class: InMemoryUserRepository,
      deps: [],
      factory: () => new InMemoryUserRepository(),
    },
    ['src/users/user.service.ts#UserService']: {
      scope: 'singleton',
      class: UserService,
      deps: ['src/users/in-memory-user.repository.ts#InMemoryUserRepository'],
      factory: d => new UserService(d[0]),
    },
    // UserController, routes in extensions.http...
  },
  resolutionOrder: [
    'src/users/in-memory-user.repository.ts#InMemoryUserRepository',
    'src/users/user.service.ts#UserService',
    'src/users/user.controller.ts#UserController',
  ],
  aliases: {
    ['src/users/user.repository.ts#UserRepository']: 'src/users/in-memory-user.repository.ts#InMemoryUserRepository',
  },
  // ...
}
```

The `UserRepository` parameter of `UserService` was bound to `InMemoryUserRepository` at build time.

## Break it on purpose

Remove `@Injectable()` from `InMemoryUserRepository` and build again:

```txt
✗ ZNIGHT001: Missing provider for 'UserRepository' required by UserService
  --> src/users/user.service.ts:6:38
   |
 6 |   constructor(private readonly users: UserRepository) {}
   |                                       ^^^^^^^^^^^^^^
   = hint: InMemoryUserRepository implements UserRepository but is not decorated with @Injectable()
           (src/users/in-memory-user.repository.ts:5)

Build failed with 1 error.
```

The mistake never reaches production. Every code is explained in the
[error reference](/reference/error-codes).

## Next steps

- [Project structure](./project-structure): how to organise a growing application.
- [Dependency injection](./dependency-injection): qualifiers, factories, optional and lazy
  dependencies.
- [HTTP](/packages/http): routing, validation, guards and interceptors.
- [Testing](./testing): unit tests with auto-mocks and end-to-end tests without a network.
