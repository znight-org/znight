/**
 * Vite, loaded lazily from the project (it is a peer dependency). `znight build` and `znight dev` run
 * `vite build` programmatically: the `znight()` plugin of the project's `vite.config.ts` compiles the
 * container and, with its `app` defaults, configures a server build (`src/main.ts` → `dist/`).
 */
import type { InlineConfig, Plugin } from 'vite'
import type { Diagnostic, ZnightOptions } from './compiler.ts'

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { CliError } from '../errors.ts'
import { importFromProject } from './resolve.ts'

/** Vite log levels. */
export type ViteLogLevel = 'info' | 'warn' | 'error' | 'silent'

/** How Vite loads its config file (`--configLoader` of the Vite CLI). */
export type ViteConfigLoader = 'bundle' | 'runner' | 'native'

/** Subset of the `vite` module used by the CLI. */
export interface ViteApi {
  build(config: InlineConfig): Promise<unknown>
  loadConfigFromFile?: (
    env: { command: 'build' | 'serve'; mode: string; isSsrBuild?: boolean },
    configFile?: string,
    root?: string,
    logLevel?: ViteLogLevel,
    customLogger?: undefined,
    configLoader?: ViteConfigLoader,
  ) => Promise<{ path: string; config: { plugins?: unknown } } | null>
}

/** Events of a Vite build in watch mode (Rolldown/Rollup watcher events). */
export type WatcherEvent =
  | { readonly code: 'START' }
  | { readonly code: 'BUNDLE_START' }
  | { readonly code: 'BUNDLE_END'; readonly duration?: number; readonly result?: ClosableBuild }
  | { readonly code: 'END' }
  | { readonly code: 'ERROR'; readonly error: unknown; readonly result?: ClosableBuild }

interface ClosableBuild {
  close(): unknown
}

/** The watcher returned by `vite.build({ build: { watch } })`. */
export interface BuildWatcher {
  on(event: 'event', listener: (event: WatcherEvent) => void): unknown
  close(): Promise<void>
}

/** Loads `vite` as installed in the project. */
export async function loadVite(root: string): Promise<ViteApi> {
  try {
    return (await importFromProject('vite', root, () => import('vite'))) as ViteApi
  } catch (error) {
    throw new CliError('Cannot load vite', {
      cause: error,
      hints: ['install it in your project: npm install -D vite @znight/compiler'],
    })
  }
}

/** Options shared by {@link runBuild} and {@link watchBuild}. */
export interface BuildOptions {
  readonly root: string
  /** Vite config file; default: auto-detected `vite.config.*`. */
  readonly configFile?: string | undefined
  readonly mode: string
  readonly logLevel: ViteLogLevel
  /** How the config file is loaded (default: Vite's, `bundle`). */
  readonly configLoader?: ViteConfigLoader | undefined
  /** Plugins added to the config file's ones. */
  readonly plugins?: readonly Plugin[]
}

/** The outcome of the compile of the `znight()` plugin (`plugin.api.result`, @znight/compiler). */
export interface CompileOutcome {
  /** No error diagnostic. */
  readonly ok: boolean
  readonly diagnostics: readonly Diagnostic[]
}

/** What the CLI reads from the `plugin.api` of `znight()` (structural: any compiler version). */
interface ZnightPluginApiLike {
  /** The latest compile result. */
  readonly result?: unknown
}

/**
 * Captures what a build produced: the entry chunk written (the file `znight dev` runs) and the
 * compile result of the `znight()` plugin. In watch mode the plugin does not fail the build on
 * compile errors (the bundle contains a module throwing them): `znight dev` reads the result to keep
 * the last good process running.
 */
export interface OutputTracker {
  readonly plugin: Plugin
  /** Absolute path of the entry chunk written by the last build. */
  entry(): string | undefined
  /** `performance.now()` when the last build started (`undefined` before the first one). */
  startedAt(): number | undefined
  /**
   * The compile result the last written build was made of (`plugin.api.result` of `znight()`),
   * `undefined` when the Vite config has no `znight()` plugin exposing it.
   */
  compile(): CompileOutcome | undefined
}

/** Creates an {@link OutputTracker}. */
export function createOutputTracker(root: string): OutputTracker {
  let entry: string | undefined
  let started: number | undefined
  let api: ZnightPluginApiLike | undefined
  let compile: CompileOutcome | undefined
  const plugin: Plugin = {
    name: 'znight:cli-output',
    configResolved(config) {
      api = findZnightApi(config.plugins)
    },
    buildStart() {
      started = performance.now()
      compile = undefined
    },
    writeBundle(outputOptions, bundle) {
      // the plugin compiled in its buildStart: its latest result is the one this bundle contains
      compile = compileOutcome(api?.result)
      const chunks = Object.values(bundle).filter(
        (output): output is Extract<(typeof bundle)[string], { type: 'chunk' }> =>
          output.type === 'chunk' && output.isEntry,
      )
      const chunk = chunks.find(candidate => candidate.name === 'main') ?? chunks[0]
      if (chunk === undefined) return
      entry =
        outputOptions.file === undefined
          ? resolve(root, outputOptions.dir ?? 'dist', chunk.fileName)
          : resolve(root, outputOptions.file)
    },
  }
  return { plugin, entry: () => entry, startedAt: () => started, compile: () => compile }
}

