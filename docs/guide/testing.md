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

- **Vitest**: Vitest uses your `vite.config.ts`, so the `znight()` plugin compiles the module before
  the tests import it (and recompiles in watch mode).
- **Anything else**: run `znight generate` before the test command.

Both read the compiler options of `znight.config.ts` ([options](./compiler#options)), like
`znight generate`.

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

| Dependency                                       | In the TestBed                                                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Class, interface, `@Provides` value, plugin type | Auto-mock: every method is a spy returning `undefined` until configured                            |
| `@Config()` class                                | A real instance: initializers, then `@Default` values, then your `config` values                   |
| Qualified value (`@Inject('apiUrl')`, primitive) | The `provide` value (a `ZNIGHT001` error naming it otherwise)                                      |
| Optional                                         | `undefined` (or the `provide` value)                                                               |
| Array (multi)                                    | `[]` (or the provided members)                                                                     |
| `Lazy<T>`                                        | A handle whose `get()` returns the mock of `T` (the same as `mocks.get(T)`)                        |
| Method interceptors                              | Not created, not applied (unless `aop: 'real'`: built with auto-mocked dependencies, then applied) |

```ts
const { instance, mocks, container } = await TestBed.create(PaymentService, {
  metadata,
  provide: { 'AppFactory.apiUrl': 'http://test' }, // qualified values, optional and multi members
  overrides: [[Clock, fixedClock]], // values or { scope, deps, factory } definitions, win over provide
  config: { payment: { currency: 'EUR' } }, // values of @Config('payment') classes
  deep: true, // unconfigured methods return deep mocks instead of undefined
  aop: 'real', // apply the method interceptors
})
```

Keys of `provide` and `overrides` are classes, tokens, aliases or unique display names. TestBed never
calls lifecycle hooks; `container` holds the target and what was injected into it.

Auto-mocks are safe to `await` and to serialise: `then`, `toJSON`, `asymmetricMatch`, `$$typeof`,
`nodeType`, `__esModule` and symbol keys (`Symbol.toPrimitive`...) read as `undefined`. With a class,
`instanceof` works. `mocks.get()` accepts a class, a token, an alias or a display name and explains
why a key was not auto-mocked; `mocks.clearAll()` / `mocks.resetAll()` forget calls (and programmed
behaviours). `createMock(Class?)` creates a standalone mock.

The spy implementation is detected automatically: `vi.fn` (Vitest), `jest.fn` (Jest) or `mock`
(`bun:test`), with a built-in Jest-compatible fallback. Pass `mockFn` to choose explicitly (or
`setDefaultMockFn()` once).

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

`TestApp` starts the real application with its plugins and injects requests **in memory** through
the HTTP adapter: the whole pipeline runs (routing, guards, validation, interceptors, serialisation)
without any network call.

```ts
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { HttpPlugin } from '@znight/http'
import { fastifyAdapter } from '@znight/http/fastify'
import { TestApp } from '@znight/testing'
import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { UserRepository } from '../src/users/user.repository.js'

let app: TestApp

beforeAll(async () => {
  app = await TestApp.create({
    metadata,
    // port 0: the started application listens on a free port, so test files never collide
    plugins: [HttpPlugin.configure({ adapter: fastifyAdapter(), port: 0 })],
    overrides: [[UserRepository, new FakeUserRepository([{ id: 1, name: 'Ada' }])]],
  })
})

afterAll(() => app.close())

it('GET /users/:id', async () => {
  const res = await app.inject({ url: '/users/1' }) // method: GET by default
  expect(res.status).toBe(200)
  expect(res.json()).toEqual({ id: 1, name: 'Ada' })
})

it('validates the id', async () => {
  const res = await app.inject({ method: 'GET', url: '/users/abc' })
  expect(res.status).toBe(400)
})
```

`TestApp.create({ metadata, plugins?, providers?, overrides?, only?, start?, logger?, shutdown? })`
runs `Application.create()` then `app.start()` (unless `start: false`), with signal handlers
disabled. It applies `overrides` last and by default instantiates only the dependency closure of the
HTTP controllers (with their guards and interceptors), the message consumers, the overridden
providers and the global guards, interceptors and exception mappers of
`HttpPlugin.configure({ ... })` (`only: 'all'` or a list of keys to choose; overrides and those
globals are added to the list). The default logger only prints warnings and errors.
`app.get(key)`, `app.container` and `app.app` give access to the running application;
`await using app = await TestApp.create(...)` closes it automatically.

::: tip Global providers with async dependencies
Plugin options computed from the container (`HttpPlugin.configure(c => ({ ... }))`) cannot be read
before the boot. When a global guard declared there depends on an async provider, the boot fails
with [`ZNIGHT015`](/reference/error-codes#znight015) ("its factory is async"): list it in `only`
(`only: [UserController, AuthGuard]`), or pass `only: 'all'`.
:::

`app.inject({ method?, url, headers?, body?, query? })` resolves with
`{ status, headers, body, bytes, json() }`: `body` is the response decoded as UTF-8, `bytes` the raw
bytes (downloads). Request bodies are encoded for you: objects as JSON, strings and bytes as is, a
`FormData` as `multipart/form-data`, a `Blob` / `File` with its type.

### Uploads and downloads

Send files as a `FormData` body, read binary responses from `bytes`:

```ts
import { readFile } from 'node:fs/promises'

it('POST /profile/avatar stores the image', async () => {
  const form = new FormData()
  form.append('title', 'Me') // text fields: @Body() receives { title: 'Me' }
  form.append('avatar', new File([await readFile('test/fixtures/me.png')], 'me.png', { type: 'image/png' }))

  const res = await app.inject({ method: 'POST', url: '/profile/avatar', body: form })
  expect(res.status).toBe(201)
  expect(res.json()).toMatchObject({ title: 'Me', size: expect.any(Number) })
})

it('rejects other file types', async () => {
  const form = new FormData()
  form.append('avatar', new File(['hello'], 'me.txt', { type: 'text/plain' }))
  const res = await app.inject({ method: 'POST', url: '/profile/avatar', body: form })
  expect(res.status).toBe(415) // @UploadedFile('avatar', { mimeTypes: ['image/png', 'image/jpeg'] })
})

it('GET /reports/:name supports ranges', async () => {
  const res = await app.inject({ url: '/reports/q1.pdf', headers: { range: 'bytes=0-99' } })
  expect(res.status).toBe(206)
  expect(res.headers['content-range']).toMatch(/^bytes 0-99\//)
  expect(res.bytes.byteLength).toBe(100)
})
```

The upload rules of the route (`maxSize`, `maxFiles`, `mimeTypes`, required files) apply exactly as
over the network: see [files](/packages/http#files).

### Messages

Message consumers are tested with the in-memory driver of `@znight/messaging`: a deterministic
broker that your test drives and inspects.

```ts
import { MessagingPlugin } from '@znight/messaging'
import { memory } from '@znight/messaging/memory'

const driver = memory()
await using app = await TestApp.create({ metadata, plugins: [MessagingPlugin.configure({ driver })] })

driver.send('orders', { payload: { id: 1 }, type: 'order.placed' }) // as an external producer
await driver.idle() // nothing in flight, scheduled or deliverable
expect(driver.settlements('orders')).toMatchObject([{ action: 'ack' }])
expect(driver.deadLetters('orders')).toEqual([])
```

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
