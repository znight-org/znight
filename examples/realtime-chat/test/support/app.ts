import type { PluginsOptions } from '../../src/plugins.js'

import { inline } from '@znight/config'
import { TestApp } from '@znight/testing'

import { __ZNIGHT_METADATA__ } from '../../src/.znight/container.generated.js'
import { plugins } from '../../src/plugins.js'

export const ALICE_KEY = 'alice-key' // a moderator
export const BOB_KEY = 'bob-key'

/** The test configuration: `inline()` replaces `.env` files and the environment. */
export const TEST_CONFIG = [inline({ CHAT_KEYS: `alice:${ALICE_KEY}:moderator,bob:${BOB_KEY}` })]

/** The application in memory: `app.inject()` for HTTP, `app.connect()` for WebSockets. */
export function createApp(options: PluginsOptions = {}): Promise<TestApp> {
  return TestApp.create({
    metadata: __ZNIGHT_METADATA__,
    plugins: plugins({ port: 0, config: TEST_CONFIG, ...options }),
  })
}

/** A single-use ticket for the WebSocket handshake, as a browser gets it. */
export async function ticket(app: TestApp, key: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/ws/tickets', headers: { 'x-api-key': key } })
  return response.json<{ ticket: string }>().ticket
}
