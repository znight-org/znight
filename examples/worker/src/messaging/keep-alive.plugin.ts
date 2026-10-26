import type { Plugin, PluginOptions } from '@znight/core'

import { resolveOptions } from '@znight/core'

/** Options of {@link KeepAlivePlugin.configure}. */
export interface KeepAliveOptions {
  /** Default: `true`. */
  readonly enabled?: boolean
}

/**
 * Keeps the process running between `app.start()` and `app.stop()`.
 *
 * WORKAROUND: a broker connection (RabbitMQ socket) keeps a worker process alive, but the memory
 * driver opens no handle. Without this plugin, a worker consuming the memory broker with nothing
 * else running (no stdin inbox) would exit as soon as it started, without its graceful shutdown
 * (no onStop, no disposal). Only enabled with the memory driver (see main.ts).
 */
export const KeepAlivePlugin: { configure(options?: PluginOptions<KeepAliveOptions>): Plugin } = {
  configure(options = {}) {
    let enabled = true
    let timer: ReturnType<typeof setInterval> | undefined
    return {
      name: 'keep-alive',
      onBootstrap(ctx) {
        enabled = resolveOptions(options, ctx.container).enabled ?? true
      },
      onStart() {
        if (enabled) timer = setInterval(() => {}, 2 ** 30)
      },
      onStop() {
        clearInterval(timer)
      },
    }
  },
}
