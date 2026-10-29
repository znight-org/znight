/**
 * `@znight/openapi/vite`: the `openapi()` Vite plugin. After `vite build` / `znight build` wrote the
 * bundle (and after each good rebuild of `znight dev`), it emits the OpenAPI document with
 * `emitOpenApi()`; with `check`, a missing or stale committed output fails the build.
 *
 * ```ts
 * export default defineConfig({
 *   plugins: [znight(options), openapi({ output: ['openapi.json', 'dist/openapi.json'], check: process.env['CI'] === 'true' })],
 * })
 * ```
 */
import type { Plugin, ResolvedConfig } from 'vite'
import type { EmitRuntime } from './emit/index.ts'

import { isAbsolute, join, relative, resolve } from 'node:path'

/** Name of the plugin (an application uses one instance: the first one wins). */
export const OPENAPI_PLUGIN_NAME = 'znight:openapi'

/** Options of {@link openapi}. */
export interface OpenApiVitePluginOptions {
  /** Output files, relative to the Vite root (`.yaml` / `.yml` write YAML). Default: `<build.outDir>/openapi.json`. */
  readonly output?: string | readonly string[]
  /**
   * CI: never write the outputs outside `build.outDir` (the committed files), fail the build when one
   * is missing or stale. The outputs inside `build.outDir` are build artifacts, written by every
   * build. Default `false`.
   */
  readonly check?: boolean
  /** HTTP prefix (`servers` default when `@OpenApiDocument` declares none). */
  readonly prefix?: string
  /** Runtime loading the application modules. Default `'auto'`. */
  readonly runtime?: EmitRuntime
  /** Module whose default export is a `SchemaConverter[]`, relative to the Vite root. */
  readonly converters?: string
}

interface ZnightApiLike {
  readonly options?: unknown
  readonly result?: { readonly ok?: unknown }
  readonly compiler?: { readonly options?: { readonly root?: unknown } }
}

/** The `openapi()` Vite plugin (build only). */
export function openapi(options: OpenApiVitePluginOptions = {}): Plugin {
  let config: ResolvedConfig | undefined
  let active = true
  let emitted = false
  const plugin: Plugin = {
    name: OPENAPI_PLUGIN_NAME,
    apply: 'build',
    configResolved(resolved) {
      config = resolved
      // the config file wins over a copy added by the CLI (znight build --openapi)
      active = resolved.plugins.find(candidate => candidate.name === OPENAPI_PLUGIN_NAME) === plugin
    },
    buildStart() {
      emitted = false
    },
    async writeBundle() {
      if (!active || emitted || config === undefined) return
      emitted = true
      const znight = config.plugins.find(candidate => candidate.name === 'znight') as
        | { api?: ZnightApiLike }
        | undefined
      const api = znight?.api
      // watch mode: the bundle of a failed compile throws the diagnostics; keep the last document
      if (api?.result !== undefined && api.result.ok === false) return
      const root = config.root
      const outputs =
        options.output === undefined
          ? [join(resolve(root, config.build.outDir), 'openapi.json')]
          : (typeof options.output === 'string' ? [options.output] : options.output).map(file => resolve(root, file))
      const outDir = resolve(root, config.build.outDir)
      const checked = options.check === true ? outputs.filter(file => !isInside(outDir, file)) : []
      if (options.check === true && checked.length === 0) {
        this.warn(
          '[znight:openapi] check: every output is in build.outDir, written by each build: nothing is checked (add the committed file to output)',
        )
      }
      const compilerRoot = api?.compiler?.options?.root
      const given =
        typeof api?.options === 'object' && api.options !== null ? (api.options as Record<string, unknown>) : undefined
      const { emitOpenApi } = await import('./emit/index.ts')
      const result = await emitOpenApi({
        root,
        output: outputs,
        ...(checked.length === 0 ? {} : { check: checked }),
        ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
        ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
        ...(options.converters === undefined ? {} : { converters: options.converters }),
        ...(config.configFile === undefined ? {} : { config: config.configFile }),
        ...(given === undefined
          ? {}
          : {
              compilerOptions: {
                ...given,
                root: typeof compilerRoot === 'string' ? compilerRoot : resolve(root, String(given['root'] ?? '.')),
              },
            }),
      })
      const show = (file: string): string => {
        const path = relative(root, file)
        return path === '' || path.startsWith('..') || isAbsolute(path) ? file : path
      }
      if (!result.ok) {
        this.error(
          `[znight:openapi] the application does not compile: ${result.diagnostics.filter(d => d.severity === 'error').length} error(s)`,
        )
      }
      for (const warning of result.warnings) this.warn(`${warning.code}: ${warning.message}`)
      if (result.stale) {
        this.error(
          `[znight:openapi] ${result.staleFiles.map(show).join(', ')} ${result.staleFiles.length > 1 ? 'are' : 'is'} missing or out of date: run "znight openapi"`,
        )
      }
      for (const file of result.written) config.logger.info(`[znight:openapi] wrote ${show(file)}`)
    },
  }
  return plugin
}

function isInside(directory: string, file: string): boolean {
  const path = relative(directory, file)
  return path !== '' && !path.startsWith('..') && !isAbsolute(path)
}
