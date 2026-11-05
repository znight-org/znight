/**
 * The driver contract (RFC 0009 §4.3–§4.10): the `driver` option and its validation, the routes of
 * a route-mounted driver in `HttpPlugin`'s pipeline (meta, guards, body limit, request scope), its
 * lifecycle (start in `onBootstrap`, stop in `onStop` after the engine's streams), and what an
 * operation that came through a driver sees (`GraphQLContext.http`, `serverContext`, the hook).
 * The driver is `graphql-http`'s handler on the engine (`support/graphql-http-driver.ts`).
 */
import type { GraphQLOperationEvent, ZnightError } from '@znight/core'
import type { CanActivate, HttpContext } from '@znight/http'
import type { GraphQLContext, GraphQLDriver, GraphQLPluginOptions } from '../src/index.ts'
import type { GraphQLHttpServerContext } from './support/graphql-http-driver.ts'

import { Application } from '@znight/core'
import { HttpPlugin } from '@znight/http'
import { TestApp } from '@znight/testing'

import { GraphQLPlugin } from '../src/index.ts'
import { resolveGraphQLOptions } from '../src/options.ts'
import { executeOperation } from '../src/testing.ts'
import { bind, captureLogger, field, graphqlMetadata } from './support/app.ts'
import { graphqlHttpDriver } from './support/graphql-http-driver.ts'
import { HTTP_EXTERNALS } from './support/library.ts'
import { describe, expect, it } from 'bun:test'

let seen: GraphQLContext | undefined

