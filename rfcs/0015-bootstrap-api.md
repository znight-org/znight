# RFC 0015: Generated application entry (`metadata`, `createApplication`)

|          |                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status   | Accepted (2026-11-11, requested by the maintainer)                                                                                                                                                                                                                                                                                                                                                 |
| Date     | 2026-11-11                                                                                                                                                                                                                                                                                                                                                                                         |
| Affects  | `@znight/compiler` (exports of the generated module and of the error module, reserved names), `@znight/core` (new `CreateApplicationOptions` type), `@znight/openapi` (`znight openapi` reads `metadata`), `@znight/testing` (messages), `@znight/cli` (scaffold). Specification §3.3, §8.2, §10, §11; every example, guide and README. No new error code                                       |
| Decision | **The generated module exports `metadata` (the compiled graph) and `createApplication(options)`, which is `Application.create({ ...options, metadata })`. `createApplication` is the convention in `main.ts`; tests pass `{ metadata }`. `__ZNIGHT_METADATA__` stays as a `@deprecated` alias of `metadata` in 0.9 and is removed in 0.10. No registry, no global state, no toolchain injection** |

## 1. Summary

Every Znight application starts with the same two lines:

```ts
import { __ZNIGHT_METADATA__ } from './.znight/container.generated.js'

const app = await Application.create({ metadata: __ZNIGHT_METADATA__, plugins: [...] })
```

The export name is loud, and every test of the repository already renames it
(`import { __ZNIGHT_METADATA__ as metadata }`, 64 occurrences, the CLI scaffold included). This RFC
gives the generated module a short export, `metadata`, and a function bound to it,
`createApplication()`. `main.ts` becomes:

```ts
import { HttpPlugin } from '@znight/http'

import { createApplication } from './.znight/container.generated.js'

const app = await createApplication({ plugins: [HttpPlugin.configure({ port: 3000 })] })
await app.start()
```

and a test:

```ts
import { metadata } from '../src/.znight/container.generated.js'

await using app = await TestApp.create({ metadata, plugins: [HttpPlugin.configure({ port: 0 })] })
const { instance, mocks } = await TestBed.create(UserService, { metadata })
```

## 2. The generated module

The metadata object is unchanged (`version: 1`). Only the tail of the module changes:

```ts
import type { CreateApplicationOptions, ZnightMetadata } from '@znight/core'
import { Application } from '@znight/core'

/** Compiled dependency graph of this application (Application.create, TestApp.create, TestBed.create). */
export const metadata: ZnightMetadata = { version: 1 /* unchanged */ }

/** Creates this application: `Application.create({ ...options, metadata })`. */
export function createApplication(options: CreateApplicationOptions = {}): Promise<Application> {
  return Application.create({ ...options, metadata })
}

/** @deprecated Import `metadata` (or call `createApplication()`). Removed in 0.10. */
export const __ZNIGHT_METADATA__: ZnightMetadata = metadata
export default metadata
```

- `metadata`, `createApplication`, `__ZNIGHT_METADATA__` and `d` are reserved in the name pool: an
  imported binding with one of these names is aliased (`metadata$1`). `Application` and the two
  types are imports like any other: a user class named `Application` is imported as
  `Application$1`, deterministically (names follow canonical identities).
- `CreateApplicationOptions` is `Omit<ApplicationOptions, 'metadata'>`, exported by `@znight/core`:
  it follows `ApplicationOptions` without a second surface to maintain.
- The error module (watch and serve modes, failed compilation) exports the same four names; each
  throws the `ZnightError` carrying the diagnostics when the module is imported.
- The generated module already depends on `@znight/core` (the `ZnightMetadata` type, the error
  module's `ZnightError`): the `Application` value import needs no new dependency nor a new check.
- Unused exports cost nothing: Vite/Rolldown tree-shake the alias and whichever of `metadata` and
  `createApplication` the entry does not use.

`Application.create({ metadata, plugins })` stays supported and documented as the explicit form
(tools, benchmarks, hand-written metadata). Tests keep passing `{ metadata }`: a generated
`createTestApp()` would import `@znight/testing`, a devDependency, from a module that ships to
production.

## 3. Migration

- **0.9** (minor for compiler, core and cli): the new exports, the deprecated alias and the
  default export. Nothing breaks; editors strike `__ZNIGHT_METADATA__` through.
- The release notes give the one-liner (no codemod command):
  `sed -i '' -e 's/__ZNIGHT_METADATA__ as metadata/metadata/; s/import { __ZNIGHT_METADATA__ }/import { metadata }/; s/metadata: __ZNIGHT_METADATA__/metadata/' src/main.ts test/**/*.ts`,
  then optionally switch `main.ts` to `createApplication`. A destructuring default
  `metadata = __ZNIGHT_METADATA__` becomes `metadata = generatedMetadata` with
  `import { metadata as generatedMetadata }` (typecheck reports the self-reference otherwise).
- **0.10** (minor, breaking before 1.0): the alias is removed from the code generator, the error
  module and the specification. An unmigrated import fails at typecheck (TS2305) and at link time.
- `docs/test` fails when a page or README outside `rfcs/` and the changelogs names
  `__ZNIGHT_METADATA__`, except the deprecation note.

## 4. Related changes

- `znight openapi` reads `module.metadata ?? module.default` from the generated module.
- The ZNIGHT020 message hints at editor auto-imports: `metadata` and `createApplication` are short
  names an editor may import into a provider module.
- The CLI scaffold and the examples that repeated the wiring of `main.ts` in their tests
  (`rest-api`, `storefront-api`) export it from `src/app.ts`, used by `main.ts` and by the tests.

## 5. Alternatives considered

- **Only rename the export (`metadata`).** Shorter, but `main.ts` still spells the plumbing
  (`Application.create({ metadata, ... })`). `createApplication` costs one stack frame at boot,
  stays steppable (Ctrl+click lands in the readable generated module) and is the clearest picture of
  "no modules": NestJS needs `NestFactory.create(AppModule)` with a hand-written module, Znight needs
  `createApplication()` because the compiler writes the module.
- **A registry filled by the generated module (`Application.create({ plugins })` with no
  metadata).** Rejected: process-wide mutable state in core, a side effect on import, `main.ts` no
  longer says where the container comes from, several containers in one process (the repository's
  own test run) become ambiguous, and `bun src/main.ts` after `znight generate` (documented) breaks
  until a side-effect import is added. It would also need entry transforms in Vite and Bun and a new
  error code.
- **`Application.create(metadata, options)` overload.** A second signature for the explicit form,
  for no gain once `createApplication` exists.
- **Typed tokens for interface mocks (`mocks.get(tokens.UserRepository)`).** A generated tokens
  object invites provider modules to import the generated module (ZNIGHT020). It needs its own RFC.

## 6. Out of scope

Typed interface mock lookups, a codemod command, and any change to the metadata shape.
