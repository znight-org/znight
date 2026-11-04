/**
 * The Yoga driver (`@znight/graphql/yoga`, RFC 0009 §5.1): its options (what the engine owns is
 * refused), Yoga's context (`yogaContext()`), the engine as Yoga's parse, validate, execute and
 * subscribe (one document cache, masking once), Envelop plugins wrapping the execution (kept) or
 * replacing it (refused), GraphiQL and `GET`, the request id, and its lifecycle (`yoga.dispose()`).
 * The scenarios shared with the built-in transport are in `drivers/conformance.test.ts`.
 */
import type { GraphQLOperationEvent, ZnightError } from '@znight/core'
import type { ExecutionArgs } from 'graphql'
import type { Plugin as YogaPlugin } from 'graphql-yoga'
import type { GraphQLContext, GraphQLPluginOptions } from '../src/index.ts'

import { HttpPlugin } from '@znight/http'
import { TestApp } from '@znight/testing'
import { execute } from 'graphql'

import { GraphQLPlugin } from '../src/index.ts'
import { resolveGraphQLOptions } from '../src/options.ts'
import { executeOperation, subscribeOperation } from '../src/testing.ts'
import { yogaContext, yogaDriver } from '../src/yoga.ts'
import { bind, captureLogger, field, graphqlMetadata } from './support/app.ts'
import { HTTP_EXTERNALS } from './support/library.ts'
import { describe, expect, it } from 'bun:test'

const seen: GraphQLContext[] = []

class Library {
  hello(args: { name?: string | null }, _parent: unknown, ctx: GraphQLContext): string {
    seen.push(ctx)
    return `Hello ${args.name ?? 'world'}`
  }
  fail(): string {
    throw new Error('postgres://secret')
  }
  async *ticks(_args: unknown, _parent: unknown, ctx: GraphQLContext): AsyncGenerator<number> {
    seen.push(ctx)
    for (let n = 1; n <= 2; n++) yield await Promise.resolve(n)
  }
}

