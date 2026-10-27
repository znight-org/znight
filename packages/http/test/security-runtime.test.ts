/**
 * Runs `fixtures/security-check.ts` in a Node.js 24 process and a Bun process: CORS, security
 * headers, trusted proxies and plugin routes answer the same on every adapter, over the network
 * and in memory, on both runtimes.
 */
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'bun:test'

const SCRIPT = fileURLToPath(new URL('./fixtures/security-check.ts', import.meta.url))

interface Observed {
  readonly status: number
  readonly body: string
  readonly headers: Record<string, string>
}

type Results = Record<string, { network: Observed[]; inject: Observed[] }>

async function run(command: string): Promise<Results> {
  const child = Bun.spawn([command, '--conditions=@znight/source', SCRIPT], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`${command} exited with ${code}: ${stderr}`)
  return JSON.parse(stdout) as Results
}

const outcomes: Record<string, Results> = {}

for (const runtime of ['node', 'bun']) {
  describe(`${runtime} runtime`, () => {
    it('answers the same on every adapter, over the network and in memory', async () => {
      const results = await run(runtime === 'node' ? 'node' : process.execPath)
      outcomes[runtime] = results
      expect(Object.keys(results)).toEqual(['node', 'fastify', 'express', 'hono'])
      const reference = results['node']?.network ?? []
      expect(reference.map(entry => entry.status)).toEqual([
        204, 204, 403, 404, 200, 401, 500, 405, 200, 200, 200, 200, 201,
      ])
      expect(reference[0]?.headers).toMatchObject({
        'access-control-allow-origin': 'https://app.example.com',
        'access-control-allow-headers': 'x-api-key',
        'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      })
      expect(JSON.parse(reference[9]?.body ?? '{}')).toEqual({ ip: '203.0.113.7', protocol: 'https' })
      expect(JSON.parse(reference[10]?.body ?? '{}')).toEqual({ ip: '127.0.0.1', protocol: 'http' })
      for (const [adapter, observed] of Object.entries(results)) {
        expect({ adapter, network: observed.network }).toEqual({ adapter, network: reference })
        expect({ adapter, inject: observed.inject }).toEqual({ adapter, inject: reference })
      }
    }, 30_000)
  })
}

describe('Node.js and Bun', () => {
  it('give the same responses', () => {
    if (outcomes['node'] === undefined || outcomes['bun'] === undefined) return
    expect(outcomes['bun']).toEqual(outcomes['node'])
  })
})
