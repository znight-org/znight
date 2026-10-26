---
description: "@znight/testing - TestBed with auto-mocked dependencies for unit tests and TestApp for in-memory end-to-end tests, with Vitest, Jest or bun:test."
---

# @znight/testing <Badge type="tip" text="available" />

Testing utilities for Znight: `TestBed` builds one provider with its dependencies auto-mocked;
`TestApp` runs the whole application and injects HTTP requests in memory. It reads the generated
metadata structurally and depends on no feature package; it works with Vitest, Jest and `bun:test`,
on Node.js and Bun.

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
- Classes, interfaces, `@Provides` values and plugin-provided types → auto-mocks; `@Config()`
  classes → real instances (initializers, `@Default` values, then the `config` option); qualified
  values (`@Inject('apiUrl')`, primitives) → the `provide` value, an error otherwise; optional →
  `undefined`; arrays → `[]`; `Lazy<T>` → a handle over the mock.
- Options: `metadata`, `provide`, `overrides` (values or `{ scope, deps, factory }` definitions),
  `config`, `mockFn`, `deep`, `aop`. Keys are classes, tokens, aliases or unique display names.
- Interceptors are not applied unless `aop: 'real'`. Lifecycle hooks are never called.
- `mocks.get()` accepts classes, tokens, aliases and display names (`mocks.get<Logger>('Logger')`);
  `mocks.clearAll()` / `mocks.resetAll()`.
- Auto-mocks are not thenable (`then` is `undefined`), so returning one from an async function is
  safe; with a class, `instanceof` works. `createMock(Class?, partial?)` creates one yourself.

### Spy implementation

The spy factory is detected automatically: `vi.fn` (Vitest), `jest.fn` (Jest) or `mock`
(`bun:test`), falling back to a built-in Jest-compatible spy. Pass `mockFn` to choose explicitly.

## TestApp

```ts
import { HttpPlugin } from '@znight/http'
import { TestApp } from '@znight/testing'

await using app = await TestApp.create({
  metadata,
  plugins: [HttpPlugin.configure({ port: 0 })], // any adapter; port 0: a free port
  overrides: [[UserRepository, fakeRepo]],
})

const res = await app.inject({ url: '/users/1' }) // method: GET by default
expect(res.status).toBe(200)
expect(res.json()).toEqual({ id: 1, name: 'Ada' })

const form = new FormData()
form.append('avatar', new File([png], 'me.png', { type: 'image/png' }))
const upload = await app.inject({ method: 'POST', url: '/profile/avatar', body: form })
const download = await app.inject({ url: '/reports/q1.pdf' })
download.bytes // Uint8Array: the raw body
```

- `TestApp.create({ metadata, plugins?, providers?, overrides?, only?, start?, logger?, shutdown? })`
  runs `Application.create()` then `start()` (unless `start: false`); signal handlers are disabled.
- `overrides` are applied last (highest precedence).
- Only the dependency closure of controllers (with their guards and interceptors), consumers,
  overridden providers and the providers plugins resolve at bootstrap (`HttpPlugin`'s global
  guards, interceptors and exception mappers, listed by the plugin's `initRoots()`) is instantiated
  by default (`only: 'all'` or a list of keys otherwise).
- `inject({ method?, url, headers?, body?, query? })` goes through the HTTP plugin in memory (no
  network call) and resolves with `{ status, headers, body, bytes, json() }`. Bodies: objects as
  JSON, strings and bytes as is, `FormData` as `multipart/form-data`, `Blob` / `File` with its type.
- `close()` (or `await using`) stops the application; `get(key)`, `container` and `app` give access
  to it.

## Keeping metadata fresh

Tests import the generated container, so regenerate it first: the `@znight/compiler/bun` preload for
`bun test`, the Vite plugin under Vitest, or `znight generate` otherwise. See
[Testing](/guide/testing#keep-the-metadata-fresh).
