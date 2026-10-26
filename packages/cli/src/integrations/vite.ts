/**
 * Vite, loaded lazily from the project (it is a peer dependency). `znight build` and `znight dev` run
 * `vite build` programmatically: the `znight()` plugin of the project's `vite.config.ts` compiles the
 * container and, with its `app` defaults, configures a server build (`src/main.ts` → `dist/`).
 *
 * The Vite root is resolved like the Vite CLI run in the project directory: the `root` of the config
 * file, relative to the project root (`--root`), else the project root ({@link projectRootPlugin}).
 */
import type { InlineConfig, Plugin } from 'vite'
import type { Diagnostic, StringAliasLike, ZnightOptions } from './compiler.ts'

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { CliError } from '../errors.ts'
import { importFromProject } from './resolve.ts'

/** Vite log levels. */
export type ViteLogLevel = 'info' | 'warn' | 'error' | 'silent'

/** How Vite loads its config file (`--configLoader` of the Vite CLI). */
export type ViteConfigLoader = 'bundle' | 'runner' | 'native'

/** What the CLI reads from a config resolved by Vite (`ResolvedConfig`). */
export interface ResolvedConfigLike {
  /** Absolute root. */
  readonly root: string
  /** The config file that was loaded. */
  readonly configFile?: string | undefined
  /** Every plugin, flattened. */
  readonly plugins: readonly unknown[]
  readonly resolve?: { readonly alias?: unknown } | undefined
}

