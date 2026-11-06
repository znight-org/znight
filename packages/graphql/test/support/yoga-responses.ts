/**
 * How the Yoga driver sends Yoga's responses (whatever Fetch API made them: the `@whatwg-node`
 * ponyfills on Node.js, the runtime's own on Bun), on a real socket of every adapter: the status,
 * the headers and each `set-cookie` line; a JSON body as text with its `content-length`; another
 * body (bytes, a compressed JSON body, text in another charset) streamed as it is; an event stream
 * delivered as it is produced and cancelled when the client leaves. Framework-neutral (`node:assert`): run by `yoga-responses.test.ts` on Bun and by
 * `fixtures/yoga-responses-node.ts` on Node.js.
 */
// biome-ignore-all lint/suspicious/useExpect: a framework-neutral suite, asserting with node:assert
import type { HttpAdapter } from '@znight/http'
import type { Plugin as YogaPlugin } from 'graphql-yoga'
import type { LibraryApp } from './library.ts'

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict'
import { request } from 'node:http'
import { gunzipSync } from 'node:zlib'

import { yogaDriver } from '../../src/yoga.ts'
import { observed, startLibrary } from './library.ts'

/** The test functions of the framework running the scenarios. */
export interface ScenarioTestApi {
  describe(name: string, body: () => void): unknown
  it(name: string, body: () => Promise<void>): unknown
  beforeAll(body: () => Promise<void>): unknown
  afterAll(body: () => Promise<void>): unknown
}

const BYTES = [0, 1, 2, 255, 128]

/** "Zoé" in ISO-8859-1: not UTF-8. */
const LATIN1 = [0x5a, 0x6f, 0xe9]

/** A Yoga plugin adding headers and cookies to every response, and answering bytes on `x-bytes`. */
const plugin: YogaPlugin = {
  onRequest({ request, endResponse, fetchAPI }) {
    if (request.headers.get('x-bytes') !== null) {
      endResponse(
        new fetchAPI.Response(new Uint8Array(BYTES), {
          status: 203,
          headers: { 'content-type': 'application/octet-stream', 'x-kind': 'bytes' },
        }),
      )
    } else if (request.headers.get('x-latin1') !== null) {
      endResponse(
        new fetchAPI.Response(new Uint8Array(LATIN1), {
          headers: { 'content-type': 'text/plain; charset=iso-8859-1' },
        }),
      )
    }
  },
  onResponse({ response }) {
    response.headers.append('set-cookie', 'first=1; Path=/')
    response.headers.append('set-cookie', 'second=2; Path=/; HttpOnly')
    response.headers.set('x-yoga', 'yes')
  },
}

/**
 * Gzips the response on `x-gzip` with the Fetch API Yoga runs on, like `useContentEncoding()`:
 * the JSON content type is kept, `content-encoding: gzip` added.
 */
const gzip: YogaPlugin = {
  onResponse({ request, response, setResponse, fetchAPI }) {
    if (request.headers.get('x-gzip') === null || response.body === null) return
    const headers = new fetchAPI.Headers(response.headers)
    headers.set('content-encoding', 'gzip')
    headers.delete('content-length')
    const body = response.body.pipeThrough(new fetchAPI.CompressionStream('gzip'))
    setResponse(new fetchAPI.Response(body, { status: response.status, headers }))
  },
}

function post(app: LibraryApp, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(app.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

/** A `POST` read with `node:http`: the bytes as sent (`fetch()` would decompress them). */
function rawPost(
  app: LibraryApp,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(app.url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } })
    outgoing.on('error', reject)
    outgoing.on('response', incoming => {
      const chunks: Buffer[] = []
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
      incoming.on('error', reject)
      incoming.on('end', () =>
        resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(chunks) }),
      )
    })
    outgoing.end(JSON.stringify(body))
  })
}

async function until(condition: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`${what} did not happen within ${timeoutMs} ms`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** The reader of a response body (`fetch()` of Bun or of Node.js). */
interface Reader {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array | undefined }>
  cancel(): Promise<void>
}

/** Reads `reader` until the text read so far contains `expected`. */
async function readUntil(reader: Reader, expected: string): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  while (!text.includes(expected)) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`the stream ended before ${JSON.stringify(expected)}: ${JSON.stringify(text)}`)
    text += decoder.decode(value, { stream: true })
  }
  return text
}

