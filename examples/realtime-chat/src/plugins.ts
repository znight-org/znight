import type { Plugin } from '@znight/core'
import type { HttpAdapter } from '@znight/http'

import { HttpPlugin } from '@znight/http'
import { WebSocketPlugin, type WebSocketPluginOptions } from '@znight/websocket'

import { AuthGuard } from './auth/auth.guard.js'

/** What `main.ts` and the tests change. */
export interface PluginsOptions {
  readonly port?: number
  readonly adapter?: HttpAdapter
  readonly websocket?: WebSocketPluginOptions
}

/**
 * The plugins of the application, shared by `main.ts` and the tests. Gateways are served by the
 * `HttpPlugin` server, on the same port; the global `AuthGuard` also runs on every handshake.
 */
export function plugins(options: PluginsOptions = {}): Plugin[] {
  return [
    HttpPlugin.configure({
      port: options.port ?? Number(process.env['PORT'] ?? 3000),
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
