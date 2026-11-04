/**
 * Non-gating micro-benchmark of the GraphQL endpoint through the `HttpPlugin` pipeline (RFC 0005
 * §8.3, §8.12), in process: requests are handed to the handlers `HttpPlugin` registers on its
 * adapter (a recording adapter, no socket, no HTTP parser), and each reply is awaited. What it
 * measures is what Znight adds per request on top of a server: the request scope, the
 * `HttpContext`, the endpoint handler, the executor and the serialisation.
 *
 * Cases, for a cached small query (`{ hello }`, one synchronous resolver):
 *
 * - floor: a controller route answering a constant plain object (`GET`, and `POST` with `@Body()`
 *   and `@HttpCode(200)`), the cheapest JSON request of the pipeline (its fast lane);
 * - bare graphql-js: `execute()` of the parsed document on the same schema, then `JSON.stringify`;
 * - `GraphQLPlugin.execute()`: the executor without HTTP (document cache, context, formatting);
 * - `GraphQLEngine.execute()`: what a driver calls (RFC 0009), on a document the engine parsed and
 *   validated, without HTTP;
 * - the endpoint: `GET /graphql?query=...` and `POST /graphql`, answered as `application/json` and
 *   as `application/graphql-response+json`.
 *
 * Read "endpoint - floor" as the GraphQL cost of a request on the HTTP pipeline, and compare it
 * with the bare graphql-js line. Not run by `bun test` (no `.test.ts` suffix). From
 * `packages/graphql`:
 *
 * ```sh
 * bun --conditions=@znight/source test/bench/http.bench.ts
 * node --conditions=@znight/source test/bench/http.bench.ts
 * ```
 *
 * graphql-js 17.0 creates an `AbortController` per execution and calls `abort()` without a reason
 * when the execution finishes, which builds a `DOMException` (with its stack trace): about 3 µs per
 * operation on Node.js, 0.4 µs on Bun, paid by bare graphql-js as well. `ABORT_REASON=1` patches
 * `AbortController.prototype.abort` in this process to pass a prebuilt reason, which shows the
 * numbers without that cost (what an upstream fix would give).
 */
import type { ProviderClass, ZnightMetadata } from '@znight/core'
import type {
  AdapterHandler,
  AdapterReply,
  AdapterRequest,
  AdapterRoute,
  HttpAdapter,
  HttpControllerDefinition,
  HttpRouteDefinition,
  HttpServerAddress,
} from '@znight/http'

import { Application } from '@znight/core'
import { HttpPlugin } from '@znight/http'
import { testToken } from '@znight/testing'
import { execute, parse } from 'graphql'

import { GraphQLPlugin } from '../../src/index.ts'
import { bind, field, graphqlMetadata } from '../support/app.ts'

if (process.env['ABORT_REASON'] === '1') {
  const abort = AbortController.prototype.abort
  const reason = new Error('This operation was aborted')
  AbortController.prototype.abort = function (this: AbortController, given?: unknown): void {
    abort.call(this, given === undefined ? reason : given)
  }
}

const QUERY = '{ hello }'
const RESULT = { data: { hello: 'Hello world' } }
const BODY = JSON.stringify({ query: QUERY })
const GRAPHQL_RESPONSE = 'application/graphql-response+json'

class Greeter {
  hello(): string {
    return 'Hello world'
  }
}

/** The floor: a controller answering a constant (what a compiled `@Controller` generates). */
class Floor {
  get(): unknown {
    return RESULT
  }
  post(): unknown {
    return RESULT
  }
}

function route(handler: 'get' | 'post', extra: Partial<HttpRouteDefinition> = {}): HttpRouteDefinition {
  return {
    method: 'GET',
    path: '/floor',
    fullPath: '/floor',
    handler,
    meta: {},
    guards: [],
    interceptors: [],
    params: [],
    invoke: (controller: Floor) => controller[handler](),
    ...extra,
  }
}

