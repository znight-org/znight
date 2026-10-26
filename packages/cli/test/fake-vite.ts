import type { InlineConfig, Plugin, UserConfig } from 'vite'
import type { ResolvedConfigLike, ViteApi, WatcherEvent } from '../src/integrations/vite.ts'

import { join } from 'node:path'

/** A fake build watcher driven by the test. */
export class FakeWatcher {
  readonly listeners: ((event: WatcherEvent) => void)[] = []
  closed = false

  on(_event: 'event', listener: (event: WatcherEvent) => void): this {
    this.listeners.push(listener)
    return this
  }

  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }

  emit(event: WatcherEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

/** The `plugin.api` of a fake `znight()` plugin: the test sets the compile result. */
export interface FakeZnightApi {
  result: { ok: boolean; diagnostics: unknown[] } | undefined
}

/** Options of {@link FakeVite}. */
export interface FakeViteOptions {
  /** Error thrown by the build (one-shot, or when starting the watch mode). */
  readonly fail?: unknown
  /** Plugins of the config file (nested arrays and promises are flattened, like Vite does). */
  readonly configPlugins?: unknown
  /** `root` of the config file (relative: resolved by the CLI against the project root). */
  readonly configRoot?: string
  /** `resolve.alias` of the resolved config. */
  readonly configAlias?: unknown
  /** A `znight()` plugin in the config of the builds, exposing this API (`configResolved`). */
  readonly znight?: FakeZnightApi
}

/** A fake `vite` module recording builds. */
export class FakeVite implements ViteApi {
  readonly builds: InlineConfig[] = []
  readonly watchers: FakeWatcher[] = []
  readonly options: FakeViteOptions
  /** The inline configs given to `resolveConfig`. */
  readonly resolvedConfigs: InlineConfig[] = []
  loadedConfigs = 0

  constructor(options: FakeViteOptions = {}) {
    this.options = options
  }

  /** The root Vite resolves for `config`: the `config` hooks of its plugins applied to the file's root. */
  resolvedRoot(config: InlineConfig): string {
    let current: UserConfig = this.options.configRoot === undefined ? {} : { root: this.options.configRoot }
    for (const plugin of (config.plugins ?? []) as Plugin[]) {
      const hook = plugin.config
      const handler = typeof hook === 'function' ? hook : hook?.handler
      const result = handler?.call({} as never, current, { command: 'build', mode: config.mode ?? 'production' })
      if (typeof result === 'object' && result !== null && !('then' in result)) current = { ...current, ...result }
    }
    return current.root ?? config.root ?? '/'
  }

  build(config: InlineConfig): Promise<unknown> {
    this.builds.push(config)
    this.#configResolved(config)
    if (config.build?.watch && this.options.fail !== undefined) return Promise.reject(this.options.fail)
    if (config.build?.watch) {
      const watcher = new FakeWatcher()
      this.watchers.push(watcher)
      return Promise.resolve(watcher)
    }
    if (this.options.fail !== undefined) return Promise.reject(this.options.fail)
    this.writeBundle(config, 'main.js')
    return Promise.resolve({ output: [] })
  }

  readonly resolveConfig: NonNullable<ViteApi['resolveConfig']> = async config => {
    this.loadedConfigs++
    this.resolvedConfigs.push(config)
    const plugins = [...(await flatten(this.options.configPlugins)), ...((config.plugins ?? []) as object[])]
    return {
      root: this.resolvedRoot(config),
      configFile: typeof config.configFile === 'string' ? config.configFile : undefined,
      plugins,
      resolve: { alias: this.options.configAlias ?? [] },
    } satisfies ResolvedConfigLike
  }

  /** Calls `configResolved` of the plugins given to the build, with the config's `znight()` plugin. */
  #configResolved(config: InlineConfig): void {
    const plugins = (config.plugins ?? []) as Plugin[]
    const resolved = [
      ...(this.options.znight === undefined ? [] : [{ name: 'znight', api: this.options.znight }]),
      ...plugins,
    ]
    const root = this.resolvedRoot(config)
    for (const plugin of plugins) {
      const hook = plugin.configResolved
      const handler = typeof hook === 'function' ? hook : hook?.handler
      handler?.call({} as never, { plugins: resolved, root } as never)
    }
  }

  /** Calls `writeBundle` of the plugins given to the last build, as a successful build does. */
  writeBundle(config: InlineConfig = this.lastBuild(), fileName = 'main.js'): void {
    const root = this.resolvedRoot(config)
    for (const plugin of (config.plugins ?? []) as Plugin[]) {
      const hook = plugin.writeBundle
      const handler = typeof hook === 'function' ? hook : hook?.handler
      handler?.call(
        {} as never,
        { dir: join(root, 'dist') } as never,
        { [fileName]: { type: 'chunk', isEntry: true, name: 'main', fileName } } as never,
      )
    }
  }

  lastBuild(): InlineConfig {
    const config = this.builds.at(-1)
    if (config === undefined) throw new Error('no build')
    return config
  }

  /** Simulates a successful rebuild of the last watcher. */
  succeed(fileName = 'main.js'): void {
    const watcher = this.watchers.at(-1)
    if (watcher === undefined) throw new Error('no watcher')
    watcher.emit({ code: 'START' })
    watcher.emit({ code: 'BUNDLE_START' })
    this.writeBundle(this.lastBuild(), fileName)
    watcher.emit({ code: 'BUNDLE_END', duration: 12 })
    watcher.emit({ code: 'END' })
  }

  /** Simulates a failed rebuild of the last watcher. */
  failBuild(error: unknown): void {
    const watcher = this.watchers.at(-1)
    if (watcher === undefined) throw new Error('no watcher')
    watcher.emit({ code: 'START' })
    watcher.emit({ code: 'BUNDLE_START' })
    watcher.emit({ code: 'ERROR', error })
  }
}

/** Flattens nested arrays and promises of plugins; drops falsy values. */
async function flatten(value: unknown): Promise<object[]> {
  const resolved: unknown = await value
  if (Array.isArray(resolved)) return (await Promise.all(resolved.map(item => flatten(item)))).flat()
  return typeof resolved === 'object' && resolved !== null ? [resolved] : []
}
