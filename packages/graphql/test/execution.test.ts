import type { GraphQLOperationEvent } from '@znight/core'
import type { GraphQLContext } from '../src/index.ts'

import { HttpTokens } from '@znight/http'

import { GraphQLTokens } from '../src/index.ts'
import { executorOf } from '../src/plugin.ts'
import { bind, boot, field, graphqlMetadata } from './support/app.ts'
import { describe, expect, it } from 'bun:test'

let seen: GraphQLContext | undefined

/** The context of the last `hello` call. */
function last(): GraphQLContext {
  if (seen === undefined) throw new Error('hello was not called')
  return seen
}

class Library {
  hello(args: { name?: string }, _parent: unknown, ctx: GraphQLContext): string {
    seen = ctx
    return `Hello ${args.name ?? 'world'}`
  }
  async slow(): Promise<string> {
    await new Promise(resolve => setTimeout(resolve, 20))
    return 'slow'
  }
  add(args: { n: number }): number {
    return args.n + 1
  }
}

function metadata() {
  return graphqlMetadata({
    providers: [Library],
    types: [
      {
        kind: 'object',
        name: 'Node',
        fields: [
          { name: 'id', type: 'ID' },
          { name: 'child', type: 'Node' },
        ],
      },
      {
        kind: 'object',
        name: 'Query',
        fields: [
          field('hello', 'String!', bind(Library, 'hello'), { args: [{ name: 'name', type: 'String' }] }),
          field('slow', 'String', bind(Library, 'slow')),
          { name: 'node', type: 'Node', resolver: { ...bind(Library, 'hello'), invoke: () => nest(20) } },
        ],
      },
      {
        kind: 'object',
        name: 'Mutation',
        fields: [
          field('add', 'Int!', bind(Library, 'add', { operation: 'mutation' }), {
            args: [{ name: 'n', type: 'Int!' }],
          }),
        ],
      },
    ],
  })
}

function nest(depth: number): unknown {
  return depth === 0 ? null : { id: String(depth), child: nest(depth - 1) }
}

/** A query `levels` fields deep: `node`, then `child`s, then `id`. */
const deep = (levels: number): string => `{ node ${'{ child '.repeat(levels - 2)}{ id }${' }'.repeat(levels - 2)} }`