const FLOOR: HttpControllerDefinition = {
  token: testToken(Floor),
  basePath: '/',
  guards: [],
  interceptors: [],
  meta: {},
  routes: [
    route('get'),
    // `@Post() @HttpCode(200) post(@Body() body: unknown)`: the body is read and parsed
    route('post', { method: 'POST', status: 200, params: [{ index: 0, source: 'body' }] }),
  ],
}

function benchMetadata(): ZnightMetadata {
  const metadata = graphqlMetadata({
    providers: [Greeter, Floor as unknown as ProviderClass],
    types: [{ kind: 'object', name: 'Query', fields: [field('hello', 'String!', bind(Greeter, 'hello'))] }],
    externals: [
      { token: '@znight/http#HttpContext', scope: 'request', providedBy: 'HttpPlugin' },
      { token: '@znight/http#RequestId', scope: 'request', providedBy: 'HttpPlugin' },
    ],
  })
  return { ...metadata, extensions: { ...metadata.extensions, http: { controllers: [FLOOR] } } }
}

/** An adapter keeping the handlers `HttpPlugin` registers: requests are handed to them directly. */
class RecordingAdapter implements HttpAdapter {
  readonly name = 'recording'
  readonly #routes: AdapterRoute[] = []

  registerRoute(route: AdapterRoute): void {
    this.#routes.push(route)
  }

  setFallbackHandler(): void {}

  listen(port: number, host: string): Promise<HttpServerAddress> {
    const url = `http://${host}:${port}`
    return Promise.resolve({ host, port, family: 'IPv4', url, toString: () => url })
  }

  async close(): Promise<void> {}

  inject(): Promise<never> {
    return Promise.reject(new Error('not supported'))
  }

  handler(method: string, path: string): AdapterHandler {
    const found = this.#routes.find(route => route.method === method && route.path.path === path)
    if (found === undefined) throw new Error(`no route ${method} ${path}`)
    return found.handler
  }
}

/** An adapter request; the body bytes are encoded once, like a server that read them. */
function request(method: string, url: string, headers: Record<string, string>, body?: string): AdapterRequest {
  const bytes = body === undefined ? undefined : new TextEncoder().encode(body)
  const all: Record<string, string> = { host: 'localhost', ...headers }
  if (bytes !== undefined) all['content-length'] = String(bytes.byteLength)
  return {
    method,
    url,
    headers: all,
    ip: '127.0.0.1',
    remoteAddress: '127.0.0.1',
    raw: undefined,
    rawResponse: undefined,
    readBody: () => Promise.resolve(bytes ?? new Uint8Array(0)),
    hasBody: () => bytes !== undefined,
  }
}

type Case = readonly [name: string, run: () => unknown]

async function measure(run: () => unknown, iterations: number): Promise<number> {
  const start = performance.now()
  for (let index = 0; index < iterations; index++) await run()
  return ((performance.now() - start) * 1e6) / iterations
}

