/**
 * Runs `fixtures/regressions-check.ts` in a Node.js 24 process and a Bun process and checks edge
 * cases that used to differ between adapters or leak request scopes: every adapter must answer the
 * same, on both runtimes (the Hono adapter on Bun only sees the normalised URL: documented deviation).
 */
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'bun:test'

const SCRIPT = fileURLToPath(new URL('./fixtures/regressions-check.ts', import.meta.url))

type Results = Record<string, Record<string, unknown>>

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

const INTERNAL_ERROR = '{"statusCode":500,"error":"Internal Server Error"}'

/** What every adapter answers. */
const EXPECTED = {
  // a request-scoped provider deletes the file it owns when the request is over: after the download
  file: { status: 200, length: '2097152', received: 2_097_152, disposed: 1, inflight: 0 },
  // an invalid header: one plain 500 (no framework error body), seen once by hooks, stream released
  badHeader: { status: 500, body: INTERNAL_ERROR, inflight: 0, hooks: [500] },
  badHeaderInject: { status: 500, body: INTERNAL_ERROR },
  crlfRedirect: { status: 500, body: INTERNAL_ERROR, cookie: null },
  // returned Web streams of strings / ArrayBuffers are converted to bytes
  webStreams: { strings: [200, 'hello world'], buffers: [200, 'hello buffers'], inject: [200, 'hello world'] },
  webStreamsInflight: 0,
  // an unfinished ctx.bodyStream() is discarded: the keep-alive connection serves the next request
  keepAlive: { responses: ['400', '200'], pong: true },
  // `content-length: 0` and no framing header at all: no file
  bodylessUpload: [['201'], '{"file":null}', ['201'], '{"file":null}'],
  // routing on the raw path: dot segments are parameters like any other segment
  routing: [
    '200 {"path":"/echo/a/../b","rest":"a/../b"}',
    '200 {"path":"/echo/%2e%2e/x","rest":"../x"}',
    '200 {"path":"/echo/./c","rest":"./c"}',
  ],
  // content types Fastify cannot parse reach the route, parsed as bytes
  contentTypes: ['201 {"type":"bytes"}', '201 {"type":"bytes"}'],
  // `/\evil.com/` is not redirected to another host
  redirect: ['308 location=/%5Cevil.com'],
  // `.__proto__` is an unknown extension
  mime: [200, 'application/octet-stream'],
  // drainTimeoutMs: Infinity waits for the in-flight request
  drainInfinity: 'slow done',
}

/** `Bun.serve()` hands the Hono adapter the WHATWG-normalised URL only (see the README). */
const HONO_ON_BUN = {
  routing: [
    '200 {"path":"/echo/b","rest":"b"}',
    '200 {"slug":"x"}', // `/echo/%2e%2e/x` is `/x`
    '200 {"path":"/echo/c","rest":"c"}',
  ],
  redirect: ['404 location='], // `/\evil.com/` is `//evil.com/`: no route
}

for (const runtime of ['node', 'bun']) {
  describe(`${runtime} runtime`, () => {
    it('answers the same on every adapter', async () => {
      const results = await run(runtime === 'node' ? 'node' : process.execPath)
      expect(Object.keys(results)).toEqual(['node', 'fastify', 'express', 'hono', 'expressBodyParser'])
      for (const adapter of ['node', 'fastify', 'express', 'hono']) {
        const expected = adapter === 'hono' && runtime === 'bun' ? { ...EXPECTED, ...HONO_ON_BUN } : EXPECTED
        expect({ adapter, ...results[adapter] }).toEqual({ adapter, ...expected })
      }
      // a body parser consumed the body before the Znight route: an explicit 500, not an empty body
      expect(results['expressBodyParser']).toEqual({ status: 500, logged: true })
    }, 60_000)
  })
}
