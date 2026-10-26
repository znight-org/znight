/**
 * End-to-end test of the notifications worker (opt-in: `ZNIGHT_E2E=1 bun test`, or
 * `bun run test:e2e`).
 *
 * `znight build`, then for Node.js and for Bun: `znight start --runtime <runtime>` with
 * `WORKER_STDIN_EVENTS=true` → user events written to stdin are published to the in-memory broker
 * and consumed → notifications logged, invalid event dead-lettered → SIGTERM → exit code 0 and the
 * shutdown hooks ran.
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { executableOf, expectSuccess, type LogLine, run, start } from './support/processes.ts'
import { beforeAll, describe, expect, test as it } from 'bun:test'

const enabled = process.env.ZNIGHT_E2E === '1'
const ROOT = resolve(import.meta.dir, '..')
const ZNIGHT = join(ROOT, 'node_modules/.bin/znight')
const TIMEOUT = 60_000

const ada = { id: 'u1', email: 'Ada@Example.com', name: 'Ada', at: '2026-01-01T00:00:00Z' }

const notificationOf = (line: LogLine): Record<string, unknown> | undefined =>
  line.msg === 'Notification sent' ? (line.notification as Record<string, unknown>) : undefined

describe.skipIf(!enabled)('notifications-worker end to end (ZNIGHT_E2E=1)', () => {
  beforeAll(async () => {
    expectSuccess(await run(ZNIGHT, ['build'], { cwd: ROOT }), 'znight build')
    expect(existsSync(join(ROOT, 'dist/main.js'))).toBe(true)
  }, TIMEOUT)

  for (const runtime of ['node', 'bun']) {
    it(
      `${runtime}: user events from stdin become notifications, graceful shutdown on SIGTERM`,
      async () => {
        const worker = start(ZNIGHT, ['start', '--runtime', runtime], {
          cwd: ROOT,
          env: { WORKER_STDIN_EVENTS: 'true', LOG_LEVEL: 'info' },
        })
        const publish = (type: string, payload: unknown): void => {
          worker.child.stdin?.write(`${JSON.stringify({ type, payload })}\n`)
        }
        try {
          await worker.waitForLog(line => line.msg === 'Reading user events from stdin, one JSON object per line')
          // `znight start` replaced itself with the runtime (execve): same pid, signals go straight to the app
          expect(executableOf(worker.child.pid ?? 0)).toBe(runtime)

          publish('user.registered', ada)
          publish('user.registered', ada) // a redelivery: handled once
          publish('user.registered', { id: 'u2', name: 'No email' }) // invalid: dead-lettered
          publish('user.deleted', { id: 'u1', at: '2026-01-02T00:00:00Z' })

          await worker.waitForLog(line => notificationOf(line)?.template === 'goodbye')
          expect(worker.logs().flatMap(line => notificationOf(line) ?? [])).toEqual([
            expect.objectContaining({ to: 'ada@example.com', template: 'welcome', subject: 'Welcome aboard, Ada!' }),
            expect.objectContaining({ to: 'ada@example.com', template: 'goodbye', subject: 'Goodbye, Ada' }),
          ])
          expect(worker.logs()).toContainEqual(
            expect.objectContaining({ msg: 'User event dead-lettered', type: 'user.registered', attempt: 1 }),
          )
          expect(worker.logs()).toContainEqual(expect.objectContaining({ msg: 'Duplicate user.registered ignored' }))
        } catch (error) {
          await worker.stop('SIGKILL')
          throw new Error(`${String(error)}\n--- output ---\n${worker.output()}`)
        }

        // graceful shutdown: consumers drained, then the providers' onStop hooks (Heartbeat)
        expect(await worker.stop('SIGTERM')).toBe(0)
        const messages = worker.logs().map(line => line.msg)
        expect(messages).toContain('Received SIGTERM: shutting down gracefully')
        expect(worker.logs()).toContainEqual(expect.objectContaining({ msg: 'Notifications worker stopped', sent: 2 }))
        expect(messages.at(-1)).toBe('Application stopped')
      },
      TIMEOUT,
    )
  }
})
