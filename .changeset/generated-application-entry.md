---
"@znight/compiler": minor
"@znight/core": minor
---

The generated module exports `metadata` (the compiled graph) and `createApplication(options)`, which is `Application.create({ ...options, metadata })`: `main.ts` becomes `const app = await createApplication({ plugins: [...] })` and tests pass `{ metadata }` (RFC 0015). `@znight/core` exports the `CreateApplicationOptions` type (`ApplicationOptions` without `metadata`). `__ZNIGHT_METADATA__` stays as a deprecated alias of `metadata` (and the default export as well) and is removed in 0.10; the error module exports the same names, and the ZNIGHT020 diagnostic hints at editor auto-imports of `metadata` and `createApplication`. To migrate: `sed -i '' -e 's/__ZNIGHT_METADATA__ as metadata/metadata/; s/import { __ZNIGHT_METADATA__ }/import { metadata }/; s/metadata: __ZNIGHT_METADATA__/metadata/' src/main.ts test/**/*.ts`, then optionally switch `main.ts` to `createApplication`.
