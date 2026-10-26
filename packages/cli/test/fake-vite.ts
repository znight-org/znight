import type { InlineConfig, Plugin } from 'vite'
import type { ViteApi, WatcherEvent } from '../src/integrations/vite.ts'

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

/** Options of {@link FakeVite}. */
export interface FakeViteOptions {
  /** Error thrown by the build (one-shot, or when starting the watch mode). */
  readonly fail?: unknown
  /** `loadConfigFromFile` result (plugins of the config). */
  readonly configPlugins?: unknown
}

/** A fake `vite` module recording builds. */
export class FakeVite implements ViteApi {
  readonly builds: InlineConfig[] = []
  readonly watchers: FakeWatcher[] = []
  readonly options: FakeViteOptions
  loadedConfigs = 0

  constructor(options: FakeViteOptions = {}) {
    this.options = options
  }

  build(config: InlineConfig): Promise<unknown> {
    this.builds.push(config)
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

  readonly loadConfigFromFile: ViteApi['loadConfigFromFile'] = (_env, configFile) => {
    this.loadedConfigs++
    return Promise.resolve({ path: configFile ?? 'vite.config.ts', config: { plugins: this.options.configPlugins } })
  }

  /** Calls `writeBundle` of the plugins given to the last build, as a successful build does. */
  writeBundle(config: InlineConfig = this.lastBuild(), fileName = 'main.js'): void {
    const root = config.root ?? '/'
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
