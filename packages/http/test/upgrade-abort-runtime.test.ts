/**
 * Runs `fixtures/upgrade-abort-check.ts` in a Node.js 24 process and a Bun process: on every adapter,
 * a client leaving during a WebSocket handshake aborts `ctx.signal` (`kind: 'client'`) without the
 * handshake being completed, and a connection accepted then closed by its client aborts nothing.
 */
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'bun:test'

const SCRIPT = fileURLToPath(new URL('./fixtures/upgrade-abort-check.ts', import.meta.url))

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
  // in flight while the guard waited, aborted by the client, never accepted, then released
  left: { waiting: 1, reason: 'client', accepted: 0, settled: true },
  // the connection held the handshake's scope until it closed, and its close aborted nothing
  accepted: {
    status: 'HTTP/1.1 101 Switching Protocols',
    open: 1,
    closed: true,
    reason: null,
    accepted: 1,
    released: 1,
  },
}

for (const runtime of ['node', 'bun']) {
  describe(`${runtime} runtime`, () => {
    it('aborts ctx.signal when the client leaves during a WebSocket handshake, never after', async () => {
      const results = await run(runtime === 'node' ? 'node' : process.execPath)
      expect(results).toEqual({ node: EXPECTED, fastify: EXPECTED, express: EXPECTED, hono: EXPECTED })
    }, 60_000)
  })
}
