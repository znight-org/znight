---
"@znight/cli": minor
---

`znight new` scaffolds `src/main.ts` with the generated `createApplication()` and a `src/app.ts` exporting `plugins(options)`, the plugin list shared by `main.ts` and the `TestApp` tests (which pass `{ port: 0, logLevel: 'silent' }`), so that the tests run the production wiring; the tests import `{ metadata }` from the generated module (RFC 0015). The generator hints point at `src/app.ts`.
