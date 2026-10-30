/**
 * Runs `fixtures/body-abort-check.ts` in a Node.js 24 process and a Bun process: on every adapter, a
 * client leaving in the middle of a body releases the request without running the handler, and the
 * server keeps reading the next bodies (one chunk, several chunks, chunked encoding).
 */
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'bun:test'

const SCRIPT = fileURLToPath(new URL('./fixtures/body-abort-check.ts', import.meta.url))

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
  // the request was being read, then released (nothing in flight) without a handler call
  reading: true,
  released: true,
  calls: 3,
  next: ['201 {"body":"hello"}', '201 {"body":"hello you"}', '201 {"body":"abcde"}'],
}

for (const runtime of ['node', 'bun']) {
  describe(`${runtime} runtime`, () => {
    it('releases a request whose client left in the middle of the body', async () => {
      const results = await run(runtime === 'node' ? 'node' : process.execPath)
      expect(results).toEqual({ node: EXPECTED, fastify: EXPECTED, express: EXPECTED, hono: EXPECTED })
    }, 60_000)
  })
}
