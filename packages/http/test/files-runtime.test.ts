/**
 * Runs `fixtures/files-check.ts` in a Node.js 24 process and a Bun process and checks that uploads,
 * downloads and streams answer the same on every adapter, over the network and in memory, on both
 * runtimes (identical statuses, bodies and headers; same cancellation and disposal order).
 */
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'bun:test'

const SCRIPT = fileURLToPath(new URL('./fixtures/files-check.ts', import.meta.url))

interface Observed {
  readonly status: number
  readonly body: string
  readonly headers: Record<string, string>
}

interface AdapterResult {
  readonly network: Observed[]
  readonly inject: Observed[]
  readonly abort: { readonly bounded: boolean; readonly order: string[] }
  readonly early: string
}

async function run(command: string): Promise<Record<string, AdapterResult>> {
  const child = Bun.spawn([command, '--conditions=@znight/source', SCRIPT], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`${command} exited with ${code}: ${stderr}`)
  return JSON.parse(stdout) as Record<string, AdapterResult>
}

const STATUSES = [201, 413, 415, 415, 400, 413, 200, 400, 200, 200, 200, 304, 206, 416, 404, 200, 206, 200, 200, 200]

const outputs = new Map<string, Record<string, AdapterResult>>()

for (const runtime of ['node', 'bun']) {
  describe(`${runtime} runtime`, () => {
    it('answers the same on every adapter, over the network and in memory', async () => {
      const results = await run(runtime === 'node' ? 'node' : process.execPath)
      outputs.set(runtime, results)
      expect(Object.keys(results)).toEqual(['node', 'fastify', 'express', 'hono'])
      const reference = results['node'] as AdapterResult
      expect(reference.network.map(entry => entry.status)).toEqual(STATUSES)
      expect(reference.network[0]?.body).toBe(
        '{"avatar":{"name":"me.png","type":"image/png","size":4,"text":"PPPP"},"meta":{"title":"Me","tags":["a","b"]}}',
      )
      expect(reference.network[12]).toEqual({
        status: 206,
        body: '01234',
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'content-length': '5',
          'content-range': 'bytes 10-14/300',
          etag: `"${Date.parse('2024-05-06T07:08:09Z').toString(16)}-12c"`,
          'last-modified': 'Mon, 06 May 2024 07:08:09 GMT',
          'accept-ranges': 'bytes',
        },
      })
      for (const [adapter, observed] of Object.entries(results)) {
        expect({ adapter, network: observed.network }).toEqual({ adapter, network: reference.network })
        expect({ adapter, inject: observed.inject }).toEqual({ adapter, inject: reference.network })
        expect({ adapter, abort: observed.abort }).toEqual({
          adapter,
          abort: { bounded: true, order: ['endless', 'cancel', 'dispose'] },
        })
        expect({ adapter, early: observed.early }).toEqual({ adapter, early: 'HTTP/1.1 413 Payload Too Large' })
      }
    }, 60_000)
  })
}

describe('Node.js and Bun', () => {
  it('give identical results', () => {
    const node = outputs.get('node')
    const bun = outputs.get('bun')
    expect(node).toBeDefined()
    expect(bun).toEqual(node as Record<string, AdapterResult>)
  })
})
