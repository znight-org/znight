import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'bun:test'

const packageDir = fileURLToPath(new URL('..', import.meta.url))
const node = Bun.which('node')
const runtimes = [
  ['Bun', process.execPath],
  ['Node.js', node],
] as const

/** Runs test/fixtures/slow-stdout-shutdown.mjs: its stdout is slow, it stops on SIGTERM. */
function run(runtime: string, mode: 'ok' | 'fail', transport: 'console' | 'cloudwatch') {
  const result = spawnSync(
    runtime,
    ['--conditions=@znight/source', 'test/fixtures/slow-stdout-shutdown.mjs', mode, transport],
    { cwd: packageDir, encoding: 'utf8', timeout: 30_000 },
  )
  const entries = result.stdout
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>)
  return {
    status: result.status,
    stderr: result.stderr,
    messages: entries.map(entry => entry['msg'] ?? entry['message']),
    saved: entries.filter(entry => entry['i'] !== undefined).map(entry => entry['i']),
  }
}

describe('shutdown logs on a slow stdout', () => {
  // every asynchronous write to stdout takes 50 ms: writes are in flight while the application
  // stops, and the last entries are logged after the logger's final flush (onDispose)
  for (const [name, runtime] of runtimes) {
    for (const transport of ['console', 'cloudwatch'] as const) {
      it.skipIf(runtime === null)(
        `${name}, ${transport} transport: every line, in order, the final one last`,
        () => {
          for (const mode of ['ok', 'fail'] as const) {
            const result = run(runtime as string, mode, transport)
            expect(result.stderr).toBe('')
            expect(result.status).toBe(mode === 'ok' ? 0 : 1)
            expect(result.messages).toEqual([
              'Store opened',
              'Received SIGTERM: shutting down gracefully',
              'Store stopping',
              ...Array.from({ length: 20 }, () => 'Store saving'),
              'Store saved',
              'Store closed',
              mode === 'ok' ? 'Application stopped' : 'The application stopped with errors',
            ])
            expect(result.saved).toEqual(Array.from({ length: 20 }, (_, i) => i))
          }
        },
        60_000,
      )
    }
  }
})
