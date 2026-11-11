/**
 * Helpers of the broker integration tests (testcontainers), enabled with ZNIGHT_INTEGRATION=1. The
 * conformance scenarios themselves are `describeDriverConformance()` of `@znight/messaging/testing`.
 */
import type { MessagingDriver } from '../../src/index.ts'

import { Application, type CoreLogger } from '@znight/core'

import { MessagingPlugin } from '../../src/index.ts'
import { memoryLogger, messagingMetadata, sleep, type TestConsumer } from '../helpers.ts'

export const integration: boolean = process.env['ZNIGHT_INTEGRATION'] === '1'

/** Polls `predicate` until it holds. */
export async function waitFor(predicate: () => boolean, timeoutMs = 30_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}`)
    await sleep(20)
  }
}

/** Whether `error` is the Testcontainers race in which the Ryuk reaper is created before its image is pulled. */
function isRyukImageRace(error: unknown): boolean {
  return error instanceof Error && /No such image: testcontainers\/ryuk/.test(error.message)
}

/**
 * Starts a container, retrying when the first container of the run loses the Testcontainers race that
 * creates the Ryuk reaper before its image has finished pulling ("No such image:
 * testcontainers/ryuk:..."). Testcontainers caches the reaper only once it started, so a retry pulls
 * the image again and creates it. Any other error fails at once.
 */
export async function startContainer<T>(start: () => Promise<T>, attempts = 3, delayMs = 2_000): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await start()
    } catch (error) {
      if (attempt >= attempts || !isRyukImageRace(error)) throw error
      await sleep(delayMs * attempt)
    }
  }
}

let apps: Application[] = []

/** Creates and starts an application consuming with `driver`; {@link stopApps} stops it. */
export async function startApp(
  driver: MessagingDriver,
  consumers: readonly TestConsumer[],
  logger: CoreLogger = memoryLogger(),
): Promise<Application> {
  const app = await Application.create({
    metadata: messagingMetadata(consumers),
    plugins: [MessagingPlugin.configure({ driver, defaults: { requeueDelay: 50 } })],
    logger,
    shutdown: { signals: false, hookTimeoutMs: 20_000, timeoutMs: 30_000 },
  })
  apps.push(app)
  await app.start()
  return app
}

/** Stops the applications started by {@link startApp} (register it with `afterEach`). */
export async function stopApps(): Promise<void> {
  const running = apps
  apps = []
  for (const app of running.reverse()) await app.stop()
}
