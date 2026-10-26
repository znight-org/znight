---
description: "@znight/testing - TestBed with auto-mocked dependencies for unit tests and TestApp for in-memory end-to-end tests, with Vitest, Jest or bun:test."
---

# @znight/testing <Badge type="warning" text="in development" />

Testing utilities for Znight: `TestBed` builds one provider with its dependencies auto-mocked;
`TestApp` runs the whole application and injects HTTP requests in memory.

<!-- TODO(api): verify against implementation (this page follows the specification; names and options may change) -->

```sh
npm install -D @znight/testing
```

## TestBed

```ts
import { TestBed } from '@znight/testing'

const { instance, mocks } = await TestBed.create(UserService, { metadata })
mocks.get(UserRepository).findById.mockResolvedValue({ id: 1, name: 'Ada' })

expect(await instance.findById(1)).toEqual({ id: 1, name: 'Ada' })
```

- The target is built with its **real** code; its **direct** dependencies are replaced by mocks.
- Classes, interfaces and plugin-provided types → auto-mocks; `@Config()` classes → real instances
  from defaults plus `config` overrides; qualified primitives → must be provided; optional →
  `undefined`; arrays → `[]`; `Lazy<T>` → a handle over the mock.
- Interceptors are not applied unless `aop: 'real'`.
- `mocks.get()` accepts classes, tokens and display names.
- Auto-mocks are not thenable (`then` is `undefined`), so returning one from an async function is
  safe.

### Spy implementation

The spy factory is detected automatically: `vi.fn` (Vitest), `jest.fn` (Jest) or `mock`
(`bun:test`), falling back to a built-in Jest-compatible spy. Pass `mockFn` to choose explicitly.

## TestApp

```ts
import { TestApp } from '@znight/testing'

const app = await TestApp.create({
  metadata,
  plugins: [HttpPlugin.configure({ adapter: fastify() })],
  overrides: [[UserRepository, fakeRepo]],
})

const res = await app.inject({ method: 'GET', url: '/users/1' })
expect(res.statusCode).toBe(200)

await app.stop()
```

- Signal handlers are disabled.
- `overrides` are applied last (highest precedence).
- Only the dependency closure of controllers and consumers is instantiated by default.
- `inject()` goes through the adapter in memory: no port, no network.

## Keeping metadata fresh

Tests import the generated container, so regenerate it first: the `@znight/compiler/bun` preload for
`bun test`, the Vite plugin under Vitest, or `znight generate` otherwise. See
[Testing](/guide/testing#keep-the-metadata-fresh).