/** Subset of the `vite` module used by the CLI. */
export interface ViteApi {
  build(config: InlineConfig): Promise<unknown>
  /** Resolves the config as a build would, without building (absent: `znight generate` uses defaults). */
  resolveConfig?: (
    config: InlineConfig,
    command: 'build' | 'serve',
    defaultMode?: string,
    defaultNodeEnv?: string,
  ) => Promise<ResolvedConfigLike>
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

/** Creates an {@link OutputTracker}; relative output paths are resolved against the Vite root. */
export function createOutputTracker(root: string): OutputTracker {
  let entry: string | undefined
  let started: number | undefined
  let api: ZnightPluginApiLike | undefined
  let compile: CompileOutcome | undefined
  let viteRoot = root
  const plugin: Plugin = {
    name: 'znight:cli-output',
    configResolved(config) {
      api = findZnightApi(config.plugins)
      if (typeof config.root === 'string') viteRoot = config.root
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
          ? resolve(viteRoot, outputOptions.dir ?? 'dist', chunk.fileName)
          : resolve(viteRoot, outputOptions.file)
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

/** Name of {@link projectRootPlugin}. */
const ROOT_PLUGIN = 'znight:cli-root'

/**
 * Resolves the Vite root like the Vite CLI run in the project directory: the `root` of the config
 * file against `projectRoot`, or `projectRoot` without one. An inline `root` would override the
 * config file's, so the CLI sets it from the first `config` hook instead.
 */
export function projectRootPlugin(projectRoot: string): Plugin {
  return {
    name: ROOT_PLUGIN,
    config: {
      order: 'pre',
      handler: config => ({ root: resolve(projectRoot, config.root ?? '.') }),
    },
  }
}

function inlineConfig(options: BuildOptions, watch: boolean): InlineConfig {
  return {
    // found in the project root (not the working directory); no config file: none is searched
    configFile: findViteConfig(options.root, options.configFile) ?? false,
    mode: options.mode,
    logLevel: options.logLevel,
    ...(options.configLoader === undefined ? {} : { configLoader: options.configLoader }),
    clearScreen: false,
    plugins: [projectRootPlugin(options.root), ...(options.plugins ?? [])],
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

/** Vite's `DEFAULT_CONFIG_FILES`, in its order. */
const CONFIG_FILES = [
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.ts',
  'vite.config.cjs',
  'vite.config.mts',
  'vite.config.cts',
]

/** The Vite config file of the project (the one Vite would load from `root`), if any. */
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
  /**
   * The options the `znight()` plugin compiles with: those given to it (`plugin.api.options`) with
   * the absolute `root` (resolved against the Vite root) and, as derived from the Vite config, the
   * string `aliases` of `resolve.alias` and the `runtimeConditions` (when the plugin exposes its
   * compiler).
   */
  readonly options?: ZnightOptions | undefined
}

/**
 * Resolves the project's Vite config as `znight build` does and reads the options the `znight()`
 * plugin compiles with, so that `znight generate` compiles exactly like the Vite build. Returns
 * `undefined` without a config file. `process.env.NODE_ENV`, which Vite sets, is left untouched.
 */
export async function readZnightPluginOptions(
  vite: ViteApi,
  root: string,
  configFile?: string,
  configLoader?: ViteConfigLoader,
): Promise<ZnightPluginLookup | undefined> {
  const file = findViteConfig(root, configFile)
  const resolveConfig = vite.resolveConfig
  if (file === undefined || resolveConfig === undefined) return undefined
  const inline: InlineConfig = {
    configFile: file,
    mode: 'production',
    logLevel: 'silent',
    ...(configLoader === undefined ? {} : { configLoader }),
    plugins: [projectRootPlugin(root)],
  }
  const config = await preservingNodeEnv(() => resolveConfig.call(vite, inline, 'build', 'production', 'production'))
  const loaded = config.configFile ?? file
  for (const plugin of config.plugins) {
    if (typeof plugin !== 'object' || plugin === null) continue
    const name = (plugin as { name?: unknown }).name
    if (typeof name !== 'string' || !isZnightPluginName(name)) continue
    return { configFile: loaded, found: true, options: compileOptionsOf(plugin, config) }
  }
  return { configFile: loaded, found: false }
}

/** `znight` and its sub-plugins (`znight:*`), not the CLI's own plugins. */
function isZnightPluginName(name: string): boolean {
  return name === 'znight' || (name.startsWith('znight:') && !name.startsWith('znight:cli-'))
}

async function preservingNodeEnv<T>(run: () => Promise<T>): Promise<T> {
  const nodeEnv = process.env['NODE_ENV']
  try {
    return await run()
  } finally {
    if (nodeEnv === undefined) delete process.env['NODE_ENV']
    else process.env['NODE_ENV'] = nodeEnv
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** {@link ZnightPluginLookup.options}: the compiler's resolved options when exposed, else derived. */
function compileOptionsOf(plugin: object, config: ResolvedConfigLike): ZnightOptions {
  const api = (plugin as { api?: unknown }).api
  let options: ZnightOptions = {}
  let resolved: Record<string, unknown> | undefined
  if (isObject(api)) {
    const value: unknown = typeof api['getOptions'] === 'function' ? api['getOptions'].call(api) : api['options']
    if (isObject(value)) options = value as ZnightOptions
    const compiler = api['compiler']
    if (isObject(compiler) && isObject(compiler['options'])) resolved = compiler['options']
  }
  const root = typeof resolved?.['root'] === 'string' ? resolved['root'] : resolve(config.root, options.root ?? '.')
  const aliases = Array.isArray(resolved?.['aliases'])
    ? (resolved['aliases'] as StringAliasLike[])
    : stringAliases(config.resolve?.alias)
  const conditions = resolved?.['runtimeConditions']
  return {
    ...options,
    root,
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(Array.isArray(conditions) ? { runtimeConditions: conditions as string[] } : {}),
  }
}

/** The string entries of Vite's (resolved) `resolve.alias`: the compiler ignores RegExp aliases. */
function stringAliases(alias: unknown): StringAliasLike[] {
  if (!Array.isArray(alias)) return []
  return alias.filter(
    (entry): entry is StringAliasLike =>
      isObject(entry) && typeof entry['find'] === 'string' && typeof entry['replacement'] === 'string',
  )
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
