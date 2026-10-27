/**
 * `@znight/openapi`, loaded lazily from the project (an optional peer dependency): `znight openapi`
 * uses its emission API (`@znight/openapi/emit`), `znight build --openapi` its Vite plugin
 * (`@znight/openapi/vite`). Commands use the structural types below, so tests can inject fakes.
 */
import type { Plugin } from 'vite'
import type { Diagnostic, ZnightOptions } from './compiler.ts'

import { CliError } from '../errors.ts'
import { importFromProject } from './resolve.ts'

/** Options of `emitOpenApi()` (`@znight/openapi/emit`). */
export interface OpenApiEmitOptionsLike {
  readonly root: string
  readonly output: readonly string[]
  readonly check?: boolean
  readonly prefix?: string
  readonly runtime?: 'auto' | 'node' | 'bun'
  readonly converters?: string
  readonly config?: string
  readonly configLoader?: string
  readonly compilerOptions?: ZnightOptions
}

/** A warning of the assembly. */
export interface OpenApiWarningLike {
  readonly code: string
  readonly message: string
}

/** What the CLI reads from the result of `emitOpenApi()`. */
export interface OpenApiEmitResultLike {
  readonly ok: boolean
  readonly written: readonly string[]
  readonly stale: boolean
  readonly staleFiles: readonly string[]
  readonly diagnostics: readonly Diagnostic[]
  readonly warnings: readonly OpenApiWarningLike[]
  readonly outputs: readonly string[]
  readonly runtime: 'node' | 'bun'
  readonly document?: { readonly paths?: Readonly<Record<string, object>> } | undefined
}

/** `@znight/openapi/emit`. */
export interface OpenApiEmitApi {
  emitOpenApi(options: OpenApiEmitOptionsLike): Promise<OpenApiEmitResultLike>
}

/** Options of the `openapi()` Vite plugin. */
export interface OpenApiVitePluginOptionsLike {
  readonly output?: string
  /** HTTP prefix (`servers` default when `@OpenApiDocument` declares none). */
  readonly prefix?: string
}

/** `@znight/openapi/vite`. */
export interface OpenApiViteApi {
  openapi(options?: OpenApiVitePluginOptionsLike): Plugin
}

/** Not literals in `import()`: the CLI builds without `@znight/openapi` (an optional peer). */
const EMIT_MODULE: string = '@znight/openapi/emit'
const VITE_MODULE: string = '@znight/openapi/vite'

const MISSING_HINTS = ['install it in your project: npm install @znight/openapi']

/** Loads `@znight/openapi/emit` as installed in the project. */
export async function loadOpenApiEmit(root: string): Promise<OpenApiEmitApi> {
  let module: Partial<OpenApiEmitApi>
  try {
    module = (await importFromProject(EMIT_MODULE, root, () => import(EMIT_MODULE))) as Partial<OpenApiEmitApi>
  } catch (error) {
    throw new CliError('Cannot load @znight/openapi', { cause: error, hints: MISSING_HINTS })
  }
  if (typeof module.emitOpenApi !== 'function') {
    throw new CliError('This version of @znight/openapi has no emitOpenApi()', {
      hints: ['upgrade @znight/openapi to the version of @znight/cli'],
    })
  }
  return module as OpenApiEmitApi
}

/** Loads `@znight/openapi/vite` as installed in the project. */
export async function loadOpenApiVite(root: string): Promise<OpenApiViteApi> {
  let module: Partial<OpenApiViteApi>
  try {
    module = (await importFromProject(VITE_MODULE, root, () => import(VITE_MODULE))) as Partial<OpenApiViteApi>
  } catch (error) {
    throw new CliError('Cannot load @znight/openapi', { cause: error, hints: MISSING_HINTS })
  }
  if (typeof module.openapi !== 'function') {
    throw new CliError('This version of @znight/openapi has no openapi() Vite plugin', {
      hints: ['upgrade @znight/openapi to the version of @znight/cli'],
    })
  }
  return module as OpenApiViteApi
}