const median = (values: readonly number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0

/** Warm-up, then interleaved rounds (a slow round hits every case alike): the median per case, in ns. */
async function bench(cases: readonly Case[], iterations: number, rounds: number): Promise<Map<string, number>> {
  for (const [, run] of cases) await measure(run, iterations)
  const samples = new Map<string, number[]>(cases.map(([name]) => [name, []]))
  for (let round = 0; round < rounds; round++) {
    for (const [name, run] of cases) samples.get(name)?.push(await measure(run, iterations))
  }
  return new Map([...samples].map(([name, values]) => [name, median(values)]))
}

/** Checks a reply once before measuring: the benchmark must measure correct answers. */
function check(name: string, reply: AdapterReply, status: number, type: string): void {
  const body = reply.body instanceof Uint8Array ? new TextDecoder().decode(reply.body) : String(reply.text)
  const contentType = String(reply.headers['content-type'])
  if (reply.status !== status || !contentType.startsWith(type) || JSON.parse(body).data?.hello !== 'Hello world') {
    throw new Error(`${name}: unexpected reply ${reply.status} ${contentType} ${body}`)
  }
}

const adapter = new RecordingAdapter()
const app = await Application.create({
  metadata: benchMetadata(),
  plugins: [HttpPlugin.configure({ port: 0, adapter }), GraphQLPlugin.configure()],
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  shutdown: { signals: false },
})
const graphql = app.getPlugin<GraphQLPlugin>('graphql') as GraphQLPlugin

const schema = graphql.schema
const document = parse(QUERY)
const engine = graphql.engine
const engineDocument = engine.parse(QUERY)
if (engine.validate(schema, engineDocument).length > 0) throw new Error('the engine refused the query')
const getFloor = adapter.handler('GET', '/floor')
const postFloor = adapter.handler('POST', '/floor')
const getGraphQL = adapter.handler('GET', '/graphql')
const postGraphQL = adapter.handler('POST', '/graphql')

const json = { 'content-type': 'application/json' }
const target = `/graphql?query=${encodeURIComponent(QUERY)}`
const requests = {
  getFloor: request('GET', '/floor', {}),
  postFloor: request('POST', '/floor', json, BODY),
  get: request('GET', target, {}),
  getGraphQL: request('GET', target, { accept: GRAPHQL_RESPONSE }),
  post: request('POST', '/graphql', json, BODY),
  postGraphQL: request('POST', '/graphql', { ...json, accept: GRAPHQL_RESPONSE }, BODY),
}

check('GET /floor', await getFloor(requests.getFloor), 200, 'application/json')
check('POST /floor', await postFloor(requests.postFloor), 200, 'application/json')
check('GET /graphql', await getGraphQL(requests.get), 200, 'application/json')
check('GET /graphql (graphql-response)', await getGraphQL(requests.getGraphQL), 200, GRAPHQL_RESPONSE)
check('POST /graphql', await postGraphQL(requests.post), 200, 'application/json')
check('POST /graphql (graphql-response)', await postGraphQL(requests.postGraphQL), 200, GRAPHQL_RESPONSE)

const results = await bench(
  [
    ['graphql-js execute() + JSON.stringify (bare)', () => JSON.stringify(execute({ schema, document }))],
    ['GraphQLPlugin.execute() (no HTTP)', () => graphql.execute({ query: QUERY })],
    ['GraphQLEngine.execute() (no HTTP, a driver)', () => engine.execute({ schema, document: engineDocument })],
    ['GET  /floor (controller, plain object)', () => getFloor(requests.getFloor)],
    ['GET  /graphql application/json', () => getGraphQL(requests.get)],
    ['GET  /graphql application/graphql-response+json', () => getGraphQL(requests.getGraphQL)],
    ['POST /floor (controller, @Body, @HttpCode(200))', () => postFloor(requests.postFloor)],
    ['POST /graphql application/json', () => postGraphQL(requests.post)],
    ['POST /graphql application/graphql-response+json', () => postGraphQL(requests.postGraphQL)],
  ],
  20_000,
  9,
)
await app.stop()

const runtime = typeof Bun === 'undefined' ? `Node.js ${process.version}` : `Bun ${Bun.version}`
const patched = process.env['ABORT_REASON'] === '1' ? ', ABORT_REASON=1' : ''
console.log(`${runtime}${patched}: ${QUERY} through the HttpPlugin pipeline (in process, median ns per request)`)
const floors: Record<string, number | undefined> = {
  GET: results.get('GET  /floor (controller, plain object)'),
  POST: results.get('POST /floor (controller, @Body, @HttpCode(200))'),
}
for (const [name, ns] of results) {
  const method = name.slice(0, 4).trim()
  const floor = name.includes('/graphql') ? floors[method] : undefined
  const extra = floor === undefined ? '' : `  (floor +${Math.round(ns - floor)})`
  console.log(`  ${name.padEnd(50)} ${String(Math.round(ns)).padStart(6)} ns${extra}`)
}
