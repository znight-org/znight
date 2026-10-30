/**
 * Runs `fixtures/fastify-lanes-check.ts` in a Node.js 24 process and a Bun process. The Fastify
 * adapter serves Znight routes from its `onRequest` hook (writing text replies on the raw response)
 * only when nothing else needs Fastify's lifecycle; otherwise requests go through it. Both ways must
 * write the same bytes, and every hook, `onRoute` wrapper and tracing subscriber must still run.
 */
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'bun:test'

const SCRIPT = fileURLToPath(new URL('./fixtures/fastify-lanes-check.ts', import.meta.url))

type Results = Record<string, { readonly responses: readonly string[]; readonly seen: readonly string[] }>

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

const SECURITY =
  "content-security-policy: default-src 'none'; frame-ancestors 'none'\r\nx-frame-options: DENY\r\n" +
  'x-content-type-options: nosniff\r\nreferrer-policy: no-referrer\r\n'
const JSON_HEAD = 'content-type: application/json; charset=utf-8\r\n'
const END = 'Date: *\r\nConnection: close\r\n\r\n'

/** The raw responses (date and request id masked) to the requests of the fixture. */
const RESPONSES = [
  `HTTP/1.1 200 OK\r\n${JSON_HEAD}content-length: 8\r\nx-request-id: *\r\n${SECURITY}${END}{"id":1}`,
  `HTTP/1.1 200 OK\r\n${JSON_HEAD}content-length: 8\r\nx-request-id: *\r\n${SECURITY}${END}`,
  `HTTP/1.1 201 Created\r\n${JSON_HEAD}content-length: 16\r\nx-request-id: *\r\n${SECURITY}${END}{"body":{"a":1}}`,
  // a content type Fastify cannot parse reaches the route (body as bytes)...
  `HTTP/1.1 201 Created\r\n${JSON_HEAD}content-length: 11\r\nx-request-id: *\r\n${SECURITY}${END}{"bytes":7}`,
  // ...and the 404 handler (not a 415)
  `HTTP/1.1 404 Not Found\r\n${JSON_HEAD}content-length: 68\r\nx-request-id: *\r\n${SECURITY}${END}` +
    '{"statusCode":404,"error":"Not Found","message":"Cannot POST /nope"}',
  'HTTP/1.1 200 OK\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: 4\r\nx-custom: yes\r\n' +
    'set-cookie: a=1; Path=/; Secure; HttpOnly; SameSite=Lax\r\nset-cookie: b=2; Path=/; Secure; HttpOnly; SameSite=Lax\r\n' +
    `x-request-id: *\r\n${SECURITY}${END}text`,
]

/** The URLs of the requests, as hooks see them. */
const URLS = ['/items/1', '/items/1', '/items/echo', '/items/echo', '/nope', '/items/cookie']
/** Without the 404: `onRoute` hooks only see the routes. */
const ROUTE_URLS = URLS.filter(url => url !== '/nope')

for (const runtime of ['node', 'bun']) {
  describe(`${runtime} runtime`, () => {
    it('writes the same bytes with or without Fastify hooks, and runs every hook', async () => {
      const results = await run(runtime === 'node' ? 'node' : process.execPath)
      // served from the onRequest hook, written on the raw response...
      expect(results['plain']).toEqual({ responses: RESPONSES, seen: [] })
      // ...except a bodyless reply (HEAD) and the 404 handler (Fastify's lifecycle): through reply.send()
      expect(results['sends']).toEqual({ responses: RESPONSES, seen: ['send HEAD /items/1', 'send POST /nope'] })
      // hooks between onRequest and the handler: Fastify's lifecycle, same bytes
      for (const hook of ['preParsing', 'preValidation', 'preHandler']) {
        expect(results[hook]).toEqual({ responses: RESPONSES, seen: URLS.map(url => `${hook} ${url}`) })
      }
      // onSend hooks run, and may change the reply
      expect(results['onSend']).toEqual({
        responses: RESPONSES.map(response => response.replace('Date: *', 'x-on-send: 1\r\nDate: *')),
        seen: URLS.map(url => `onSend ${url}`),
      })
      // onResponse hooks see the reply headers
      const types = [...URLS.slice(0, -1).map(() => 'application/json; charset=utf-8'), 'text/plain; charset=utf-8']
      expect(results['onResponse']).toEqual({
        responses: RESPONSES,
        seen: URLS.map((url, index) => `onResponse ${url} ${types[index]}`),
      })
      // headers set by an onRequest hook come first
      expect(results['onRequestHeader']).toEqual({
        responses: RESPONSES.map(response => response.replace(/^(HTTP\/1\.1 [^\r]*\r\n)/, '$1x-hook: 1\r\n')),
        seen: [],
      })
      // trailers set by an onRequest hook are sent by Fastify (Bun's node:http writes no chunks)
      const trailer = results['onRequestTrailer'] as Results[string]
      expect(trailer.responses.slice(1)).toEqual(RESPONSES.slice(1))
      expect(trailer.responses[0]).toContain('transfer-encoding: chunked\r\ntrailer: x-trailer\r\n')
      const chunks = runtime === 'node' ? '8\r\n{"id":1}\r\n0\r\nx-trailer: v\r\n\r\n' : '{"id":1}'
      expect(trailer.responses[0]).toEndWith(`Connection: close\r\n\r\n${chunks}`)
      // onRoute hooks wrapping the handler or adding route hooks
      expect(results['onRouteWrapper']).toEqual({ responses: RESPONSES, seen: ROUTE_URLS.map(url => `wrapped ${url}`) })
      expect(results['onRouteOnRequest']).toEqual({
        responses: RESPONSES,
        seen: ROUTE_URLS.map(url => `route onRequest ${url}`),
      })
      // a tracing subscriber sees the route handlers (Fastify publishes nothing on Bun)
      expect(results['tracing']).toEqual({
        responses: RESPONSES,
        seen: runtime === 'node' ? ROUTE_URLS.map(url => `traced ${url}`) : [],
      })
    }, 60_000)
  })
}
