import type { ProviderKey } from '@znight/core'
import type { GraphQLPlugin, GraphQLPluginOptions, MemoryPubSub } from '@znight/graphql'

import { inline } from '@znight/config'
import { TestApp } from '@znight/testing'

import { __ZNIGHT_METADATA__ as metadata } from '../../src/.znight/container.generated.js'
import { plugins } from '../../src/plugins.js'

export const EDITOR_KEY = 'test-editor-key'
export const READER_KEY = 'test-reader-key'

/** Request headers of each caller. */
export const EDITOR: Readonly<Record<string, string>> = { 'x-api-key': EDITOR_KEY }
export const READER: Readonly<Record<string, string>> = { 'x-api-key': READER_KEY }

export interface TestAppSetup {
  /** Configuration values, over the test defaults (API keys, silent logs, a free port). */
  readonly env?: Readonly<Record<string, string>>
  /** GraphQL options over the application's. */
  readonly graphql?: Partial<GraphQLPluginOptions>
  /** Replacements (values or `overrideFactory()` definitions), applied last. */
  readonly overrides?: readonly (readonly [ProviderKey, unknown])[]
}

/**
 * The application as `src/main.ts` wires it (the same `plugins()`: Hono adapter, both guards, the
 * error mapper), with test configuration: `inline()` replaces `.env` files and the environment, logs
 * are silenced, the server listens on a free port (`app.inject()` needs no socket). Every instance
 * starts from the seed data (`src/catalog/seed.ts`).
 */
export function createTestApp(setup: TestAppSetup = {}): Promise<TestApp> {
  return TestApp.create({
    metadata,
    plugins: plugins({
      config: [
        inline({
          EDITOR_API_KEY: EDITOR_KEY,
          READER_API_KEY: READER_KEY,
          LOG_LEVEL: 'silent',
          PORT: '0',
          HOST: '127.0.0.1',
          ...setup.env,
        }),
      ],
      ...(setup.graphql === undefined ? {} : { graphql: setup.graphql }),
    }),
    ...(setup.overrides === undefined ? {} : { overrides: setup.overrides }),
  })
}

/** The `GraphQLPlugin` of an application. */
export function graphqlOf(app: TestApp): GraphQLPlugin {
  const plugin = app.app.getPlugin<GraphQLPlugin>('graphql')
  if (plugin === undefined) throw new Error('GraphQLPlugin is not registered')
  return plugin
}

/**
 * Waits until `count` subscribers listen to the application's `MemoryPubSub`. An `async *` resolver
 * subscribes to the PubSub when its stream is first read: in memory, the stream is read when the test
 * asks for the next event, so a test starts reading (`const first = events.next()`), waits for the
 * subscriber, then publishes.
 */
export async function subscribers(app: TestApp, count: number): Promise<void> {
  const pubsub = graphqlOf(app).pubsub as MemoryPubSub
  for (let attempt = 0; attempt < 400 && pubsub.subscribers !== count; attempt++) await Bun.sleep(5)
  if (pubsub.subscribers !== count) throw new Error(`${pubsub.subscribers} PubSub subscriber(s), expected ${count}`)
}
