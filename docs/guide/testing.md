---
description: Test Znight applications - plain unit tests, TestBed with auto-mocked dependencies, TestApp for in-memory end-to-end tests, overrides, and keeping the generated metadata fresh.
---

# Testing

Compile-time DI keeps tests simple: providers are ordinary classes with constructor parameters, and
the container is an ordinary object built from ordinary metadata. Pick the lightest tool that does
the job:

| You want to test...                           | Use                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------- |
| A class in isolation, with hand-written fakes | `new MyService(fake)`: no framework needed                                      |
| A class with its dependencies auto-mocked     | [`TestBed`](#testbed-unit-tests-with-auto-mocks) (`@znight/testing`)            |
| Part of the real graph, some pieces replaced  | [`Container` + `override`](#the-real-container-with-overrides) (`@znight/core`) |
| The whole application through HTTP            | [`TestApp`](#testapp-end-to-end-tests) (`@znight/testing`)                      |

Znight works with `bun:test`, Vitest and Jest. Examples below use `bun:test`.

::: tip Interfaces are erased at runtime
In the examples below, `UserRepository` is an **abstract class**, so it can be used as a key at
runtime (`overrides`, `mocks.get()`). When the type is an interface, use its token instead
(`'src/users/user.repository.ts#UserRepository'`) or its display name (`'UserRepository'`) where
accepted.
:::

## Keep the metadata fresh

Tests that use the container import the generated module, so it must be up to date before they run:

- **Bun**: register the compiler preload in `bunfig.toml` ([details](./compiler#bun-preload)):

  ::: code-group

  ```toml [bunfig.toml]
  [test]
  preload = ["@znight/compiler/bun"]
  ```

  :::

- **Vitest**: add the Vite plugin to your Vitest config; it regenerates the module before tests.
- **Anything else**: run `znight generate` before the test command.

## Plain unit tests

Constructor injection means you can always build a provider yourself:

::: code-group

```ts [test/users/user.service.test.ts]
import { describe, expect, it } from 'bun:test'
import { UserService } from '../../src/users/user.service.js'
import type { UserRepository } from '../../src/users/user.repository.js'

describe('UserService', () => {
  it('finds a user', async () => {
    const users: UserRepository = { findById: async id => ({ id, name: 'Ada' }) }
    const service = new UserService(users)

    expect(await service.findById(1)).toEqual({ id: 1, name: 'Ada' })
  })
})
```

:::

No container, no metadata, no decorators executed: this is the fastest feedback loop. Reach for the
tools below when building fakes by hand gets tedious.

## TestBed: unit tests with auto-mocks

`TestBed.create()` builds the target with its **real** code and replaces each direct dependency with
a mock, using the compiled metadata to know what the dependencies are:

```ts
import { describe, expect, it } from 'bun:test'
import { TestBed } from '@znight/testing'
import { __ZNIGHT_METADATA__ as metadata } from '../../src/.znight/container.generated.js'
import { UserRepository } from '../../src/users/user.repository.js'
import { UserService } from '../../src/users/user.service.js'

describe('UserService', () => {
  it('returns undefined for an unknown user', async () => {
    const { instance, mocks } = await TestBed.create(UserService, { metadata })
    mocks.get(UserRepository).findById.mockResolvedValue(undefined)

    expect(await instance.findById(42)).toBeUndefined()
    expect(mocks.get(UserRepository).findById).toHaveBeenCalledWith(42)
  })
})
```

How each kind of dependency is handled:

| Dependency                                | In the TestBed                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| Class, interface, plugin-provided type    | Auto-mock: every method is a spy returning `undefined` until configured |
| `@Config()` class                         | A real instance built from defaults, plus your `config` overrides       |
| Qualified primitive (`@Inject('apiUrl')`) | Must be provided                                                        |
| Optional                                  | `undefined`                                                             |
| Array (multi)                             | `[]`                                                                    |
| `Lazy<T>`                                 | A handle whose `get()` returns the mock of `T`                          |
| Method interceptors                       | Not applied (unless `aop: 'real'`)                                      |

Auto-mocks are safe to `await` and to serialise: `then`, `toJSON`, `Symbol.toPrimitive` and
`asymmetricMatch` are `undefined`. `mocks.get()` accepts a class, a token or a display name.

The spy implementation is detected automatically: `vi.fn` (Vitest), `jest.fn` (Jest) or `mock`
(`bun:test`), with a built-in Jest-compatible fallback. Pass `mockFn` to choose explicitly.

<!-- TODO(api): verify against implementation (TestBed options: metadata, config, aop, mockFn, provided values) -->

## The real container with overrides

`@znight/core` alone lets you run the real graph and replace a few providers. `overrides` have the
highest precedence and accept classes or tokens as keys:

```ts
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { Application } from '@znight/core'
import { __ZNIGHT_METADATA__ } from '../src/.znight/container.generated.js'
import { UserRepository } from '../src/users/user.repository.js'
import { UserService } from '../src/users/user.service.js'

const fakeUsers = new FakeUserRepository([{ id: 1, name: 'Ada' }]) // a hand-written fake
let app: Application

beforeAll(async () => {
  app = await Application.create({
    metadata: __ZNIGHT_METADATA__,
    overrides: [[UserRepository, fakeUsers]], // keys: classes or tokens
    init: { only: [UserService] }, // only build what this test needs
    shutdown: { signals: false },
  })
  await app.start()
})

afterAll(() => app.stop())

it('uses the fake repository', async () => {
  expect(await app.get(UserService).findById(1)).toEqual({ id: 1, name: 'Ada' })
})
```

- An override value that looks like a provider definition (`{ scope, deps, factory }`) is registered
  as a definition, so the replacement can have dependencies of its own.
- `init.only` instantiates the dependency closure of the given providers only: unrelated database
  pools or brokers are never created.
- For lower-level tests, `Container.create(metadata)` gives you `override()`, `registerValue()`,
  `init()` and `get()` directly.

## TestApp: end-to-end tests

`TestApp` starts the real application with its plugins, without opening a port: requests are injected
in memory through the HTTP adapter.

```ts
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { HttpPlugin } from '@znight/http'
import { fastify } from '@znight/http/fastify'
import { TestApp } from '@znight/testing'
import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { UserRepository } from '../src/users/user.repository.js'

let app: TestApp

beforeAll(async () => {
  app = await TestApp.create({
    metadata,
    plugins: [HttpPlugin.configure({ adapter: fastify() })],
    overrides: [[UserRepository, new FakeUserRepository([{ id: 1, name: 'Ada' }])]],
  })
})

afterAll(() => app.stop())

it('GET /users/:id', async () => {
  const res = await app.inject({ method: 'GET', url: '/users/1' })
  expect(res.statusCode).toBe(200)
  expect(res.json()).toEqual({ id: 1, name: 'Ada' })
})

it('validates the id', async () => {
  const res = await app.inject({ method: 'GET', url: '/users/abc' })
  expect(res.statusCode).toBe(400)
})
```

`TestApp` disables signal handlers, applies `overrides` last, and by default instantiates only the
dependency closure of controllers and consumers.

<!-- TODO(api): verify against implementation (TestApp.create options, inject() response shape, messaging helpers) -->

## Testing interceptors and plugins

- **Interceptors** are providers: test them with `interceptMethod()` from `@znight/core` (see
  [AOP](./aop#interceptors-outside-of-the-container)) or with `TestBed` and `aop: 'real'`.
- **Plugins** are plain objects: create an `Application` with `metadata` built for the test (a
  `ZnightMetadata` literal with the providers you need) and your plugin, then assert on its effects.

```ts
const metadata: ZnightMetadata = {
  version: 1,
  providers: {},
  resolutionOrder: [],
  externals: [{ token: ClockToken, providedBy: 'ClockPlugin' }],
}
const app = await Application.create({ metadata, plugins: [ClockPlugin.configure()], shutdown: { signals: false } })
expect(app.get(ClockToken).now()).toBeInstanceOf(Date)
await app.stop()
```

## Tips

- Always `await app.stop()` (in `afterAll`/`afterEach`) so pools, servers and timers are released and
  the test runner exits.
- Pass `shutdown: { signals: false }` when you create an `Application` yourself in tests.
- Keep test files out of `include` (the default `exclude` handles `*.test.*` and `*.spec.*`): test
  doubles decorated with `@Injectable()` would otherwise become providers.
