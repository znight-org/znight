/**
 * Runs `fixtures/handshake-abort-check.ts` in a Node.js 24 process and a Bun process: on every HTTP
 * adapter, a client leaving while a handshake guard waits aborts `ctx.signal` (`kind: 'client'`)
 * without opening a connection, and a connection closed later by its client aborts nothing.
 */
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'bun:test'

const SCRIPT = fileURLToPath(new URL('./fixtures/handshake-abort-check.ts', import.meta.url))

async function run(command: string): Promise<Record<string, unknown>> {
  const child = Bun.spawn([command, '--conditions=@znight/source', SCRIPT], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`${command} exited with ${code}: ${stderr}`)
  return JSON.parse(stdout) as Record<string, unknown>
}

const EXPECTED = {
  // in flight while the guard waited, aborted by the client, no connection, the scope closed
  left: { waiting: 1, reason: 'client', settled: true, disposed: 1, opened: 0, connections: 0 },
  // the connection held the handshake's scope until it closed, and its close aborted nothing
  accepted: {
    opened: true,
    open: { inflight: 1, connections: 1 },
    code: 1000,
    released: true,
    reason: null,
    disposed: 1,
    stats: { opened: 1, closed: 1 },
  },
}

for (const runtime of ['node', 'bun']) {
  describe(`${runtime} runtime`, () => {
    it('aborts ctx.signal when the client leaves during a handshake, never after', async () => {
      const results = await run(runtime === 'node' ? 'node' : process.execPath)
      expect(results).toEqual({ node: EXPECTED, fastify: EXPECTED, express: EXPECTED, hono: EXPECTED })
    }, 60_000)
  })
}
