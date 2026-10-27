/**
 * Runs `fixtures/cookies-sse-check.ts` in a Node.js 24 process and a Bun process: cookies and event
 * streams answer the same on every adapter, over the network and in memory, on both runtimes.
 */
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'bun:test'

const SCRIPT = fileURLToPath(new URL('./fixtures/cookies-sse-check.ts', import.meta.url))

interface Observed {
  readonly status: number
  readonly body: string
  readonly headers: Record<string, string | string[]>
}

type Results = Record<string, { network: Observed[]; inject: Observed[]; sse: Record<string, unknown> }>

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

const DEFAULTS = 'Path=/; Secure; HttpOnly; SameSite=Lax'
const outcomes: Record<string, Results> = {}

for (const runtime of ['node', 'bun']) {
  describe(`${runtime} runtime`, () => {
    it('answers the same on every adapter, over the network and in memory', async () => {
      const results = await run(runtime === 'node' ? 'node' : process.execPath)
      outcomes[runtime] = results
      expect(Object.keys(results)).toEqual(['node', 'fastify', 'express', 'hono'])
      const reference = results['node']?.network ?? []
      expect(reference.map(entry => entry.status)).toEqual([
        200, 200, 400, 204, 200, 200, 400, 204, 200, 401, 302, 200, 500, 200, 200, 404,
      ])
      expect(JSON.parse(reference[2]?.body ?? '{}')).toMatchObject({ message: 'Invalid cookie "n": expected a number' })
      expect(reference[4]?.headers['set-cookie']).toEqual([
        expect.stringMatching(/^__Host-uid=u-1\.[\w-]{43}; Max-Age=28800; Path=\/; Secure; HttpOnly; SameSite=Lax$/),
      ])
      expect(JSON.parse(reference[5]?.body ?? '{}')).toEqual({ uid: 'u-9' })
      expect(reference[8]?.headers['set-cookie']).toEqual([
        'raw=1; Path=/',
        `a=response; ${DEFAULTS}`,
        `c=kept; ${DEFAULTS}`,
        `b=two%20words; ${DEFAULTS}`,
      ])
      expect(JSON.parse(reference[13]?.body ?? '{}')).toEqual({ header: 'a=1; b=x%20y', cookies: { a: '1', b: 'x y' } })
      expect(reference[14]?.headers['content-type']).toBe('text/event-stream; charset=utf-8')
      const sse = results['node']?.sse ?? {}
      expect(sse['framed']).toBe(
        ':\n\nid: 41\nevent: status\ndata: {"orderId":"o-1","status":"paid"}\n\ndata: line 1\ndata: line 2\n\n: note\n\nevent: done\ndata: \n\ndata:  leading space\n\n',
      )
      expect(sse['framedNetwork']).toBe(sse['framed'])
      expect(sse['retry']).toBe(5_000)
      expect(sse['disconnect']).toEqual({ first: 'alive', signals: ['client'], streams: 0 })
      expect(sse['assistant']).toEqual({ status: 200, cookies: ['conversation', 'turn'], tokens: ['a', 'b', ''] })
      expect(sse['rejected']).toContain('answered an event stream (text/event-stream)')
      for (const [adapter, observed] of Object.entries(results)) {
        expect({ adapter, network: observed.network }).toEqual({ adapter, network: reference })
        expect({ adapter, inject: observed.inject }).toEqual({ adapter, inject: reference })
        expect({ adapter, sse: observed.sse }).toEqual({ adapter, sse })
      }
    }, 60_000)
  })
}

describe('Node.js and Bun', () => {
  it('give the same responses', () => {
    if (outcomes['node'] === undefined || outcomes['bun'] === undefined) return
    expect(outcomes['bun']).toEqual(outcomes['node'])
  })
})