class Library {
  hello(args: { name?: string | null }, _parent: unknown, ctx: GraphQLContext): string {
    seen = ctx
    return `Hello ${args.name ?? 'world'}`
  }
  async *ticks(_args: unknown, _parent: unknown, ctx: GraphQLContext): AsyncGenerator<number> {
    for (let n = 1; !ctx.signal.aborted; n++) {
      yield n
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
}

class Deny implements CanActivate {
  canActivate(ctx: HttpContext): boolean {
    return ctx.header('x-allow') === 'yes'
  }
}

function metadata() {
  return graphqlMetadata({
    providers: [Library],
    types: [
      {
        kind: 'object',
        name: 'Query',
        fields: [field('hello', 'String!', bind(Library, 'hello'), { args: [{ name: 'name', type: 'String' }] })],
      },
      {
        kind: 'object',
        name: 'Subscription',
        fields: [field('ticks', 'Int!', bind(Library, 'ticks', { operation: 'subscription' }))],
      },
    ],
    externals: HTTP_EXTERNALS,
  })
}

function create(options: GraphQLPluginOptions, prefix?: string): Promise<TestApp> {
  return TestApp.create({
    metadata: metadata(),
    plugins: [
      HttpPlugin.configure({ port: 0, ...(prefix === undefined ? {} : { prefix }) }),
      GraphQLPlugin.configure(options),
    ],
    logger: captureLogger(),
  })
}

function post(app: TestApp, body: unknown, headers: Record<string, string> = {}, url = '/graphql') {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', accept: 'application/graphql-response+json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

/** The ZNIGHT066 message of a boot that fails. */
async function bootError(options: GraphQLPluginOptions, plugins = true): Promise<ZnightError> {
  try {
    const app = await Application.create({
      metadata: metadata(),
      plugins: [...(plugins ? [HttpPlugin.configure({ port: 0 })] : []), GraphQLPlugin.configure(options)],
      logger: captureLogger(),
      shutdown: { signals: false },
    })
    await app.stop()
  } catch (error) {
    return error as ZnightError
  }
  throw new Error('the boot succeeded')
}

describe('the driver option', () => {
  it('accepts a driver and refuses what is not one (ZNIGHT066)', () => {
    const driver = graphqlHttpDriver()
    expect(resolveGraphQLOptions({ driver }, {}).driver).toBe(driver)
    for (const [value, message] of [
      ['yoga', /invalid option driver: expected a GraphQL driver/],
      [{ start() {} }, /with a name/],
      [{ name: 'builtin', start() {} }, /invalid option driver.name: expected a name other than 'builtin'/],
      [{ name: 'x' }, /with a start\(\) method/],
      [{ name: 'x', start() {}, routes: [] }, /invalid option driver.routes: expected a function/],
      [{ name: 'x', start() {}, stop: true }, /invalid option driver.stop: expected a function/],
    ] as const) {
      expect(() => resolveGraphQLOptions({ driver: value }, {})).toThrow(message)
    }
  })

  it('refuses the SSE options of the built-in transport with a driver', () => {
    expect(() =>
      resolveGraphQLOptions({ driver: graphqlHttpDriver(), subscriptions: { heartbeat: 5_000 } }, {}),
    ).toThrow(
      'ZNIGHT066: GraphQLPlugin: subscriptions.heartbeat configures the built-in SSE transport, not the graphql-http driver',
    )
    expect(() =>
      resolveGraphQLOptions({ driver: graphqlHttpDriver(), subscriptions: { maxDuration: 60_000 } }, {}),
    ).toThrow(/subscriptions.maxDuration configures the built-in SSE transport/)
    expect(resolveGraphQLOptions({ driver: graphqlHttpDriver(), subscriptions: { maxActive: 5 } }, {})).toMatchObject({
      subscriptions: { maxActive: 5 },
    })
  })

  it('refuses a route-mounted driver with http: false', async () => {
    const error = await bootError({ driver: graphqlHttpDriver(), http: false }, false)
    expect(error.message).toBe(
      'ZNIGHT066: GraphQLPlugin: the graphql-http driver serves routes, which http: false turns off',
    )
  })

  it('wraps a driver that fails to start (ZNIGHT066, the original error as cause)', async () => {
    const failure = new Error('no port left')
    for (const start of [
      () => {
        throw failure
      },
      () => Promise.reject(failure),
    ]) {
      const error = await bootError({ driver: { name: 'broken', start } })
      expect(error.message).toBe('ZNIGHT066: GraphQLPlugin: the broken driver failed to start')
      expect(error.cause).toBe(failure)
    }
  })

  it('starts a server-mounted driver (no routes), with http: false too', async () => {
    const started: string[] = []
    const driver: GraphQLDriver = {
      name: 'mounted',
      async start(engine, context) {
        await Promise.resolve()
        started.push(`${engine.settings.path} ${context.http === undefined ? 'no http' : 'http'}`)
      },
    }
    const app = await Application.create({
      metadata: metadata(),
      plugins: [GraphQLPlugin.configure({ driver, http: false })],
      logger: captureLogger(),
      shutdown: { signals: false },
    })
    expect(started).toEqual(['/graphql no http'])
    await app.stop()
  })
})

describe('a route-mounted driver', () => {
  it('serves its routes through the HTTP pipeline and calls the engine', async () => {
    const driver = graphqlHttpDriver()
    await using app = await create({ driver })
    const plugin = app.app.getPlugin<GraphQLPlugin>('graphql') as GraphQLPlugin
    expect(driver.events).toEqual(['routes', 'start'])
    expect(driver.engine).toBe(plugin.engine)
    expect(driver.context?.http).toBe(app.app.getPlugin('http'))
    const http = app.app.getPlugin<HttpPlugin>('http') as HttpPlugin
    expect(http.routes.filter(route => route.path === '/graphql').map(route => [route.method, route.handler])).toEqual([
      ['HEAD', 'graphqlHttp'],
      ['GET', 'graphqlHttp'],
      ['POST', 'graphqlHttp'],
    ])
    const res = await post(app, { query: '{ hello }' }, { 'x-request-id': 'req-42' })
    expect(res.status).toBe(200)
    expect(res.json()).toEqual({ data: { hello: 'Hello world' } })
    // GET queries, answered by graphql-http
    const get = await app.inject({ method: 'GET', url: '/graphql', query: { query: '{ hello(name: "Ada") }' } })
    expect(get.json()).toEqual({ data: { hello: 'Hello Ada' } })
  })

  it('gives resolvers the request of the route and the server context', async () => {
    await using app = await create({ driver: graphqlHttpDriver() })
    const events: GraphQLOperationEvent[] = []
    app.app.hooks.on('graphql:operation', event => events.push(event))
    await post(app, { query: 'query Hi { hello }' })
    expect(seen?.transport).toBe('http')
    expect(seen?.http).toBeDefined()
    expect(seen?.requestId).toBe(seen?.http?.requestId as string)
    const server = seen?.serverContext as GraphQLHttpServerContext
    expect(server.driver).toBe('graphql-http')
    expect(server.http).toBe(seen?.http as HttpContext)
    expect(events.map(event => [event.operationName, event.driver, event.transport, event.outcome])).toEqual([
      ['Hi', 'graphql-http', 'http', 'success'],
    ])
    expect(events[0]?.requestId).toBe(seen?.requestId as string)
    // a request rejected by the engine's validation is observed too
    await post(app, { query: '{ nope }' })
    expect(events[1]).toMatchObject({ driver: 'graphql-http', outcome: 'rejected' })
  })

  it('applies the http option: meta, guards and body limit', async () => {
    await using app = await create({ driver: graphqlHttpDriver(), http: { guards: [new Deny()], bodyLimit: '1kb' } })
    expect((await post(app, { query: '{ hello }' })).status).toBe(403)
    expect((await post(app, { query: '{ hello }' }, { 'x-allow': 'yes' })).status).toBe(200)
    const large = await post(app, { query: `{ hello(name: "${'x'.repeat(2_000)}") }` }, { 'x-allow': 'yes' })
    expect(large.status).toBe(413)
  })

  it('mounts the routes under the HttpPlugin prefix, and gives the engine the absolute path', async () => {
    const driver = graphqlHttpDriver()
    await using app = await create({ driver, path: '/gql' }, '/api')
    expect(driver.engine?.settings.path).toBe('/api/gql')
    expect((await post(app, { query: '{ hello }' }, {}, '/api/gql')).json()).toEqual({ data: { hello: 'Hello world' } })
  })

  it('works with executeOperation()', async () => {
    await using app = await create({ driver: graphqlHttpDriver() })
    const res = await executeOperation<{ hello: string }>(app, { query: '{ hello(name: "Ada") }' })
    expect(res.status).toBe(200)
    expect(res.data).toEqual({ hello: 'Hello Ada' })
  })

  it('stops when the application is disposed without having started', async () => {
    const driver = graphqlHttpDriver()
    const app = await create({ driver })
    await app.app.stop()
    expect(driver.events).toEqual(['routes', 'start', 'stop'])
  })

  it('stops after the engine ended its subscriptions', async () => {
    const driver = graphqlHttpDriver()
    const app = await create({ driver })
    await app.app.start()
    const plugin = app.app.getPlugin<GraphQLPlugin>('graphql') as GraphQLPlugin
    const engine = plugin.engine
    const stream = await engine.subscribe({ schema: engine.schema, document: engine.parse('subscription { ticks }') })
    expect(plugin.activeSubscriptions).toBe(1)
    let activeAtStop = -1
    const stop = driver.stop?.bind(driver)
    ;(driver as { stop?: () => void }).stop = () => {
      activeAtStop = plugin.activeSubscriptions
      stop?.()
    }
    await app.app.stop()
    expect(activeAtStop).toBe(0)
    expect(driver.events).toEqual(['routes', 'start', 'stop'])
    if (Symbol.asyncIterator in stream) expect((await stream.next()).done).toBe(true)
  })
})
