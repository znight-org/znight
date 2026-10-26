/**
 * Runs `fixtures/runtime-check.ts` in a Node.js 24 process and a Bun process (sources executed
 * directly with the `@znight/source` condition) and checks that every adapter answers the same, over
 * the network and in memory, on both runtimes.
 */
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'bun:test'

const SCRIPT = fileURLToPath(new URL('./fixtures/runtime-check.ts', import.meta.url))

interface Observed {
  readonly status: number
  readonly body: string
  readonly allow?: string
  readonly contentLength?: string
}

type Results = Record<
  string,
  { network: Observed[]; inject: Observed[]; shutdown: { drained: string; refused: boolean; forced: string } }
>

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

/** Removes what legitimately differs between runtimes (JSON parser messages, runtime name). */
function normalise(observed: readonly Observed[]): Observed[] {
  return observed.map(entry => ({
    ...entry,
    body: entry.body
      .replace(/Invalid JSON body: [^"]*/, 'Invalid JSON body')
      .replace(/"runtime":"\w+"/, '"runtime":"*"'),
  }))
}

/** HEAD /items/42 has the length of `{"id":42,"runtime":"node"}` (26) or `..."bun"}` (25). */
const expected = (runtime: string): readonly Partial<Observed>[] => [
  { status: 200 },
  { status: 400 },
  { status: 201, body: '{"name":"pen","qty":1}' },
  { status: 400 },
  { status: 400 },
  { status: 200, body: '', contentLength: runtime === 'node' ? '26' : '25' },
  { status: 200, body: 'ab' },
  { status: 200 },
  { status: 405, allow: 'GET, HEAD, OPTIONS' },
  { status: 404 },
]

for (const runtime of ['node', 'bun']) {
  describe(`${runtime} runtime`, () => {
    it('serves the same responses on every adapter, over the network and in memory', async () => {
      const results = await run(runtime === 'node' ? 'node' : process.execPath)
      expect(Object.keys(results)).toEqual(['node', 'fastify', 'express', 'hono'])
      const reference = normalise(results['node']?.network ?? [])
      const expectations = expected(runtime)
      expect(reference).toHaveLength(expectations.length)
      expectations.forEach((expectation, index) => {
        expect(reference[index]).toMatchObject(expectation)
      })
      expect(JSON.parse(results['node']?.network[0]?.body ?? '{}')).toEqual({ id: 42, runtime })
      for (const [adapter, observed] of Object.entries(results)) {
        const adapterName = (body: string) => body.replace(`"adapter":"${adapter}"`, '"adapter":"node"')
        const network = normalise(observed.network).map(entry => ({ ...entry, body: adapterName(entry.body) }))
        const inject = normalise(observed.inject).map(entry => ({ ...entry, body: adapterName(entry.body) }))
        expect({ adapter, network }).toEqual({ adapter, network: reference })
        expect({ adapter, inject }).toEqual({ adapter, inject: reference })
        expect({ adapter, shutdown: observed.shutdown }).toEqual({
          adapter,
          shutdown: { drained: 'slow done', refused: true, forced: 'aborted' },
        })
      }
    }, 30_000)
  })
}
