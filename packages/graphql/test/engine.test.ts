/**
 * The GraphQL engine (RFC 0009 §4.2, §12): `plugin.engine` and what drivers call. Parse cache and
 * limits, the engine's rules, validation and its cache, execution in an existing scope or in one of
 * its own, the `GraphQLContext` of engine operations, errors as `GraphQLError` instances (masked,
 * mapped), the hook with `driver`, subscriptions (cap, disabled, end on stop), foreign schemas.
 */
import type { GraphQLOperationEvent } from '@znight/core'
import type { ExecutionResult } from 'graphql'
import type { GraphQLContext, GraphQLErrorMapper } from '../src/index.ts'

import { HttpTokens } from '@znight/http'
import {
  GraphQLError,
  NoSchemaIntrospectionCustomRule,
  parse,
  specifiedRules,
  type ValidationRule,
  validate,
} from 'graphql'

import { GraphQLException, GraphQLTokens } from '../src/index.ts'
import { executorOf } from '../src/plugin.ts'
import { bind, boot, field, graphqlMetadata } from './support/app.ts'
import { describe, expect, it } from 'bun:test'

/** What the `context` field reports of the operation's `GraphQLContext`. */
let seen: GraphQLContext | undefined

class DomainError extends Error {}

class Library {
  hello(args: { name?: string | null }): string {
    return `Hello ${args.name ?? 'world'}`
  }
  context(_args: unknown, _parent: unknown, ctx: GraphQLContext): string {
    seen = ctx
    return ctx.transport
  }
  fail(): string {
    throw new Error('the database password is hunter2')
  }
  domain(): string {
    throw new DomainError('no such shelf')
  }
  slow(_args: unknown, _parent: unknown, ctx: GraphQLContext): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve('slow'), 50)
      ctx.signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(ctx.signal.reason)
      })
    })
  }
  add(args: { n: number }): number {
    return args.n + 1
  }
  async *ticks(_args: unknown, _parent: unknown, ctx: GraphQLContext): AsyncGenerator<number> {
    for (let n = 1; !ctx.signal.aborted; n++) {
      yield n
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
  denied(): AsyncIterable<number> {
    throw new GraphQLException('Not allowed', { code: 'FORBIDDEN' })
  }
}

let instances = 0

/** A request-scoped resolver: one instance per request scope. */
class Scoped {
  readonly id = ++instances
  instance(): number {
    return this.id
  }
}

class Mapper implements GraphQLErrorMapper {
  map(error: unknown): GraphQLException | undefined {
    return error instanceof DomainError ? new GraphQLException(error.message, { code: 'DOMAIN' }) : undefined
  }
}

function metadata() {
  return graphqlMetadata({
    providers: [Library, { class: Scoped, scope: 'request' }],
    types: [
      {
        kind: 'object',
        name: 'Query',
        fields: [
          field('hello', 'String!', bind(Library, 'hello'), { args: [{ name: 'name', type: 'String' }] }),
          field('context', 'String!', bind(Library, 'context')),
          field('fail', 'String', bind(Library, 'fail')),
          field('domain', 'String', bind(Library, 'domain')),
          field('slow', 'String', bind(Library, 'slow')),
          field('instance', 'Int!', bind(Scoped, 'instance')),
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
      {
        kind: 'object',
        name: 'Subscription',
        fields: [
          field('ticks', 'Int!', bind(Library, 'ticks', { operation: 'subscription' })),
          field('denied', 'Int!', bind(Library, 'denied', { operation: 'subscription' })),
        ],
      },
    ],
  })
}

describe('parse', () => {
  it('parses through the document cache: a validated text gives the same document', async () => {
    await using booted = await boot(metadata())
    const engine = booted.plugin.engine
    const first = engine.parse('{ hello }')
    expect(engine.validate(engine.schema, first)).toEqual([])
    expect(engine.parse('{ hello }')).toBe(first)
    // the built-in path and the engine share the cache
    await booted.plugin.execute({ query: '{ add: hello }' })
    const cached = engine.parse('{ add: hello }')
    expect(engine.parse('{ add: hello }')).toBe(cached)
    // a text never validated is parsed again
    expect(engine.parse('{ context }')).not.toBe(engine.parse('{ context }'))
  })

  it('throws GraphQLErrors with codes: syntax, maxTokens and the document limits', async () => {
    await using booted = await boot(metadata(), { limits: { maxTokens: 20, maxDepth: 1 } })
    const engine = booted.plugin.engine
    const failure = (text: string): GraphQLError => {
      try {
        engine.parse(text)
      } catch (error) {
        return error as GraphQLError
      }
      throw new Error(`${text} parsed`)
    }
    const syntax = failure('{ hello')
    expect(syntax).toBeInstanceOf(GraphQLError)
    expect(syntax.extensions['code']).toBe('GRAPHQL_PARSE_FAILED')
    expect(syntax.locations).toEqual([{ line: 1, column: 8 }])
    expect(failure(`{ ${'hello '.repeat(30)}}`).extensions['code']).toBe('GRAPHQL_PARSE_FAILED')
    const deep = failure('{ a { b } }')
    expect(deep.extensions['code']).toBe('QUERY_TOO_COMPLEX')
    expect(deep.message).toBe('The operation is 2 levels deep, more than the limit of 1.')
  })
})

describe('validate and rules', () => {
  it('validates with the specified rules, caches valid documents, and codes the errors', async () => {
    await using booted = await boot(metadata())
    const engine = booted.plugin.engine
    const executor = executorOf(booted.plugin)
    const document = engine.parse('{ hello }')
    const before = executor.cachedDocuments
    expect(engine.validate(engine.schema, document, specifiedRules)).toEqual([])
    expect(executor.cachedDocuments).toBe(before + 1)
    // a copy of specifiedRules (graphql-http, Envelop) is the default list too
    expect(engine.validate(engine.schema, document, [...specifiedRules])).toEqual([])
    const errors = engine.validate(engine.schema, engine.parse('{ nope }'))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(GraphQLError)
    expect(errors[0]?.extensions).toEqual({ code: 'GRAPHQL_VALIDATION_FAILED' })
    expect(executor.cachedDocuments).toBe(before + 1)
  })

  it('runs the server rules with the engine rules, without caching', async () => {
    await using booted = await boot(metadata())
    const engine = booted.plugin.engine
    const executor = executorOf(booted.plugin)
    let visits = 0
    const counting: ValidationRule = () => ({
      Field() {
        visits++
      },
    })
    const document = engine.parse('{ hello }')
    const cached = executor.cachedDocuments
    expect(engine.validate(engine.schema, document, [...specifiedRules, counting])).toEqual([])
    expect(engine.validate(engine.schema, document, [...specifiedRules, counting])).toEqual([])
    expect(visits).toBe(2)
    expect(executor.cachedDocuments).toBe(cached)
  })

  it('applies the limits as rules to documents the engine did not parse', async () => {
    await using booted = await boot(metadata(), { limits: { maxDepth: 1 } })
    const engine = booted.plugin.engine
    const document = parse('{ a { b } }')
    const errors = engine.validate(engine.schema, document)
    expect(errors.map(error => error.extensions['code'])).toContain('QUERY_TOO_COMPLEX')
    // the rules alone, for servers that validate themselves (Apollo Server)
    const own = validate(engine.schema, document, engine.rules)
    expect(own.map(error => error.message)).toEqual(['The operation is 2 levels deep, more than the limit of 1.'])
  })

  it('turns introspection off with a rule, and hides suggestions', async () => {
    await using booted = await boot(metadata(), { introspection: false })
    const engine = booted.plugin.engine
    expect(engine.rules).toContain(NoSchemaIntrospectionCustomRule)
    expect(engine.settings.introspection).toBe(false)
    const introspection = engine.validate(engine.schema, engine.parse('{ __schema { types { name } } }'))
    expect(introspection[0]?.message).toContain('introspection')
    const typo = engine.validate(engine.schema, engine.parse('{ helo }'))
    expect(typo[0]?.message).toBe('Cannot query field "helo" on type "Query".')
  })

  it('keeps introspection with the default options, and has no rule without limits', async () => {
    await using booted = await boot(metadata(), {
      introspection: true,
      limits: { maxDepth: false, maxAliases: false, maxDirectives: false },
    })
    expect(booted.plugin.engine.rules).toEqual([])
  })
})

describe('execute', () => {
  it('executes a validated document, synchronously when every resolver is', async () => {
    await using booted = await boot(metadata())
    const engine = booted.plugin.engine
    const document = engine.parse('query Q { hello(name: "Ada") } mutation M($n: Int!) { add(n: $n) }')
    expect(engine.validate(engine.schema, document)).toEqual([])
    const result = engine.execute({ schema: engine.schema, document, operationName: 'Q' })
    expect(result).toEqual({ data: { hello: 'Hello Ada' } })
    expect(
      await engine.execute({ schema: engine.schema, document, operationName: 'M', variableValues: { n: 1 } }),
    ).toEqual({ data: { add: 2 } })
  })

  it('answers operation selection and variable errors as GraphQLErrors', async () => {
    await using booted = await boot(metadata())
    const engine = booted.plugin.engine
    const document = engine.parse('query A { hello } query B($n: Int!) { add: hello(name: "x") }')
    const ambiguous = (await engine.execute({ schema: engine.schema, document })) as ExecutionResult
    expect(ambiguous.errors?.[0]).toBeInstanceOf(GraphQLError)
    expect(ambiguous.errors?.[0]?.extensions).toEqual({ code: 'BAD_REQUEST' })
    const unknown = (await engine.execute({ schema: engine.schema, document, operationName: 'C' })) as ExecutionResult
    expect(unknown.errors?.[0]?.message).toBe('Unknown operation named "C".')
    const variables = (await engine.execute({ schema: engine.schema, document, operationName: 'B' })) as ExecutionResult
    expect('data' in variables).toBe(false)
    expect(variables.errors?.[0]).toBeInstanceOf(GraphQLError)
    expect(variables.errors?.[0]?.extensions).toEqual({ code: 'BAD_USER_INPUT' })
    const subscription = (await engine.execute({
      schema: engine.schema,
      document: engine.parse('subscription { ticks }'),
    })) as ExecutionResult
    expect(subscription.errors?.[0]?.message).toBe('Subscriptions are started with GraphQLEngine.subscribe()')
  })

  it('masks and maps errors once, as GraphQLError instances without original error', async () => {
    await using booted = await boot(metadata(), { errorMappers: [new Mapper()] })
    const engine = booted.plugin.engine
    const result = (await engine.execute({
      schema: engine.schema,
      document: engine.parse('{ fail domain }'),
    })) as ExecutionResult
    expect(result.data).toEqual({ fail: null, domain: null })
    const [masked, mapped] = result.errors ?? []
    expect(masked).toBeInstanceOf(GraphQLError)
    expect(masked?.toJSON()).toEqual({
      message: 'Unexpected error.',
      locations: [{ line: 1, column: 3 }],
      path: ['fail'],
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    })
    expect(masked?.originalError).toBeUndefined()
    expect(mapped?.toJSON()).toEqual({
      message: 'no such shelf',
      locations: [{ line: 1, column: 8 }],
      path: ['domain'],
      extensions: { code: 'DOMAIN' },
    })
    expect(booted.logs.messages('error')).toEqual(['GraphQL: unexpected error in Query.fail'])
  })

  it('refuses a schema that is not the engine one (ZNIGHT066)', async () => {
    await using booted = await boot(metadata())
    await using other = await boot(metadata())
    const engine = booted.plugin.engine
    expect(() => engine.execute({ schema: other.plugin.schema, document: parse('{ hello }') })).toThrow(
      /ZNIGHT066: GraphQLEngine: the operation targets another schema/,
    )
  })

  it('opens a scope per operation without one, and runs in the current scope otherwise', async () => {
    await using booted = await boot(metadata())
    const engine = booted.plugin.engine
    const document = engine.parse('{ instance }')
    // a request-scoped provider of a scope of its own: closed (asynchronously) after the operation
    const once = async (): Promise<number> =>
      ((await engine.execute({ schema: engine.schema, document })) as ExecutionResult<{ instance: number }>).data
        ?.instance ?? 0
    const a = await once()
    const b = await once()
    expect(b).not.toBe(a)
    const scope = booted.app.container.openScope()
    const [c, d] = await scope.run(() => Promise.all([once(), once()]))
    expect(d).toBe(c)
    expect(scope.context.get(GraphQLTokens.Context)).toBeDefined()
    await scope.close()
  })

  it('builds the GraphQLContext from the options and the server context', async () => {
    await using booted = await boot(metadata())
    const engine = booted.plugin.engine
    const document = engine.parse('{ context }')
    const signal = new AbortController().signal
    const server = { yoga: true }
    const result = engine.execute(
      { schema: engine.schema, document, contextValue: server },
      { transport: 'sse', signal, requestId: 'req-7' },
    )
    expect(result).toEqual({ data: { context: 'sse' } })
    expect(seen?.serverContext).toBe(server)
    expect(seen?.requestId).toBe('req-7')
    expect(seen?.signal).toBe(signal)
    expect(seen?.http).toBeUndefined()
    // defaults: http transport, a request id, no server context
    engine.execute({ schema: engine.schema, document })
    expect(seen?.transport).toBe('http')
    expect(seen?.serverContext).toBeUndefined()
    expect(typeof seen?.requestId).toBe('string')
    // the request id of the scope's HTTP request
    const scope = booted.app.container.openScope([[HttpTokens.RequestId, 'req-http']])
    scope.run(() => engine.execute({ schema: engine.schema, document }))
    expect(seen?.requestId).toBe('req-http')
    await scope.close()
  })

  it('aborts an asynchronous execution with its signal', async () => {
    await using booted = await boot(metadata())
    const engine = booted.plugin.engine
    const controller = new AbortController()
    const pending = engine.execute(
      { schema: engine.schema, document: engine.parse('{ slow }') },
      { signal: controller.signal },
    )
    controller.abort(new Error('client gone'))
    expect(pending).rejects.toThrow('client gone')
  })

  it('produces one hook event per operation with the driver, and observes rejected documents', async () => {
    await using booted = await boot(metadata())
    const engine = booted.plugin.engine
    const events: GraphQLOperationEvent[] = []
    booted.app.hooks.on('graphql:operation', event => events.push(event))
    engine.execute({ schema: engine.schema, document: engine.parse('query Hi { hello }') })
    expect(() => engine.parse('{ hello')).toThrow()
    engine.validate(engine.schema, engine.parse('{ nope }'))
    await booted.plugin.execute({ query: '{ hello }' })
    expect(
      events.map(event => [event.operationName, event.transport, event.driver, event.outcome, event.errors?.[0]?.code]),
    ).toEqual([
      ['Hi', 'http', 'builtin', 'success', undefined],
      [undefined, 'http', 'builtin', 'rejected', 'GRAPHQL_PARSE_FAILED'],
      [undefined, 'http', 'builtin', 'rejected', 'GRAPHQL_VALIDATION_FAILED'],
      [undefined, 'direct', 'builtin', 'success', undefined],
    ])
  })

  it('lets wrappers see rejected documents', async () => {
    await using booted = await boot(metadata())
    const engine = booted.plugin.engine
    const wrapped: (string | undefined)[] = []
    booted.app.hooks.wrap('graphql:operation', async (event, next) => {
      await next()
      wrapped.push(event.outcome)
    })
    expect(() => engine.parse('{ hello')).toThrow()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(wrapped).toEqual(['rejected'])
  })
})

describe('subscribe', () => {
  it('streams results, and gives a query its single result', async () => {
    await using booted = await boot(metadata())
    const engine = booted.plugin.engine
    const stream = await engine.subscribe({ schema: engine.schema, document: engine.parse('subscription { ticks }') })
    if (!(Symbol.asyncIterator in stream)) throw new Error('not a stream')
    expect(await stream.next()).toEqual({ done: false, value: { data: { ticks: 1 } } })
    expect(await stream.next()).toEqual({ done: false, value: { data: { ticks: 2 } } })
    expect(booted.plugin.activeSubscriptions).toBe(1)
    await stream.return()
    expect(booted.plugin.activeSubscriptions).toBe(0)
    expect(await engine.subscribe({ schema: engine.schema, document: engine.parse('{ hello }') })).toEqual({
      data: { hello: 'Hello world' },
    })
  })

  it('answers a subscription that cannot start with a single error result', async () => {
    await using booted = await boot(metadata())
    const engine = booted.plugin.engine
    const result = (await engine.subscribe({
      schema: engine.schema,
      document: engine.parse('subscription { denied }'),
    })) as ExecutionResult
    expect(result.errors?.[0]).toBeInstanceOf(GraphQLError)
    expect(result.errors?.[0]?.toJSON()).toMatchObject({ message: 'Not allowed', extensions: { code: 'FORBIDDEN' } })
    expect(booted.plugin.activeSubscriptions).toBe(0)
  })

  it('shares the maxActive cap with every transport', async () => {
    await using booted = await boot(metadata(), { subscriptions: { maxActive: 1 } })
    const engine = booted.plugin.engine
    const direct = await booted.plugin.subscribe({ query: 'subscription { ticks }' })
    const refused = (await engine.subscribe({
      schema: engine.schema,
      document: engine.parse('subscription { ticks }'),
    })) as ExecutionResult
    expect(refused.errors?.[0]?.extensions).toEqual({ code: 'SERVICE_UNAVAILABLE' })
    await direct.return()
  })

  it('refuses subscriptions when they are disabled', async () => {
    await using booted = await boot(metadata(), { subscriptions: false })
    const engine = booted.plugin.engine
    expect(engine.settings.subscriptions).toBe(false)
    const refused = (await engine.subscribe({
      schema: engine.schema,
      document: engine.parse('subscription { ticks }'),
    })) as ExecutionResult
    expect(refused.errors?.[0]?.toJSON()).toEqual({
      message: 'Subscriptions are disabled on this server',
      extensions: { code: 'BAD_REQUEST' },
    })
  })

  it('ends its streams when the application stops', async () => {
    const booted = await boot(metadata())
    await booted.app.start()
    const engine = booted.plugin.engine
    const stream = await engine.subscribe({ schema: engine.schema, document: engine.parse('subscription { ticks }') })
    if (!(Symbol.asyncIterator in stream)) throw new Error('not a stream')
    expect((await stream.next()).value).toEqual({ data: { ticks: 1 } })
    await booted.app.stop()
    expect(booted.plugin.activeSubscriptions).toBe(0)
    expect(await stream.next()).toEqual({ done: true, value: undefined })
  })

  it('ends a stream when its signal aborts', async () => {
    await using booted = await boot(metadata())
    const engine = booted.plugin.engine
    const controller = new AbortController()
    const stream = await engine.subscribe(
      { schema: engine.schema, document: engine.parse('subscription { ticks }') },
      { signal: controller.signal, transport: 'sse' },
    )
    if (!(Symbol.asyncIterator in stream)) throw new Error('not a stream')
    controller.abort()
    expect(await stream.next()).toEqual({ done: true, value: undefined })
    expect(booted.plugin.activeSubscriptions).toBe(0)
  })
})

describe('settings', () => {
  it('exposes the resolved options a server needs', async () => {
    await using booted = await boot(metadata(), { path: '/gql', graphiql: true, exposeErrors: true })
    expect(booted.plugin.engine.settings).toEqual({
      path: '/gql',
      introspection: true,
      ide: true,
      exposeErrors: true,
      maxTokens: 2000,
      subscriptions: { maxActive: 10_000 },
      http: false,
    })
  })
})