/** The `plugin.api` of the `znight()` plugin among the resolved plugins. */
function findZnightApi(plugins: readonly unknown[]): ZnightPluginApiLike | undefined {
  for (const plugin of plugins) {
    if (typeof plugin !== 'object' || plugin === null || (plugin as { name?: unknown }).name !== 'znight') continue
    const api = (plugin as { api?: unknown }).api
    if (typeof api === 'object' && api !== null && 'result' in api) return api as ZnightPluginApiLike
  }
  return undefined
}

function compileOutcome(result: unknown): CompileOutcome | undefined {
  if (typeof result !== 'object' || result === null) return undefined
  const { ok, diagnostics } = result as { ok?: unknown; diagnostics?: unknown }
  if (typeof ok !== 'boolean') return undefined
  return { ok, diagnostics: Array.isArray(diagnostics) ? (diagnostics as Diagnostic[]) : [] }
}

function inlineConfig(options: BuildOptions, watch: boolean): InlineConfig {
  return {
    root: options.root,
    configFile: options.configFile === undefined ? undefined : resolve(options.root, options.configFile),
    mode: options.mode,
    logLevel: options.logLevel,
    ...(options.configLoader === undefined ? {} : { configLoader: options.configLoader }),
    clearScreen: false,
    plugins: [...(options.plugins ?? [])],
    build: watch ? { watch: {} } : {},
  }
}

/** Runs `vite build` once. Throws the build error. */
export async function runBuild(vite: ViteApi, options: BuildOptions): Promise<void> {
  const result = await vite.build(inlineConfig(options, false))
  if (isWatcher(result)) await result.close()
}

/** Starts `vite build --watch`. */
export async function watchBuild(vite: ViteApi, options: BuildOptions): Promise<BuildWatcher> {
  const result = await vite.build(inlineConfig(options, true))
  if (!isWatcher(result)) {
    throw new CliError('vite build did not start in watch mode', {
      hints: ['check that your Vite config does not override "build.watch"'],
    })
  }
  return result
}

function isWatcher(value: unknown): value is BuildWatcher {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Partial<BuildWatcher>).on === 'function' &&
    typeof (value as Partial<BuildWatcher>).close === 'function'
  )
}

const CONFIG_FILES = [
  'vite.config.ts',
  'vite.config.mts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.cts',
  'vite.config.cjs',
]

/** The Vite config file of the project, if any. */
export function findViteConfig(root: string, configFile?: string): string | undefined {
  if (configFile !== undefined) return resolve(root, configFile)
  return CONFIG_FILES.map(file => join(root, file)).find(file => existsSync(file))
}

/** Result of {@link readZnightPluginOptions}. */
export interface ZnightPluginLookup {
  /** The Vite config file that was loaded. */
  readonly configFile: string
  /** Whether the config registers the `znight()` plugin. */
  readonly found: boolean
  /** The options passed to `znight()`, when the plugin exposes them (`plugin.api.options`). */
  readonly options?: ZnightOptions | undefined
}

/**
 * Loads the project's Vite config and reads the options given to `znight()`, so that
 * `znight generate` compiles exactly like the Vite build. Returns `undefined` without a config file.
 */
export async function readZnightPluginOptions(
  vite: ViteApi,
  root: string,
  configFile?: string,
  configLoader?: ViteConfigLoader,
): Promise<ZnightPluginLookup | undefined> {
  const file = findViteConfig(root, configFile)
  if (file === undefined || vite.loadConfigFromFile === undefined) return undefined
  const loaded = await vite.loadConfigFromFile(
    { command: 'build', mode: 'production', isSsrBuild: true },
    file,
    root,
    'silent',
    undefined,
    configLoader,
  )
  if (loaded === null) return undefined
  for (const plugin of await flattenPlugins(loaded.config.plugins)) {
    const name = (plugin as { name?: unknown }).name
    if (typeof name !== 'string' || (name !== 'znight' && !name.startsWith('znight:'))) continue
    if (name === 'znight:cli-output') continue
    return { configFile: loaded.path, found: true, options: pluginOptions(plugin) }
  }
  return { configFile: loaded.path, found: false }
}

function pluginOptions(plugin: object): ZnightOptions | undefined {
  const api = (plugin as { api?: unknown }).api
  if (typeof api !== 'object' || api === null) return undefined
  const { options, getOptions } = api as { options?: unknown; getOptions?: unknown }
  const value: unknown = typeof getOptions === 'function' ? getOptions.call(api) : options
  return typeof value === 'object' && value !== null ? (value as ZnightOptions) : undefined
}

async function flattenPlugins(value: unknown): Promise<object[]> {
  const resolved: unknown = await value
  if (Array.isArray(resolved)) {
    const nested = await Promise.all(resolved.map(item => flattenPlugins(item)))
    return nested.flat()
  }
  return typeof resolved === 'object' && resolved !== null ? [resolved] : []
}

/** Message of a Vite/Rolldown build error, with its location and code frame when available. */
export function formatBuildError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const details = error as Error & {
    plugin?: string
    id?: string
    loc?: { file?: string; line: number; column: number }
    frame?: string
  }
  const lines = [details.plugin === undefined ? error.message : `[${details.plugin}] ${error.message}`]
  const file = details.loc?.file ?? details.id
  if (file !== undefined && !error.message.includes(file)) {
    lines.push(details.loc === undefined ? `  --> ${file}` : `  --> ${file}:${details.loc.line}:${details.loc.column}`)
  }
  if (details.frame !== undefined && details.frame !== '' && !error.message.includes(details.frame)) {
    lines.push(details.frame)
  }
  return lines.join('\n')
}
