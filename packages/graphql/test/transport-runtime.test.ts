/**
 * Runs `fixtures/transport-check.ts` in a Node.js 24 process and a Bun process: the GraphQL
 * endpoint passes the graphql-http audits (GraphQL-over-HTTP draft) and serves GraphQL over SSE to
 * the graphql-sse client the same way on every adapter (node, fastify, express, hono), over a real
 * socket, on both runtimes. The graphql-http handler mounted as a driver on the engine and the Yoga
 * driver (RFC 0009) pass the same audits; Yoga serves the engine's subscriptions over its own SSE.
 */
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'bun:test'

const SCRIPT = fileURLToPath(new URL('./fixtures/transport-check.ts', import.meta.url))

interface AdapterResult {
  readonly audits: number
  readonly notOk: readonly string[]
  readonly statuses: Record<string, string>
  readonly sse: Record<string, unknown>
  readonly driver: { readonly audits: number; readonly notOk: readonly string[] } & Record<string, unknown>
  readonly yoga: { readonly audits: number; readonly notOk: readonly string[] } & Record<string, unknown>
}

type Results = Record<string, AdapterResult>

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

const JSON_TYPE = 'application/json; charset=utf-8'
const outcomes: Record<string, Results> = {}
// both processes run at once (each runs its adapters one after the other, on ports of its own)
const runs: Record<string, Promise<Results>> = {}
const started = (runtime: string): Promise<Results> => {
  runs['node'] ??= run('node')
  runs['bun'] ??= run(process.execPath)
  return runs[runtime] as Promise<Results>
}

for (const runtime of ['node', 'bun']) {
  describe(`${runtime} runtime`, () => {
    it('passes the GraphQL-over-HTTP audits and serves GraphQL over SSE on every adapter', async () => {
      const results = await started(runtime)
      outcomes[runtime] = results
      expect(Object.keys(results)).toEqual(['node', 'fastify', 'express', 'hono'])
      const reference = results['node'] as AdapterResult
      expect(reference.audits).toBeGreaterThanOrEqual(60)
      expect(reference.notOk).toEqual([])
      expect(reference.statuses).toEqual({
        'post json': `200 ${JSON_TYPE}`,
        'post graphql-response+json': '400 application/graphql-response+json; charset=utf-8',
        'post text/plain': `415 ${JSON_TYPE}`,
        'post form': `415 ${JSON_TYPE}`,
        'post batch': `400 ${JSON_TYPE}`,
        'post html': `406 ${JSON_TYPE}`,
        'post too large': `413 ${JSON_TYPE}`,
        'get query': `200 ${JSON_TYPE}`,
        'get mutation': `405 ${JSON_TYPE} allow=POST`,
        'get without query': `400 ${JSON_TYPE}`,
        delete: `405 ${JSON_TYPE} allow=GET, HEAD, POST, OPTIONS`,
      })
      expect(reference.sse).toEqual({
        client: [{ data: { countdown: 3 } }, { data: { countdown: 2 } }, { data: { countdown: 1 } }],
        clientQuery: [{ data: { hello: 'Hello world' } }],
        disconnect: { first: { data: { forever: 1 } }, ended: true, active: 0 },
        framing: ':\n\nevent: next\ndata: {"data":{"hello":"Hello world"}}\n\nevent: complete\ndata: \n\n',
        heartbeats: 2,
        shutdown: { next: true, complete: false, retry: true },
      })
      // graphql-http's handler on the engine: conformant, the engine's results and masked errors
      expect(reference.driver.audits).toBeGreaterThanOrEqual(60)
      expect(reference.driver.notOk).toEqual([])
      expect(reference.driver['hello']).toEqual({ status: 200, body: { data: { hello: 'Hello world' } } })
      expect(reference.driver['fail']).toEqual({
        status: 200,
        body: {
          data: { fail: null },
          errors: [
            {
              message: 'Unexpected error.',
              locations: [{ line: 1, column: 3 }],
              path: ['fail'],
              extensions: { code: 'INTERNAL_SERVER_ERROR' },
            },
          ],
        },
      })
      // the Yoga driver: conformant, the engine's results and masking, Yoga's SSE (complete on shutdown)
      expect(reference.yoga.audits).toBeGreaterThanOrEqual(60)
      expect(reference.yoga.notOk).toEqual([])
      expect(reference.yoga['hello']).toEqual(reference.driver['hello'])
      expect(reference.yoga['fail']).toEqual(reference.driver['fail'])
      expect(reference.yoga['framing']).toBe(
        ':\n\nevent: next\ndata: {"data":{"countdown":2}}\n\nevent: next\ndata: {"data":{"countdown":1}}\n\nevent: complete\ndata:\n\n',
      )
      expect(reference.yoga['client']).toEqual([
        { data: { countdown: 3 } },
        { data: { countdown: 2 } },
        { data: { countdown: 1 } },
      ])
      expect(reference.yoga['shutdown']).toEqual({ next: true, complete: true })
      for (const [adapter, observed] of Object.entries(results)) {
        expect({ adapter, observed }).toEqual({ adapter, observed: reference })
      }
    }, 120_000)
  })
}

describe('Node.js and Bun', () => {
  it('give the same results', () => {
    if (outcomes['node'] === undefined || outcomes['bun'] === undefined) return
    expect(outcomes['bun']).toEqual(outcomes['node'])
  })
})
