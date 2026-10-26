/**
 * Runtime check executed by `test/runtime.test.ts` with Node.js (`node --conditions=@znight/source`)
 * and Bun: boots the same application on every adapter, sends requests over the network and in
 * memory, and prints the observed responses as JSON.
 */
import type { HttpAdapter, HttpContext, HttpRouteDefinition, InjectRequest } from '../../src/index.ts'

import { Application, silentLogger, type ZnightMetadata } from '@znight/core'
import { z } from 'zod'

import { expressAdapter } from '../../src/adapters/express.ts'
import { fastifyAdapter } from '../../src/adapters/fastify.ts'
import { honoAdapter } from '../../src/adapters/hono.ts'
import { nodeAdapter } from '../../src/adapters/node.ts'
import { coerce, HttpPlugin, validate } from '../../src/index.ts'

const CreateItem = z.object({ name: z.string().min(1), qty: z.number().int().default(1) })

class ItemsController {
  get(id: number) {
    return { id, runtime: typeof (globalThis as { Bun?: unknown }).Bun === 'undefined' ? 'node' : 'bun' }
  }
  create(input: z.output<typeof CreateItem>) {
    return input
  }
  stream() {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('a'))
        controller.enqueue(new TextEncoder().encode('b'))
        controller.close()
      },
    })
  }
  ctx(ctx: HttpContext) {
    return { adapter: ctx.adapter, route: ctx.route?.path }
  }
  async slow() {
    gate.started()
    await gate.wait
    return 'slow done'
  }
}

/** Lets the shutdown scenarios hold a request in flight. */
const gate = {
  started: (): void => undefined,
  wait: Promise.resolve(),
  release: (): void => undefined,
  reset(): Promise<void> {
    const started = new Promise<void>(resolve => {
      this.started = resolve
    })
    this.wait = new Promise<void>(resolve => {
      this.release = resolve
    })
    return started
  },
}

const TOKEN = 'src/items.ts#ItemsController'

function route(
  handler: string,
  method: HttpRouteDefinition['method'],
  path: string,
  invoke: HttpRouteDefinition['invoke'],
): HttpRouteDefinition {
  return {
    method,
    path,
    fullPath: `/items${path === '/' ? '' : path}`,
    handler,
    meta: {},
    guards: [],
    interceptors: [],
    params: [],
    invoke,
  }
}

const metadata: ZnightMetadata = {
  version: 1,
  providers: {
    [TOKEN]: { scope: 'singleton', class: ItemsController, deps: [], factory: () => new ItemsController() },
  },
  resolutionOrder: [TOKEN],
  extensions: {
    http: {
      controllers: [
        {
          token: TOKEN,
          basePath: '/items',
          guards: [],
          interceptors: [],
          meta: {},
          routes: [
            route('get', 'GET', '/:id', (c: ItemsController, ctx) =>
              c.get(coerce.number(ctx.params['id'], 'param "id"')),
            ),
            {
              ...route('create', 'POST', '/', async (c: ItemsController, ctx) =>
                c.create(await validate(CreateItem, ctx.body, 'body')),
              ),
              params: [{ index: 0, source: 'body', schema: true }],
            },
            route('stream', 'GET', '/stream', (c: ItemsController) => c.stream()),
            route('ctx', 'GET', '/ctx', (c: ItemsController, ctx) => c.ctx(ctx)),
            route('slow', 'GET', '/slow', (c: ItemsController) => c.slow()),
          ],
        },
      ],
    },
  },
}

const REQUESTS: readonly InjectRequest[] = [
  { method: 'GET', url: '/items/42' },
  { method: 'GET', url: '/items/abc' },
  { method: 'POST', url: '/items', body: { name: 'pen' } },
  { method: 'POST', url: '/items', body: { name: '' } },
  { method: 'POST', url: '/items', body: '{"name":', headers: { 'content-type': 'application/json' } },
  { method: 'HEAD', url: '/items/42' },
  { method: 'GET', url: '/items/stream' },
  { method: 'GET', url: '/items/ctx' },
  { method: 'DELETE', url: '/items/1' },
  { method: 'GET', url: '/nope' },
]

const ADAPTERS = { node: nodeAdapter, fastify: fastifyAdapter, express: expressAdapter, hono: honoAdapter }

interface Observed {
  readonly status: number
  readonly body: string
  readonly allow?: string
  readonly contentLength?: string
}

interface Shutdown {
  /** The in-flight request completed while the server was draining. */
  readonly drained: string
  /** A new connection was refused during the drain. */
  readonly refused: boolean
  /** The in-flight request was aborted after `drainTimeoutMs`. */
  readonly forced: string
}

async function shutdown(create: () => HttpAdapter): Promise<Shutdown> {
  const start = async (drainTimeoutMs: number) => {
    const http = HttpPlugin.configure({ adapter: create(), port: 0, host: '127.0.0.1', drainTimeoutMs })
    const app = await Application.create({
      metadata,
      plugins: [http],
      logger: silentLogger,
      shutdown: { signals: false },
    })
    await app.start()
    return { app, url: String(http.address) }
  }
  // graceful: the in-flight request completes
  const graceful = await start(5_000)
  let started = gate.reset()
  const pending = fetch(`${graceful.url}/items/slow`).then(response => response.text())
  await started
  const stopping = graceful.app.stop()
  await new Promise(resolve => setTimeout(resolve, 50))
  const refused = await fetch(`${graceful.url}/items/1`).then(
    () => false,
    () => true,
  )
  gate.release()
  const drained = await pending
  await stopping
  // forced: the in-flight request is aborted after the timeout
  const forced = await start(100)
  started = gate.reset()
  const aborted = fetch(`${forced.url}/items/slow`).then(
    response => response.text(),
    () => 'aborted',
  )
  await started
  await forced.app.stop()
  const result = await aborted
  gate.release()
  return { drained, refused, forced: result }
}

const results: Record<string, { network: Observed[]; inject: Observed[]; shutdown: Shutdown }> = {}
for (const [name, create] of Object.entries(ADAPTERS)) {
  const http = HttpPlugin.configure({ adapter: create(), port: 0, host: '127.0.0.1' })
  const app = await Application.create({
    metadata,
    plugins: [http],
    logger: silentLogger,
    shutdown: { signals: false },
  })
  await app.start()
  const network: Observed[] = []
  const inject: Observed[] = []
  for (const request of REQUESTS) {
    const headers: Record<string, string> = { ...request.headers }
    let body: string | undefined
    if (request.body !== undefined) {
      body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body)
      headers['content-type'] ??= 'application/json'
    }
    const response = await fetch(`${String(http.address)}${request.url}`, { method: request.method, headers, body })
    network.push(
      observe(
        response.status,
        await response.text(),
        response.headers.get('allow'),
        response.headers.get('content-length'),
      ),
    )
    const injected = await http.inject(request)
    inject.push(observe(injected.status, injected.body, injected.headers['allow'], injected.headers['content-length']))
  }
  await app.stop()
  results[name] = { network, inject, shutdown: await shutdown(create) }
}

function observe(
  status: number,
  body: string,
  allow: string | null | undefined,
  length: string | null | undefined,
): Observed {
  return {
    status,
    body,
    ...(allow == null ? {} : { allow }),
    ...(status === 200 && length != null && body === '' ? { contentLength: length } : {}),
  }
}

process.stdout.write(JSON.stringify(results))
