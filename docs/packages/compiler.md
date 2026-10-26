---
description: "@znight/compiler - the Vite plugin, CLI and Bun integration that analyses your code at build time and generates the dependency injection container."
---

# @znight/compiler <Badge type="tip" text="available" />

The compiler analyses your sources at build time and generates `__ZNIGHT_METADATA__`: providers,
dependencies, scopes, resolution order, routes, consumers and config classes. It is a build-time
dependency only.

```sh
npm install -D @znight/compiler vite   # vite: for the Vite plugin (optional peer dependency)
```

Runs on Node.js 24+ and Bun 1.3+.

## Entry points

| Import                 | Description                                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@znight/compiler`     | `znight()` Vite plugin (also the default export), `compile()`, `generate()`, `createCompiler()`, `formatDiagnostics()`, the Bun API (`createPreload()`, `znightBunPlugin()`, `loadZnightConfig()`) and the extension API |
| `@znight/compiler/bun` | The Bun preload (importing it runs it): regenerates the container before `bun test` and `bun --watch`, serves it from memory                                                                                             |

::: code-group

```ts [znight.config.ts]
import type { ZnightOptions } from '@znight/compiler'

// read by the Bun preload and `znight generate`, passed to the Vite plugin
export default { strictValidation: true } satisfies ZnightOptions
```

```ts [vite.config.ts]
import { znight } from '@znight/compiler'
import { defineConfig } from 'vite'

import options from './znight.config.ts'

export default defineConfig({ plugins: [znight(options)] })
```

```toml [bunfig.toml]
[test]
preload = ["@znight/compiler/bun"]
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
- **Extensible**: feature packages contribute compiler extensions through their manifest, loaded
  for the packages you import and for those declaring the decorators you apply (also through a
  preset package re-exporting them).

## Options

See the [options table](/guide/compiler#options) in the compiler guide.

## Programmatic API

```ts
import { compile, formatDiagnostics, generate } from '@znight/compiler'

const { ok, diagnostics, stats } = await compile({ root: process.cwd() })
if (diagnostics.length > 0) console.error(formatDiagnostics(diagnostics, { color: true }))

const { stale } = await generate({ check: true }) // CI: never writes, `stale` when the file on disk is out of date
```

```ts
interface CompileResult {
  code: string // the generated module, or the error module when !ok
  diskCode: string // the copy written to outFile: the `serve` rendering in every mode
  outFile: string // absolute
  diagnostics: Diagnostic[] // syntax errors (ZNIGHT022) first, then by file and offset
  ok: boolean // no error diagnostic
  graph: ApplicationGraph
  stats: { files: number; providers: number; durationMs: number; parsed: number }
  library: LibraryOutput | undefined // library mode: dist/znight.providers.json
  watchFiles: string[] // sources, other files read outside node_modules, manifests, libraries
  decorators: ReadonlyMap<string, DecoratorRanges> // decorator ranges stripped by the Vite plugin / Bun preload
}

interface Diagnostic {
  code: ErrorCode // 'ZNIGHT001'...
  severity: 'error' | 'warning'
  message: string
  location?: {
    file: string
    line: number
    column: number
    endLine: number
    endColumn: number
    start: number
    end: number
  }
  hints?: string[]
  related?: { message: string; location: Location }[]
}
```

`generate()` writes `diskCode` (never with errors) and returns the same plus `written` (the files
whose content changed), `stale` and `staleFiles` (check mode: which files are missing or out of
date). The disk copy is the same in every mode, so a `vite build`, the Bun preload and `znight
generate --check` agree on it; the Vite plugin and the Bun preload serve the module from memory and
only warn when they cannot write it (read-only image). `createCompiler(options)` keeps the parse
cache between compiles for watchers (`compile(changes)` / `generate(changes)` with `{ changed,
added, removed }`).

## Learn more

- [The compiler guide](/guide/compiler): pipeline, options and `znight.config.ts`, generated module,
  Vite plugin, Git/CI, Bun preload.
- [Package README](https://github.com/znight-org/znight/tree/main/packages/compiler#readme): every
  option, diagnostic and API in detail.
- [Architecture specification](/contributing/architecture): identities, import routes, binding
  algorithm, extension API.