/** Describes the scenarios on each adapter. */
export function describeYogaResponses(
  test: ScenarioTestApi,
  adapters: Readonly<Record<string, () => HttpAdapter>>,
): void {
  test.describe("the Yoga driver's responses", () => {
    for (const [name, adapter] of Object.entries(adapters)) {
      test.describe(`${name} adapter`, () => {
        let app: LibraryApp
        test.beforeAll(async () => {
          app = await startLibrary({ adapter: adapter(), graphql: { driver: yogaDriver({ plugins: [plugin, gzip] }) } })
        })
        test.afterAll(async () => {
          await app?.stop()
        })

        test.it('sends a JSON result as text with its length, its status, headers and set-cookie lines', async () => {
          const response = await post(app, { query: '{ hello(name: "Zoé ✓") }' })
          const text = await response.text()
          strictEqual(response.status, 200)
          deepStrictEqual(JSON.parse(text), { data: { hello: 'Hello Zoé ✓' } })
          strictEqual(response.headers.get('content-type'), 'application/json; charset=utf-8')
          strictEqual(response.headers.get('content-length'), String(new TextEncoder().encode(text).byteLength))
          strictEqual(response.headers.get('x-yoga'), 'yes')
          deepStrictEqual(response.headers.getSetCookie(), ['first=1; Path=/', 'second=2; Path=/; HttpOnly'])
          // HttpPlugin's own headers are still there
          ok(response.headers.get('x-request-id'))
          strictEqual(response.headers.get('x-content-type-options'), 'nosniff')
        })

        test.it("keeps the status of Yoga's errors (graphql-response+json)", async () => {
          const response = await post(app, { query: '{ nope }' }, { accept: 'application/graphql-response+json' })
          strictEqual(response.status, 400)
          strictEqual(response.headers.get('content-type'), 'application/graphql-response+json; charset=utf-8')
          deepStrictEqual(response.headers.getSetCookie(), ['first=1; Path=/', 'second=2; Path=/; HttpOnly'])
          strictEqual(
            ((await response.json()) as { errors: { message: string }[] }).errors[0]?.message,
            'Cannot query field "nope" on type "Query".',
          )
        })

        test.it('sends another body (bytes) as it is, with its status and headers', async () => {
          const response = await post(app, { query: '{ hello }' }, { 'x-bytes': '1' })
          strictEqual(response.status, 203)
          strictEqual(response.headers.get('content-type'), 'application/octet-stream')
          strictEqual(response.headers.get('x-kind'), 'bytes')
          strictEqual(response.headers.get('x-yoga'), 'yes')
          deepStrictEqual([...new Uint8Array(await response.arrayBuffer())], BYTES)
        })

        test.it('sends a compressed JSON body as its bytes, with its content-encoding', async () => {
          const response = await rawPost(app, { query: '{ hello(name: "Zoé ✓") }' }, { 'x-gzip': '1' })
          strictEqual(response.status, 200)
          strictEqual(response.headers['content-type'], 'application/json; charset=utf-8')
          strictEqual(response.headers['content-encoding'], 'gzip')
          deepStrictEqual([...response.body.subarray(0, 2)], [0x1f, 0x8b])
          deepStrictEqual(JSON.parse(gunzipSync(response.body).toString('utf8')), { data: { hello: 'Hello Zoé ✓' } })
          deepStrictEqual(response.headers['set-cookie'], ['first=1; Path=/', 'second=2; Path=/; HttpOnly'])
        })

        test.it('sends text in another charset as its bytes', async () => {
          const response = await rawPost(app, { query: '{ hello }' }, { 'x-latin1': '1' })
          strictEqual(response.status, 200)
          strictEqual(response.headers['content-type'], 'text/plain; charset=iso-8859-1')
          deepStrictEqual([...response.body], LATIN1)
        })

        test.it(
          'streams the events of a subscription as they come, and ends the source when the client leaves',
          async () => {
            observed.ended.length = 0
            const response = await post(
              app,
              { query: 'subscription { bookAdded { title } }' },
              { accept: 'text/event-stream' },
            )
            strictEqual(response.status, 200)
            ok(response.headers.get('content-type')?.startsWith('text/event-stream'))
            strictEqual(response.headers.get('content-length'), null)
            deepStrictEqual(response.headers.getSetCookie(), ['first=1; Path=/', 'second=2; Path=/; HttpOnly'])
            const reader = (response.body as ReadableStream<Uint8Array>).getReader() as Reader
            // the event of a mutation sent once the stream is open: nothing waits for the end of the stream
            await post(app, { query: 'mutation { addBook(title: "Endymion") { title } }' })
            ok((await readUntil(reader, 'Endymion')).includes('"bookAdded":{"title":"Endymion"}'))
            await reader.cancel()

            const forever = await post(app, { query: 'subscription { forever }' }, { accept: 'text/event-stream' })
            const events = (forever.body as ReadableStream<Uint8Array>).getReader() as Reader
            await readUntil(events, '"forever":2')
            await events.cancel()
            await until(() => observed.ended.includes('forever'), 'the end of the source')
          },
        )
      })
    }
  })
}
