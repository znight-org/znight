import { Application, ErrorCode } from '@znight/core'
import { HttpPlugin } from '@znight/http'

import { GraphQLPlugin, GraphQLTokens, MemoryPubSub, PubSub } from '../src/index.ts'
import { resolveGraphQLOptions } from '../src/options.ts'
import { bind, boot, captureLogger, field, graphqlMetadata } from './support/app.ts'
import { describe, expect, it } from 'bun:test'

class Hello {
  hello(): string {
    return 'hi'
  }
}

class Guard {
  canResolve(): boolean {
    return true
  }
}

class Mapper {
  map(): undefined {
    return undefined
  }
}

const metadata = () =>
  graphqlMetadata({
    providers: [Hello, Guard, Mapper],
    types: [
      {
        kind: 'object',
        name: 'Query',
        fields: [field('hello', 'String', bind(Hello, 'hello', { guards: [Guard], loaders: ['test#Loader'] }))],
      },
    ],
  })

describe('GraphQLPlugin options', () => {
  it('applies the defaults of RFC 0005 §5.11', () => {
    expect(resolveGraphQLOptions({}, {})).toEqual({
      path: '/graphql',
      http: { meta: [], guards: [], bodyLimit: '100kb', get: true },
      guards: [],
      errorMappers: [],
      exposeErrors: false,
      introspection: true,
      graphiql: false,
      limits: { maxTokens: 2000, maxDepth: 12, maxAliases: 30, maxDirectives: 50 },
      documentCache: 1000,
      subscriptions: { maxActive: 10_000, bufferSize: 100, heartbeat: undefined, maxDuration: undefined },
      bufferSize: 100,
      pubsub: undefined,
      enforcement: 'error',
    })
    expect(resolveGraphQLOptions({}, { NODE_ENV: 'production' })).toMatchObject({
      introspection: false,
      graphiql: false,
    })
    expect(resolveGraphQLOptions({}, { NODE_ENV: 'development' })).toMatchObject({
      introspection: true,
      graphiql: true,
    })
    expect(resolveGraphQLOptions({ http: false, subscriptions: false, limits: { maxDepth: false } }, {})).toMatchObject(
      {
        http: false,
        subscriptions: false,
        limits: { maxDepth: undefined },
      },
    )
  })

  it('rejects invalid options with ZNIGHT066', () => {
    for (const options of [
      null,
      { pth: '/graphql' },
      { path: 'graphql' },
      { http: { bodyLimit: 'lots' } },
      { http: { meta: [{}] } },
      { http: { get: 'yes' } },
      { guards: [42] },
      { errorMappers: [{}] },
      { limits: { maxDepth: 0 } },
      { limits: { maxCost: 1 } },
      { documentCache: -1 },
      { subscriptions: { maxActive: 1.5 } },
      { subscriptions: { heartbeat: -1 } },
      { pubsub: {} },
      { enforcement: 'strict' },
      { exposeErrors: 1 },
    ]) {
      expect(() => resolveGraphQLOptions(options, {})).toThrow(
        expect.objectContaining({ code: ErrorCode.InvalidGraphQLSetup }),
      )
    }
  })
})

describe('GraphQLPlugin lifecycle', () => {
  it('provides GraphQLContext, PubSub and itself, and logs when ready', async () => {
    await using booted = await boot(metadata())
    expect(booted.app.container.get(GraphQLTokens.Plugin)).toBe(booted.plugin)
    expect(booted.app.container.get(GraphQLTokens.PubSub)).toBeInstanceOf(MemoryPubSub)
    expect(booted.plugin.pubsub).toBe(booted.app.container.get(GraphQLTokens.PubSub))
    expect(() => booted.app.container.get(GraphQLTokens.Context)).toThrow(
      expect.objectContaining({ code: ErrorCode.NoActiveScope }),
    )
    await booted.app.start()
    expect(booted.logs.entries.find(entry => entry.message === 'GraphQL schema ready')?.context).toEqual({
      types: 1,
      schemaHash: '0123456789abcdef',
    })
  })

  it('delegates PubSub when the options are a function of the container', async () => {
    const own = new MemoryPubSub()
    await using booted = await boot(metadata(), () => ({ pubsub: own }))
    const provided = booted.app.container.get(GraphQLTokens.PubSub)
    expect(provided).toBeInstanceOf(PubSub)
    const events = own.subscribe('x')
    await provided.publish('x', 1)
    expect((await events.next()).value).toBe(1)
    own.close()
  })

  it('refuses a second application while one runs (ZNIGHT004)', async () => {
    const plugin = GraphQLPlugin.configure({ http: false })
    const app = await Application.create({
      metadata: metadata(),
      plugins: [plugin],
      logger: captureLogger(),
      shutdown: { signals: false },
    })
    await expect(
      Application.create({
        metadata: metadata(),
        plugins: [plugin],
        logger: captureLogger(),
        shutdown: { signals: false },
      }),
    ).rejects.toMatchObject({ code: ErrorCode.DuplicateProvider })
    await app.stop()
    // once stopped, the instance serves another application
    const again = await Application.create({
      metadata: metadata(),
      plugins: [plugin],
      logger: captureLogger(),
      shutdown: { signals: false },
    })
    expect(await plugin.execute({ query: '{ hello }' })).toEqual({ data: { hello: 'hi' } })
    await again.stop()
  })

  it('needs HttpPlugin with the HTTP transport (ZNIGHT066)', async () => {
    const create = (options: Parameters<typeof GraphQLPlugin.configure>[0], plugins: readonly HttpPlugin[] = []) =>
      Application.create({
        metadata: metadata(),
        plugins: [...plugins, GraphQLPlugin.configure(options)],
        logger: captureLogger(),
        shutdown: { signals: false },
      })
    await expect(create({})).rejects.toMatchObject({ code: ErrorCode.InvalidGraphQLSetup })
    await expect(create(() => ({}))).rejects.toMatchObject({ code: ErrorCode.InvalidGraphQLSetup })
    const app = await create({}, [HttpPlugin.configure({ port: 0 })])
    expect(app.getPlugin<GraphQLPlugin>('graphql')?.httpRoutes({ prefix: '', container: app.container })).toEqual([])
    await app.stop()
  })

  it('is not usable before bootstrap', () => {
    const plugin = GraphQLPlugin.configure({ http: false })
    expect(() => plugin.schema).toThrow(expect.objectContaining({ code: ErrorCode.LifecycleFailed }))
    expect(() => plugin.execute({ query: '{ hello }' })).toThrow(
      expect.objectContaining({ code: ErrorCode.LifecycleFailed }),
    )
    expect(plugin.activeSubscriptions).toBe(0)
  })

  it('lists its roots for TestApp: option classes and the providers of the metadata', () => {
    const plugin = GraphQLPlugin.configure({ guards: [Guard, new Guard()], errorMappers: [Mapper] })
    expect(plugin.initRoots({ metadata: metadata() })).toEqual([
      Guard,
      Mapper,
      'test#Hello',
      'test#Guard',
      'test#Loader',
    ])
    expect(GraphQLPlugin.configure(() => ({})).initRoots({ metadata: { ...metadata(), extensions: {} } })).toEqual([])
  })
})
