import type { ConfigLoader } from '@znight/config'
import type { Plugin } from '@znight/core'
import type { HttpAdapter } from '@znight/http'

import { ConfigPlugin } from '@znight/config'
import { HttpPlugin } from '@znight/http'
import { WebSocketPlugin, type WebSocketPluginOptions } from '@znight/websocket'

import { AuthGuard } from './auth/auth.guard.js'

/** What `main.ts` and the tests change. */
export interface PluginsOptions {
  /**
   * Where the configuration (`CHAT_KEYS`) comes from. Default: `.env` files, then the environment
   * (which wins). Tests pass `[inline({ ... })]`, so that they do not depend on the machine.
   */
  readonly config?: readonly ConfigLoader[]
  readonly port?: number
  readonly adapter?: HttpAdapter
  readonly websocket?: WebSocketPluginOptions
}

/**
 * The plugins of the application, shared by `main.ts` and the tests. `ConfigPlugin` validates the
 * `@Config` classes first (no boot without `CHAT_KEYS`). Gateways are served by the `HttpPlugin`
 * server, on the same port; the global `AuthGuard` also runs on every handshake.
 */
export function plugins(options: PluginsOptions = {}): Plugin[] {
  return [
    ConfigPlugin.configure(options.config === undefined ? {} : { loaders: options.config }),
    HttpPlugin.configure({
      port: options.port ?? Number(process.env['PORT'] ?? 3000),
      ...(process.env['HOST'] === undefined ? {} : { host: process.env['HOST'] }),
      guards: [AuthGuard],
      ...(options.adapter === undefined ? {} : { adapter: options.adapter }),
    }),
    WebSocketPlugin.configure({
      origins: process.env['WEB_ORIGINS']?.split(',') ?? 'same-origin',
      maxPayload: '64kb',
      ...options.websocket,
    }),
  ]
}
