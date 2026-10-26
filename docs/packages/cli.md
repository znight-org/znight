---
description: "@znight/cli - the znight command: scaffold projects, generate the container and code, run the development loop, build and start."
---

# @znight/cli <Badge type="warning" text="in development" />

The `znight` command line: project scaffolding, code generators, container generation and the
development loop.

<!-- TODO(api): verify against implementation (commands follow the specification; flags may change) -->

```sh
npm install -D @znight/cli @znight/compiler vite
```

`vite` and `@znight/compiler` are peer dependencies: the CLI drives the compiler you installed.

## Commands

| Command                   | Description                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `znight new <name>`       | Create a project (asks for the package manager and the HTTP adapter)               |
| `znight generate`         | Write the generated container (`src/.znight/container.generated.ts`)               |
| `znight generate --check` | Exit with code 1 when the generated file is missing or stale (CI)                  |
| `znight generate --watch` | Keep the generated file up to date (for `tsc --watch` and editors)                 |
| `znight g <kind> <name>`  | Generate a `service`, `controller`, `consumer`, `config`, `guard` or `interceptor` |
| `znight dev`              | Vite build in watch mode; restarts the process after every successful rebuild      |
| `znight build`            | Production build (`vite build`)                                                    |
| `znight start`            | Run the production build                                                           |

## Create a project

```sh
npx @znight/cli new my-service
```

## Generate code

```sh
npx znight g service users/user
# creates src/users/user.service.ts

npx znight g controller users/user
# creates src/users/user.controller.ts
```

Generated files are plain TypeScript with the right decorators: there is nothing to register
afterwards, the compiler discovers them.

## Development loop

```sh
npx znight dev
```

`znight dev` rebuilds on every change and **restarts the whole process** after each successful
build. There is no partial hot replacement of providers: a restart is fast and always consistent.
Diagnostics are printed on every rebuild; an application built from a graph with errors refuses to
start and shows them again.

## In CI

```sh
npx znight generate --check   # the generated container is up to date
npx tsc --noEmit
npx znight build
```
