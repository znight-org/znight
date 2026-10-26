---
description: "@znight/compiler - the Vite plugin, CLI and Bun integration that analyses your code at build time and generates the dependency injection container."
---

# @znight/compiler <Badge type="warning" text="in development" />

The compiler analyses your sources at build time and generates `__ZNIGHT_METADATA__`: providers,
dependencies, scopes, resolution order, routes, consumers and config classes. It is a build-time
dependency only.

```sh
npm install -D @znight/compiler vite
```

<!-- TODO(api): verify against implementation (the project model is implemented; analysis, binding, codegen, Vite plugin and Bun preload are in progress) -->

## Entry points

| Import                 | Description                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `@znight/compiler`     | `znight()` Vite plugin (default export), `compile()`, `generate()`, `formatDiagnostics()` |
| `@znight/compiler/bun` | Bun plugin / preload regenerating the container before tests and `bun --watch`            |

::: code-group

```ts [vite.config.ts]
import { znight } from '@znight/compiler'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [znight({ strictValidation: true })],
})
```

:::

## Features

- **Native speed**: parsing and module resolution with [oxc](https://oxc.rs); per-file caches keyed by
  content hash; serialised, debounced incremental compiles in watch mode.
- **Real TypeScript semantics**: renamed imports, barrels, `export *`, namespace imports, tsconfig
  `paths`, Vite aliases, package `exports` and conditions, generics with substituted type arguments,
  inherited constructors.
- **Static evaluation** of decorator arguments: literals, `const` references across files and
  packages, template literals, arithmetic, `as const`, spreads...
- **Validation**: every [`ZNIGHT` diagnostic](/reference/error-codes) has a location, a code frame and
  hints, including near-miss analysis for missing providers.
- **Deterministic output**: byte-identical for full and incremental builds, on every OS.
- **Decorator stripping** with high-resolution source maps.
- **Provider libraries**, from source or precompiled (`dist/znight.providers.json`).
- **Extensible**: feature packages contribute compiler extensions through their manifest.

## Options

See the [options table](/guide/compiler#options) in the compiler guide.

## Programmatic API

```ts
import { compile, formatDiagnostics, generate } from '@znight/compiler'

const { diagnostics, stats } = await compile({ root: process.cwd() })
if (diagnostics.length > 0) console.error(formatDiagnostics(diagnostics, { color: true }))

await generate({ check: true }) // CI: fails when the file on disk is stale
```

```ts
interface CompileResult {
  code: string
  outFile: string
  diagnostics: Diagnostic[]
  graph: ApplicationGraph
  stats: { files: number; providers: number; durationMs: number }
}

interface Diagnostic {
  code: ErrorCode // 'ZNIGHT001'...
  severity: 'error' | 'warning'
  message: string
  location?: { file: string; line: number; column: number }
  hints?: string[]
  related?: { message: string; location: { file: string; line: number; column: number } }[]
}
```

## Learn more

- [The compiler guide](/guide/compiler): pipeline, generated module, Vite plugin, Git/CI, Bun preload.
- [Architecture specification](/contributing/architecture): identities, import routes, binding
  algorithm, extension API.
