---
"@znight/compiler": minor
"@znight/core": minor
---

Breaking: the `__ZNIGHT_METADATA__` export of the generated module is renamed `metadata` (the compiled graph), with no deprecated alias and no default export, and the module also exports `createApplication(options)`, which is `Application.create({ ...options, metadata })`: `main.ts` becomes `const app = await createApplication({ plugins: [...] })` and tests pass `{ metadata }` (RFC 0015). `@znight/core` exports the `CreateApplicationOptions` type (`ApplicationOptions` without `metadata`). The error module exports the same two names, and the ZNIGHT020 diagnostic hints at editor auto-imports of `metadata` and `createApplication`. To migrate: `sed -i '' -e 's/__ZNIGHT_METADATA__ as metadata/metadata/g; s/metadata: __ZNIGHT_METADATA__/metadata/g; s/__ZNIGHT_METADATA__/metadata/g' src/main.ts test/**/*.ts`, then optionally switch `main.ts` to `createApplication`.
