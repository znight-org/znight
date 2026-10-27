/** Messages between `emitOpenApi()` and its child process (JSON files). */
import type { OpenApiWarning } from '../build.ts'

/** What the child process receives. */
export interface ChildPayload {
  readonly root: string
  readonly runtime: 'node' | 'bun'
  /** Absolute path of the generated module. */
  readonly outFile: string
  /** Vite config file (Node.js), `false` without one. */
  readonly viteConfig: string | false
  readonly configLoader?: string
  /** JSON-compatible compiler options (used when the project has no `znight.config.*`). */
  readonly compilerOptions: Readonly<Record<string, unknown>>
  /** Absolute path of a module whose default export is a `SchemaConverter[]`. */
  readonly converters?: string
  readonly prefix?: string
  /** The workspace runs from sources: resolve `@znight/*` packages with the `@znight/source` condition. */
  readonly sourceConditions?: boolean
  /** Where the child writes its {@link ChildResult}. */
  readonly result: string
}

/** What the child process writes. */
export type ChildResult =
  | {
      readonly ok: true
      readonly json: string
      readonly warnings: readonly OpenApiWarning[]
      readonly stats: { readonly operations: number; readonly schemas: number; readonly durationMs: number }
    }
  | {
      readonly ok: false
      readonly error: { readonly code: string | undefined; readonly message: string; readonly hints: readonly string[] }
    }