function metadata() {
  return graphqlMetadata({
    providers: [Library],
    types: [
      {
        kind: 'object',
        name: 'Query',
        fields: [
          field('hello', 'String!', bind(Library, 'hello'), { args: [{ name: 'name', type: 'String' }] }),
          field('fail', 'String', bind(Library, 'fail')),
        ],
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

function create(options: GraphQLPluginOptions, logger = captureLogger()): Promise<TestApp> {
  return TestApp.create({
    metadata: metadata(),
    plugins: [HttpPlugin.configure({ port: 0 }), GraphQLPlugin.configure(options)],
    logger,
  })
}

function post(app: TestApp, query: string, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json', accept: 'application/graphql-response+json', ...headers },
    body: JSON.stringify({ query }),
  })
}

function thrown(run: () => unknown): ZnightError {
  try {
    run()
  } catch (error) {
    return error as ZnightError
  }
  throw new Error('did not throw')
}

describe('yogaDriver()', () => {
  it('is a driver for the driver option', () => {
    const driver = yogaDriver()
    expect(driver.name).toBe('yoga')
    expect(driver.yoga).toBeUndefined()
    expect(resolveGraphQLOptions({ driver }, {}).driver).toBe(driver)
  })

  it('refuses the options the engine, GraphQLPlugin or HttpPlugin own (ZNIGHT066)', () => {
    for (const [key, hint] of [
      ['schema', 'the engine serves the schema GraphQLPlugin built'],
      ['context', "resolvers get GraphQLContext; read Yoga's context with yogaContext(ctx)"],
      ['graphqlEndpoint', 'set the path option of GraphQLPlugin'],
      ['maskedErrors', 'the engine masks errors once (exposeErrors, errorMappers)'],
      ['cors', 'set the cors option of HttpPlugin'],
      ['maxRequestBodySize', 'set http.bodyLimit of GraphQLPlugin'],
      ['parserAndValidationCache', 'the engine caches documents (the documentCache option of GraphQLPlugin)'],
    ] as const) {
      const error = thrown(() => yogaDriver({ [key]: true } as never))
      expect(error.message).toBe(`ZNIGHT066: yogaDriver(): the ${key} option of Yoga is not available with Znight`)
      expect(error.hints).toEqual([hint])
    }
    expect(thrown(() => yogaDriver({ graphiql: true } as never)).message).toBe(
      "ZNIGHT066: yogaDriver(): graphiql takes GraphiQL's options",
    )
    expect(thrown(() => yogaDriver({ plugins: {} } as never)).message).toContain('plugins must be an array')
    expect(thrown(() => yogaDriver(null as never)).message).toContain('expected an options object')
  })

  it('serves one application at a time, and another once stopped', async () => {
    const driver = yogaDriver()
    const first = await create({ driver })
    expect(driver.yoga).toBeDefined()
    let error: unknown
    try {
      await create({ driver })
    } catch (failure) {
      error = failure
    }
    expect((error as ZnightError).message).toBe('ZNIGHT066: GraphQLPlugin: the yoga driver failed to start')
    expect(((error as ZnightError).cause as Error).message).toContain('this driver already serves an application')
    await first.close()
    expect(driver.yoga).toBeUndefined()
    await using second = await create({ driver })
    expect((await executeOperation(second, { query: '{ hello }' })).data).toEqual({ hello: 'Hello world' })
  })
})

describe('the Yoga driver', () => {
  it("executes on the engine: GraphQLContext in resolvers, Yoga's context as serverContext", async () => {
    await using app = await create({ driver: yogaDriver() })
    seen.length = 0
    const res = await post(app, 'query Hi { hello(name: "Ada") }', { 'x-request-id': 'req-42' })
    expect(res.status).toBe(200)
    expect(res.json()).toEqual({ data: { hello: 'Hello Ada' } })
    // one request id: HttpPlugin's, given to Yoga too
    expect(res.headers['x-request-id']).toBe('req-42')
    const ctx = seen[0] as GraphQLContext
    expect(ctx.transport).toBe('http')
    expect(ctx.requestId).toBe('req-42')
    const yoga = yogaContext(ctx)
    expect(yoga.znight).toBe(ctx.http as never)
    expect(yoga.params).toMatchObject({ query: 'query Hi { hello(name: "Ada") }' })
    expect(yoga.request).toBeInstanceOf(Request)
  })

  it("parses each text once, through the engine's document cache", async () => {
    await using app = await create({ driver: yogaDriver() })
    seen.length = 0
    await post(app, '{ hello }')
    await post(app, '{ hello }')
    expect(seen).toHaveLength(2)
    expect(seen[0]?.document).toBe(seen[1]?.document as never)
    const plugin = app.app.getPlugin<GraphQLPlugin>('graphql') as GraphQLPlugin
    expect(plugin.engine.parse('{ hello }')).toBe(seen[0]?.document as never)
  })

  it('masks errors once (the engine), and exposes them with exposeErrors', async () => {
    const logs = captureLogger()
    await using masked = await create({ driver: yogaDriver() }, logs)
    expect((await post(masked, '{ fail }')).json()).toEqual({
      data: { fail: null },
      errors: [
        {
          message: 'Unexpected error.',
          locations: [{ line: 1, column: 3 }],
          path: ['fail'],
          extensions: { code: 'INTERNAL_SERVER_ERROR' },
        },
      ],
    })
    // logged once, by the engine
    expect(logs.messages('error').filter(message => message.includes('fail'))).toHaveLength(1)
    await using exposed = await create({ driver: yogaDriver(), exposeErrors: true })
    expect((await post(exposed, '{ fail }')).json()).toMatchObject({ errors: [{ message: 'postgres://secret' }] })
  })

  it('reports operations to the hook with driver yoga, subscriptions over SSE as transport sse', async () => {
    await using app = await create({ driver: yogaDriver() })
    const events: GraphQLOperationEvent[] = []
    app.app.hooks.on('graphql:operation', event => events.push(event))
    await post(app, 'query Hi { hello }')
    await post(app, '{ nope }')
    await using stream = await subscribeOperation(app, { query: 'subscription Ticks { ticks }' })
    expect([(await stream.next()).value, (await stream.next()).value, (await stream.next()).done]).toEqual([
      { data: { ticks: 1 } },
      { data: { ticks: 2 } },
      true,
    ])
    expect(events.map(event => [event.operationName, event.driver, event.transport, event.outcome])).toEqual([
      ['Hi', 'yoga', 'http', 'success'],
      [undefined, 'yoga', 'http', 'rejected'],
      ['Ticks', 'yoga', 'sse', 'success'],
    ])
  })

  it('keeps Envelop plugins that wrap the execution', async () => {
    const wrapping: YogaPlugin = {
      onExecute: ({ executeFn, setExecuteFn }) => {
        setExecuteFn(async (args: ExecutionArgs) => {
          const result = (await executeFn(args)) as Record<string, unknown>
          return { ...result, extensions: { wrapped: true } }
        })
      },
    }
    await using app = await create({ driver: yogaDriver({ plugins: [wrapping] }) })
    expect((await post(app, '{ hello }')).json()).toEqual({
      data: { hello: 'Hello world' },
      extensions: { wrapped: true },
    })
  })

  it('refuses a plugin that executes elsewhere than on the engine (ZNIGHT066, logged once)', async () => {
    const replacing: YogaPlugin = {
      onExecute: ({ setExecuteFn }) => {
        setExecuteFn((args: ExecutionArgs) => execute({ ...args, contextValue: {} }))
      },
    }
    const logs = captureLogger()
    await using app = await create({ driver: yogaDriver({ plugins: [replacing] }) }, logs)
    for (let index = 0; index < 2; index++) {
      expect((await post(app, '{ __typename }')).json()).toEqual({
        errors: [
          {
            message:
              'ZNIGHT066: GraphQLPlugin: a Yoga plugin executed the operation instead of the Znight engine (useGraphQlJit?)',
            extensions: { code: 'INTERNAL_SERVER_ERROR' },
          },
        ],
      })
    }
    expect(logs.messages('error')).toEqual([
      'ZNIGHT066: GraphQLPlugin: a Yoga plugin executed the operation instead of the Znight engine (useGraphQlJit?)',
    ])
  })

  it('serves GraphiQL with the graphiql option, and GET queries unless http.get is off', async () => {
    const page = { accept: 'text/html' }
    await using app = await create({ driver: yogaDriver({ graphiql: { title: 'Library' } }), graphiql: true })
    const ide = await app.inject({ method: 'GET', url: '/graphql', headers: page })
    expect(ide.status).toBe(200)
    expect(ide.headers['content-type']).toContain('text/html')
    expect(ide.body).toContain('<title>Library</title>')
    const get = await app.inject({ method: 'GET', url: '/graphql', query: { query: '{ hello }' } })
    expect(get.json()).toEqual({ data: { hello: 'Hello world' } })

    await using closed = await create({ driver: yogaDriver(), graphiql: false, http: { get: false } })
    const refused = await closed.inject({ method: 'GET', url: '/graphql', query: { query: '{ hello }' } })
    expect(refused.status).toBe(405)
    expect(refused.headers['allow']).toBe('POST')
    expect((await closed.inject({ method: 'GET', url: '/graphql', headers: page })).status).toBe(405)

    await using ideOnly = await create({ driver: yogaDriver(), graphiql: true, http: { get: false } })
    expect((await ideOnly.inject({ method: 'GET', url: '/graphql', headers: page })).status).toBe(200)
    expect((await ideOnly.inject({ method: 'GET', url: '/graphql', query: { query: '{ hello }' } })).status).toBe(405)
  })

  it('disposes Yoga (and its plugins) when the application stops', async () => {
    const disposed: string[] = []
    const plugin: YogaPlugin = { onDispose: () => void disposed.push('plugin') }
    const driver = yogaDriver({ plugins: [plugin] })
    const app = await create({ driver })
    await app.close()
    expect(disposed).toEqual(['plugin'])
    expect(driver.yoga).toBeUndefined()
  })

  it('yogaContext() refuses an operation the Yoga driver did not receive', async () => {
    await using app = await create({})
    seen.length = 0
    await post(app, '{ hello }')
    expect(thrown(() => yogaContext(seen[0] as GraphQLContext)).message).toBe(
      'ZNIGHT066: yogaContext(): the operation was not received by the Yoga driver',
    )
  })
})