describe('execution', () => {
  it('returns synchronous results synchronously, as graphql-js produced them', async () => {
    await using booted = await boot(metadata())
    const result = booted.plugin.execute({ query: '{ hello }' })
    expect(result).not.toBeInstanceOf(Promise)
    expect(result).toEqual({ data: { hello: 'Hello world' } })
    expect(await booted.plugin.execute({ query: '{ slow }' })).toEqual({ data: { slow: 'slow' } })
  })

  it('answers with statuses: 200, 400 for request errors, 405 with queriesOnly', async () => {
    await using booted = await boot(metadata())
    const executor = executorOf(booted.plugin)
    expect(await executor.execute({ query: 'mutation { add(n: 1) }' })).toEqual({
      status: 200,
      result: { data: { add: 2 } },
    })
    const parse = await executor.execute({ query: '{ hello' })
    expect(parse.status).toBe(400)
    expect(parse.result.errors?.[0]?.extensions).toEqual({ code: 'GRAPHQL_PARSE_FAILED' })
    const invalid = await executor.execute({ query: '{ nope }' })
    expect(invalid).toMatchObject({
      status: 400,
      result: { errors: [{ extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] },
    })
    const variables = await executor.execute({ query: 'mutation($n: Int!) { add(n: $n) }', variables: { n: 'x' } })
    expect(variables).toMatchObject({ status: 400, result: { errors: [{ extensions: { code: 'BAD_USER_INPUT' } }] } })
    expect(variables.result.data).toBeUndefined()
    const get = await executor.execute({ query: 'mutation { add(n: 1) }' }, { queriesOnly: true })
    expect(get).toMatchObject({
      status: 405,
      headers: { allow: 'POST' },
      result: { errors: [{ extensions: { code: 'BAD_REQUEST' } }] },
    })
    expect((await executor.execute({ query: '' })).status).toBe(400)
    expect((await executor.execute({ query: 1 } as never)).result.errors?.[0]?.message).toBe('Missing query (a string)')
    expect((await executor.execute({ query: '{ hello }', variables: [] } as never)).status).toBe(400)
  })

  it('selects the operation by name', async () => {
    await using booted = await boot(metadata())
    const executor = executorOf(booted.plugin)
    const query = 'query A { hello } query B { hello(name: "B") }'
    expect((await executor.execute({ query, operationName: 'B' })).result).toEqual({ data: { hello: 'Hello B' } })
    expect((await executor.execute({ query })).result.errors?.[0]?.message).toBe(
      'Must provide operation name if query contains multiple operations.',
    )
    expect((await executor.execute({ query, operationName: 'C' })).result.errors?.[0]?.message).toBe(
      'Unknown operation named "C".',
    )
  })

  it('caches valid documents only, in an LRU bounded by documentCache', async () => {
    await using booted = await boot(metadata(), { documentCache: 2 })
    const executor = executorOf(booted.plugin)
    await executor.execute({ query: '{ nope }' })
    await executor.execute({ query: '{ hello' })
    expect(executor.cachedDocuments).toBe(0)
    await executor.execute({ query: '{ a: hello }' })
    await executor.execute({ query: '{ b: hello }' })
    await executor.execute({ query: '{ a: hello }' })
    await executor.execute({ query: '{ c: hello }' })
    expect(executor.cachedDocuments).toBe(2)
    // the parsed document is shared by the executions of the same text
    await executor.execute({ query: '{ a: hello }' })
    const first = seen?.document
    await executor.execute({ query: '{ a: hello }' })
    expect(seen?.document).toBe(first as never)
  })

  it('bounds the cache by size: long documents are not kept, and the kept text has a budget', async () => {
    await using booted = await boot(metadata())
    const executor = executorOf(booted.plugin)
    // comments do not count toward maxTokens: a valid document can carry most of the body limit
    for (let i = 0; i < 50; i++) {
      const padded = await executor.execute({ query: `{ __typename } #${i}${'x'.repeat(90_000)}` })
      expect(padded.status).toBe(200)
    }
    expect(executor.cachedDocuments).toBe(0)
    // documents just under the per-document limit fill the budget, not 1000 entries
    for (let i = 0; i < 600; i++) {
      await executor.execute({ query: `{ __typename } #${String(i).padStart(4, '0')}${'x'.repeat(16_000)}` })
    }
    expect(executor.cachedCharacters).toBeLessThanOrEqual(8 * 1024 * 1024)
    expect(executor.cachedDocuments).toBeLessThan(600)
    // a short document is still cached and shared afterwards
    await executor.execute({ query: '{ hot: hello }' })
    const first = seen?.document
    await executor.execute({ query: '{ hot: hello }' })
    expect(seen?.document).toBe(first as never)
  })

  it('enforces the limits before validation, without caching the document', async () => {
    await using booted = await boot(metadata(), {
      limits: { maxDepth: 3, maxAliases: 2, maxDirectives: 1, maxTokens: 60 },
    })
    const executor = executorOf(booted.plugin)
    expect((await executor.execute({ query: deep(3) })).status).toBe(200)
    const tooDeep = await executor.execute({ query: deep(4) })
    expect(tooDeep).toMatchObject({
      status: 400,
      result: {
        errors: [
          {
            message: 'The operation is 4 levels deep, more than the limit of 3.',
            extensions: { code: 'QUERY_TOO_COMPLEX' },
          },
        ],
      },
    })
    // fragments count where they are spread; introspection fields are exempt
    const fragment = await executor.execute({
      query: 'query Q { node { ...F } } fragment F on Node { child { child { id } } }',
    })
    expect(fragment.result.errors?.[0]?.message).toBe('The operation Q is 4 levels deep, more than the limit of 3.')
    expect((await executor.execute({ query: '{ __schema { types { fields { type { name } } } } }' })).status).toBe(200)
    const aliases = await executor.execute({ query: '{ a: hello b: hello c: hello }' })
    expect(aliases.result.errors?.[0]?.message).toBe('The document has 3 aliases, more than the limit of 2.')
    const directives = await executor.execute({ query: '{ hello @skip(if: false) @include(if: true) }' })
    expect(directives.result.errors?.[0]?.message).toBe('The document has 2 directives, more than the limit of 1.')
    const tokens = await executor.execute({ query: `{ ${'hello '.repeat(60)}}` })
    expect(tokens.result.errors?.[0]).toMatchObject({ extensions: { code: 'GRAPHQL_PARSE_FAILED' } })
    expect(tokens.result.errors?.[0]?.message).toContain('tokens')
    // deep(3) and the introspection query
    expect(executor.cachedDocuments).toBe(2)
  })

  it('counts the aliases of fragments each time they are spread', async () => {
    await using booted = await boot(metadata(), { limits: { maxAliases: 30, maxDepth: 12 } })
    const executor = executorOf(booted.plugin)
    // F1 → F2 → ... → F10, each with 2 aliased fields spreading the next: 20 written, 2 046 executed,
    // 12 levels deep
    const chain = Array.from({ length: 10 }, (_, index) => {
      const next = index === 9 ? 'id' : `...F${index + 2}`
      return `fragment F${index + 1} on Node { a: child { ${next} } b: child { ${next} } }`
    })
    const bomb = await executor.execute({ query: `query Bomb { node { ...F1 } } ${chain.join(' ')}` })
    expect(bomb).toMatchObject({
      status: 400,
      result: {
        errors: [
          {
            message: 'The operation Bomb has more than 30 aliases once its fragments are expanded.',
            extensions: { code: 'QUERY_TOO_COMPLEX' },
          },
        ],
      },
    })
    // a fragment spread twice counts twice: 2 × 15 = 30 is within the limit, 2 × 16 is not
    const fields = (count: number): string => Array.from({ length: count }, (_, index) => `f${index}: id`).join(' ')
    const within = await executor.execute({
      query: `{ node { ...F child { ...F } } } fragment F on Node { ${fields(15)} }`,
    })
    expect(within.status).toBe(200)
    const over = await executor.execute({
      query: `{ node { ...F child { ...F } } } fragment F on Node { ${fields(16)} }`,
    })
    expect(over.result.errors?.[0]?.message).toBe(
      'The operation has more than 30 aliases once its fragments are expanded.',
    )
    // a fragment cycle stops the count (validation reports it)
    const cycle = await executor.execute({
      query:
        '{ node { ...A } } fragment A on Node { x: id child { ...B } } fragment B on Node { y: id child { ...A } }',
    })
    expect(cycle.result.errors?.[0]?.extensions).toEqual({ code: 'GRAPHQL_VALIDATION_FAILED' })
  })

  it('accepts false to disable a limit', async () => {
    await using booted = await boot(metadata(), { limits: { maxDepth: false } })
    expect((await executorOf(booted.plugin).execute({ query: deep(15) })).status).toBe(200)
  })

  it('turns introspection off, with hidden suggestions', async () => {
    await using open = await boot(metadata())
    const suggested = await open.plugin.execute({ query: '{ helo }' })
    expect(suggested.errors?.[0]?.message).toBe('Cannot query field "helo" on type "Query". Did you mean "hello"?')
    await using closed = await boot(metadata(), { introspection: false })
    const hidden = await closed.plugin.execute({ query: '{ helo }' })
    expect(hidden.errors?.[0]?.message).toBe('Cannot query field "helo" on type "Query".')
    const introspection = await closed.plugin.execute({ query: '{ __schema { queryType { name } } }' })
    expect(introspection.errors?.[0]?.message).toContain('introspection')
    // __typename stays available
    expect(await closed.plugin.execute({ query: '{ __typename }' })).toEqual({ data: { __typename: 'Query' } })
  })

  it('defaults introspection from NODE_ENV', async () => {
    const previous = process.env['NODE_ENV']
    process.env['NODE_ENV'] = 'production'
    try {
      await using booted = await boot(metadata())
      const result = await booted.plugin.execute({ query: '{ __schema { queryType { name } } }' })
      expect(result.errors?.[0]?.extensions?.['code']).toBe('GRAPHQL_VALIDATION_FAILED')
    } finally {
      process.env['NODE_ENV'] = previous
    }
  })

  it('rejects subscriptions without a stream', async () => {
    const meta = graphqlMetadata({
      providers: [Library],
      types: [
        { kind: 'object', name: 'Query', fields: [field('hello', 'String!', bind(Library, 'hello'))] },
        {
          kind: 'object',
          name: 'Subscription',
          fields: [field('ticks', 'Int', bind(Library, 'hello', { operation: 'subscription' }))],
        },
      ],
    })
    await using booted = await boot(meta)
    const response = await executorOf(booted.plugin).execute({ query: 'subscription { ticks }' })
    expect(response.status).toBe(400)
    expect(response.result.errors?.[0]?.message).toContain('text/event-stream')
  })

  it('opens a scope outside of one, and uses the current scope inside one', async () => {
    await using booted = await boot(metadata())
    seen = undefined
    void booted.plugin.execute({ query: '{ hello }' }, { requestId: 'direct-1' })
    expect(last().requestId).toBe('direct-1')
    expect(last().transport).toBe('direct')
    expect(last().http).toBeUndefined()
    expect(last().operationType).toBe('query')
    expect(last().variables).toEqual({})
    expect(last().signal.aborted).toBe(false)
    expect(booted.app.container.currentScope()).toBeUndefined()
    const fakeHttp = { requestId: 'http-9', signal: new AbortController().signal }
    await booted.app.container.runInScope(() => {
      void booted.plugin.execute({ query: '{ hello }' })
      const scope = booted.app.container.currentScope()
      // the context is the request-scoped external of the current scope
      expect(scope?.get(GraphQLTokens.Context)).toBe(seen as never)
    }, [[HttpTokens.Context, fakeHttp]])
    expect(last().requestId).toBe('http-9')
    expect(last().http).toBe(fakeHttp as never)
    expect(last().signal).toBe(fakeHttp.signal)
    expect(last().state).toBeInstanceOf(Map)
  })

  it('aborts with the signal of the caller', async () => {
    await using booted = await boot(metadata())
    const controller = new AbortController()
    const pending = booted.plugin.execute({ query: '{ slow }' }, { signal: controller.signal })
    const reason = new Error('client gone')
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
  })
})

describe('graphql:operation hook', () => {
  it('is not built without wrappers nor listeners', async () => {
    await using booted = await boot(metadata())
    // nothing observable: the synchronous fast path stays synchronous
    expect(booted.plugin.execute({ query: '{ hello }' })).not.toBeInstanceOf(Promise)
  })

  it('emits once per operation to listeners, synchronously for synchronous executions', async () => {
    await using booted = await boot(metadata())
    const events: GraphQLOperationEvent[] = []
    booted.app.hooks.on('graphql:operation', event => {
      events.push({ ...event })
    })
    const result = booted.plugin.execute({ query: 'query Hi { hello }' }, { requestId: 'r1' })
    expect(result).not.toBeInstanceOf(Promise)
    await booted.plugin.execute({ query: '{ nope }' }, { requestId: 'r2' })
    await booted.plugin.execute({ query: 'mutation { add(n: 1) }' })
    expect(events.map(event => [event.operationType, event.operationName, event.outcome, event.transport])).toEqual([
      ['query', 'Hi', 'success', 'direct'],
      [undefined, undefined, 'rejected', 'direct'],
      ['mutation', undefined, 'success', 'direct'],
    ])
    expect(events[0]?.requestId).toBe('r1')
    expect(events[0]?.documentId).toMatch(/^[0-9a-f]{64}$/)
    expect(events[1]?.errors?.[0]?.code).toBe('GRAPHQL_VALIDATION_FAILED')
  })

  it('runs wrappers around the execution, with the outcome set before they resume', async () => {
    await using booted = await boot(metadata())
    const order: string[] = []
    booted.app.hooks.wrap('graphql:operation', async (event, next) => {
      order.push(`before ${event.operationName}`)
      await next()
      order.push(`after ${event.outcome} ${event.errors?.length ?? 0}`)
    })
    const result = await booted.plugin.execute({ query: 'query Q { hello slow }' })
    expect(result).toEqual({ data: { hello: 'Hello world', slow: 'slow' } })
    expect(order).toEqual(['before Q', 'after success 0'])
  })
})
