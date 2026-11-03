/**
 * Errors as data (RFC 0008): result mappers turn the errors of guards, Standard Schema validation
 * and `invoke` into values of the field's union, on the fields whose union holds a declared type;
 * every other error, and every other field, keeps the behaviour of RFC 0005 §5.10.
 */
import type { GraphQLOperationEvent } from '@znight/core'
import type { InjectSseResponse } from '@znight/http'
import type { GraphQLResultMapper, GraphQLTypeDefinition, ResolverContext } from '../src/index.ts'

import { HttpPlugin, NotFoundException, UnauthorizedException } from '@znight/http'
import { z } from 'zod'

import { GraphQLErrorCode, GraphQLException, validateArgs } from '../src/index.ts'
import { bind, boot, field, graphqlMetadata } from './support/app.ts'
import { HTTP_EXTERNALS } from './support/library.ts'
import { describe, expect, it } from 'bun:test'

const BOOK = { __typename: 'Book', title: 'Dune' }

/** What a resolver does, by the `id` argument. */
function outcome(id: string): unknown {
  switch (id) {
    case 'missing':
      throw new NotFoundException(`No book ${id}`)
    case 'plain':
      throw new Error('connection string postgres://secret')
    case 'other':
    case 'garbage':
    case 'mapper-bug':
    case 'getter':
    case 'value':
      throw new Error(id)
    default:
      return BOOK
  }
}

class Books {
  book(args: { id: string }): unknown {
    return outcome(args.id)
  }
  async bookAsync(args: { id: string }): Promise<unknown> {
    await Promise.resolve()
    return outcome(args.id)
  }
  create(title: string): unknown {
    return { __typename: 'Book', title }
  }
  shelfBook(args: { id: string }): unknown {
    return outcome(args.id)
  }
  async *watch(): AsyncGenerator<unknown> {
    await Promise.resolve()
    yield BOOK
  }
  /** The body of an async generator runs in the source stream, on its first `next()`. */
  async *watchBody(): AsyncGenerator<unknown> {
    await Promise.resolve()
    if (BOOK.title === 'Dune') throw new NotFoundException('No book to watch')
    yield BOOK
  }
  /** Checks before returning the stream: an error here is an error of the start. */
  watchChecked(): AsyncGenerator<unknown> {
    throw new NotFoundException('No book to watch')
  }
}

class Deny {
  canResolve(): boolean {
    return false
  }
}

class DenyLater {
  async canResolve(): Promise<boolean> {
    await Promise.resolve()
    return false
  }
}

class Unauthenticated {
  canResolve(): boolean {
    throw new UnauthorizedException('Who are you?')
  }
}

const calls: string[] = []

class Rejections implements GraphQLResultMapper {
  static readonly types = ['NotFoundRejection', 'ForbiddenRejection', 'ValidationRejection', 'Other']

  toResult(error: unknown, ctx: ResolverContext): unknown {
    calls.push(`${ctx.route.coordinate} ${ctx.operation.requestId}`)
    if (error instanceof NotFoundException) return { __typename: 'NotFoundRejection', message: error.message }
    if (error instanceof UnauthorizedException) return { __typename: 'ForbiddenRejection', reason: 'unauthenticated' }
    if (error instanceof GraphQLException && error.code === GraphQLErrorCode.Forbidden) {
      return { __typename: 'ForbiddenRejection', reason: ctx.route.coordinate }
    }
    if (error instanceof GraphQLException && error.code === GraphQLErrorCode.BadUserInput) {
      const issues = error.extensions?.['issues'] as readonly { readonly message: string }[]
      return { __typename: 'ValidationRejection', issues: issues.map(issue => issue.message) }
    }
    if (!(error instanceof Error)) return undefined
    if (error.message === 'other') return { __typename: 'Other', x: 'other' }
    if (error.message === 'garbage') return { nope: true }
    if (error.message === 'mapper-bug') throw new Error('the mapper failed')
    if (error.message === 'getter') {
      return {
        get __typename(): string {
          throw new Error('the value cannot be read')
        },
      }
    }
    return undefined
  }
}

/** Asynchronous by mistake: its promise is ignored (and its rejection handled), the next mapper runs. */
class AsyncMapper implements GraphQLResultMapper {
  static readonly types = ['NotFoundRejection']

  async toResult(): Promise<unknown> {
    await Promise.resolve()
    throw new Error('async mapper failed')
  }
}

/** A second mapper: tried after the first one passes. */
class Fallback implements GraphQLResultMapper {
  static readonly types = ['NotFoundRejection']

  toResult(error: unknown): unknown {
    if (error instanceof Error && ['other', 'garbage', 'mapper-bug', 'getter', 'value'].includes(error.message)) {
      return { __typename: 'NotFoundRejection', message: `fallback: ${error.message}` }
    }
    return undefined
  }
}

const TitleSchema = z.string().min(3, 'Too short')
const ID = [{ name: 'id', type: 'String!' }]

const types: GraphQLTypeDefinition[] = [
  { kind: 'object', name: 'Book', fields: [{ name: 'title', type: 'String!' }] },
  { kind: 'object', name: 'NotFoundRejection', fields: [{ name: 'message', type: 'String!' }] },
  { kind: 'object', name: 'ForbiddenRejection', fields: [{ name: 'reason', type: 'String!' }] },
  { kind: 'object', name: 'ValidationRejection', fields: [{ name: 'issues', type: '[String!]!' }] },
  { kind: 'object', name: 'Other', fields: [{ name: 'x', type: 'String' }] },
  {
    kind: 'union',
    name: 'BookResult',
    members: ['Book', 'ForbiddenRejection', 'NotFoundRejection', 'ValidationRejection'],
    discriminator: { by: 'typename' },
  },
  { kind: 'union', name: 'OtherResult', members: ['Book', 'Other'], discriminator: { by: 'typename' } },
  { kind: 'union', name: 'Plain', members: ['Book'], discriminator: { by: 'typename' } },
  {
    kind: 'object',
    name: 'Shelf',
    fields: [
      { name: 'name', type: 'String' },
      field('book', 'BookResult', bind(Books, 'shelfBook', { operation: 'field' }), { args: ID }),
      field('plain', 'Book', bind(Books, 'shelfBook', { operation: 'field' }), { args: ID }),
    ],
  },
  {
    kind: 'object',
    name: 'Query',
    fields: [
      field('book', 'BookResult!', bind(Books, 'book'), { args: ID }),
      field('bookAsync', 'BookResult', bind(Books, 'bookAsync'), { args: ID }),
      field('guarded', 'BookResult', bind(Books, 'book', { guards: [Deny] }), { args: ID }),
      field('guardedLater', 'BookResult', bind(Books, 'book', { guards: [DenyLater] }), { args: ID }),
      field('unauthenticated', 'BookResult', bind(Books, 'book', { guards: [Unauthenticated] }), { args: ID }),
      field('plain', 'Book', bind(Books, 'book'), { args: ID }),
      field('list', '[BookResult!]', bind(Books, 'book'), { args: ID }),
      field('other', 'OtherResult', bind(Books, 'book'), { args: ID }),
      field('unrelated', 'Plain', bind(Books, 'book'), { args: ID }),
      field('shelf', 'Shelf', bind(Books, 'book', { invoke: () => ({ name: 'Classics' }) })),
    ],
  },
  {
    kind: 'object',
    name: 'Mutation',
    fields: [
      field(
        'create',
        'BookResult!',
        bind(Books, 'create', {
          operation: 'mutation',
          invoke: (r: Books, _p, a) => r.create(validateArgs(TitleSchema, a['title'], 'title') as string),
        }),
        { args: [{ name: 'title', type: 'String!' }] },
      ),
    ],
  },
  {
    kind: 'object',
    name: 'Subscription',
    fields: [
      field('watch', 'BookResult', bind(Books, 'watch', { operation: 'subscription', guards: [Deny] })),
      field('watchOpen', 'BookResult', bind(Books, 'watch', { operation: 'subscription' })),
      field('watchBody', 'BookResult', bind(Books, 'watchBody', { operation: 'subscription' })),
      field('watchChecked', 'BookResult', bind(Books, 'watchChecked', { operation: 'subscription' })),
    ],
  },
]

function metadata(extra: readonly GraphQLTypeDefinition[] = []) {
  return graphqlMetadata({
    providers: [Books, Deny, DenyLater, Unauthenticated, Rejections, Fallback, AsyncMapper],
    types: [...types, ...extra],
    externals: HTTP_EXTERNALS,
  })
}

const SELECTION = `__typename ... on Book { title } ... on NotFoundRejection { message }
  ... on ForbiddenRejection { reason } ... on ValidationRejection { issues }`

describe('result mappers', () => {
  it('turn a synchronous invoke error into a member of the union, synchronously', async () => {
    await using booted = await boot(metadata(), { resultMappers: [Rejections] })
    calls.length = 0
    const result = booted.plugin.execute({ query: `{ book(id: "missing") { ${SELECTION} } }` }, { requestId: 'r1' })
    expect(result).not.toBeInstanceOf(Promise)
    expect(result).toEqual({ data: { book: { __typename: 'NotFoundRejection', message: 'No book missing' } } })
    expect(calls).toEqual(['Query.book r1'])
    // a value is returned as is, without mapper
    expect(booted.plugin.execute({ query: `{ book(id: "1") { ${SELECTION} } }` })).toEqual({
      data: { book: { __typename: 'Book', title: 'Dune' } },
    })
    expect(calls).toHaveLength(1)
  })

  it('turn a rejected promise into a value', async () => {
    await using booted = await boot(metadata(), { resultMappers: [Rejections] })
    expect(await booted.plugin.execute({ query: `{ bookAsync(id: "missing") { ${SELECTION} } }` })).toEqual({
      data: { bookAsync: { __typename: 'NotFoundRejection', message: 'No book missing' } },
    })
    expect(await booted.plugin.execute({ query: `{ bookAsync(id: "1") { ${SELECTION} } }` })).toEqual({
      data: { bookAsync: { __typename: 'Book', title: 'Dune' } },
    })
  })

  it('turn guard failures into values: false (sync and async) and a thrown HttpException', async () => {
    await using booted = await boot(metadata(), { resultMappers: [Rejections] })
    expect(
      await booted.plugin.execute({
        query: `{ guarded(id: "1") { ${SELECTION} } guardedLater(id: "1") { ${SELECTION} } unauthenticated(id: "1") { ${SELECTION} } }`,
      }),
    ).toEqual({
      data: {
        guarded: { __typename: 'ForbiddenRejection', reason: 'Query.guarded' },
        guardedLater: { __typename: 'ForbiddenRejection', reason: 'Query.guardedLater' },
        unauthenticated: { __typename: 'ForbiddenRejection', reason: 'unauthenticated' },
      },
    })
  })

  it('turn a Standard Schema failure of the arguments into a value', async () => {
    await using booted = await boot(metadata(), { resultMappers: [Rejections] })
    expect(await booted.plugin.execute({ query: `mutation { create(title: "ab") { ${SELECTION} } }` })).toEqual({
      data: { create: { __typename: 'ValidationRejection', issues: ['Too short'] } },
    })
    expect(await booted.plugin.execute({ query: `mutation { create(title: "Dune") { ${SELECTION} } }` })).toEqual({
      data: { create: { __typename: 'Book', title: 'Dune' } },
    })
  })

  it('leave errors no mapper turns into a value in errors[], masked and logged as before', async () => {
    await using booted = await boot(metadata(), { resultMappers: [Rejections] })
    const result = await booted.plugin.execute({ query: `{ bookAsync(id: "plain") { ${SELECTION} } }` })
    expect(result).toEqual({
      data: { bookAsync: null },
      errors: [
        {
          message: 'Unexpected error.',
          locations: [{ line: 1, column: 3 }],
          path: ['bookAsync'],
          extensions: { code: 'INTERNAL_SERVER_ERROR' },
        },
      ],
    })
    expect(booted.logs.messages('error')).toEqual(['GraphQL: unexpected error in Query.bookAsync'])
  })

  it('keep errors[] for fields whose type holds no declared member: not a union, a list, another union', async () => {
    await using booted = await boot(metadata(), { resultMappers: [Rejections] })
    calls.length = 0
    const result = await booted.plugin.execute({
      query: `{ plain(id: "missing") { title } list(id: "missing") { __typename } unrelated(id: "missing") { __typename } }`,
    })
    expect(result.data).toEqual({ plain: null, list: null, unrelated: null })
    expect(result.errors?.map(error => [error.path, error.extensions?.['code']])).toEqual([
      [['plain'], 'NOT_FOUND'],
      [['list'], 'NOT_FOUND'],
      [['unrelated'], 'NOT_FOUND'],
    ])
    // those fields have no wrapper: the mapper is never called
    expect(calls).toEqual([])
  })

  it('skip a value that is not a member of the field union, then fall back to errors[]', async () => {
    await using booted = await boot(metadata(), { resultMappers: [Rejections] })
    // OtherResult holds Other (declared), but the mapper produces NotFoundRejection
    const other = await booted.plugin.execute({ query: '{ other(id: "missing") { __typename } }' })
    expect(other.data).toEqual({ other: null })
    expect(other.errors?.[0]?.extensions?.['code']).toBe('NOT_FOUND')
    // BookResult does not hold Other: skipped, logged at debug
    const book = await booted.plugin.execute({ query: '{ bookAsync(id: "other") { __typename } }' })
    expect(book.data).toEqual({ bookAsync: null })
    expect(book.errors?.[0]?.extensions?.['code']).toBe('INTERNAL_SERVER_ERROR')
    expect(booted.logs.messages('debug')).toContain(
      'GraphQLPlugin: the result mapper Rejections returned a value of Other, not a member of BookResult (Query.bookAsync): skipped',
    )
    expect(booted.logs.messages('warn')).toEqual([])
  })

  it('skip a value of no type (warn) and a throwing mapper (error), then try the next mapper', async () => {
    await using booted = await boot(metadata(), { resultMappers: [Rejections, Fallback] })
    const result = await booted.plugin.execute({
      query: `{ a: book(id: "garbage") { ${SELECTION} } b: book(id: "mapper-bug") { ${SELECTION} } c: book(id: "other") { ${SELECTION} } }`,
    })
    expect(result).toEqual({
      data: {
        a: { __typename: 'NotFoundRejection', message: 'fallback: garbage' },
        b: { __typename: 'NotFoundRejection', message: 'fallback: mapper-bug' },
        c: { __typename: 'NotFoundRejection', message: 'fallback: other' },
      },
    })
    expect(booted.logs.messages('warn')).toEqual([
      'GraphQLPlugin: the result mapper Rejections returned a value of no type of the schema (Query.book): skipped',
    ])
    expect(booted.logs.messages('error')).toEqual(['GraphQLPlugin: the result mapper Rejections failed'])
  })

  it('skip an asynchronous mapper (its rejection handled) and a value whose type cannot be read', async () => {
    await using booted = await boot(metadata(), { resultMappers: [AsyncMapper, Rejections, Fallback] })
    const result = await booted.plugin.execute({
      query: `{ a: bookAsync(id: "value") { ${SELECTION} } b: bookAsync(id: "getter") { ${SELECTION} } }`,
    })
    expect(result).toEqual({
      data: {
        a: { __typename: 'NotFoundRejection', message: 'fallback: value' },
        b: { __typename: 'NotFoundRejection', message: 'fallback: getter' },
      },
    })
    await Bun.sleep(1)
    expect(booted.logs.messages('error')).toEqual([
      'GraphQLPlugin: the result mapper AsyncMapper returned a promise: toResult() must be synchronous',
      'GraphQLPlugin: the result mapper AsyncMapper returned a promise: toResult() must be synchronous',
      'GraphQLPlugin: the result mapper Rejections failed',
    ])
  })

  it('keep a non-null field non-null: a declined error nulls the parent as before', async () => {
    await using booted = await boot(metadata(), { resultMappers: [Rejections] })
    const result = booted.plugin.execute({ query: '{ book(id: "plain") { __typename } }' })
    expect(result).toMatchObject({ data: null, errors: [{ path: ['book'] }] })
  })

  it('apply per field: a nested field resolver gets its own value, a nested field without union keeps its error', async () => {
    await using booted = await boot(metadata(), { resultMappers: [Rejections] })
    const result = await booted.plugin.execute({
      query: `{ shelf { name book(id: "missing") { ${SELECTION} } plain(id: "missing") { title } } }`,
    })
    expect(result.data).toEqual({
      shelf: {
        name: 'Classics',
        book: { __typename: 'NotFoundRejection', message: 'No book missing' },
        plain: null,
      },
    })
    expect(result.errors?.map(error => [error.path, error.extensions?.['code']])).toEqual([
      [['shelf', 'plain'], 'NOT_FOUND'],
    ])
  })

  it('report the operation as a success to the graphql:operation hook', async () => {
    await using booted = await boot(metadata(), { resultMappers: [Rejections] })
    const events: GraphQLOperationEvent[] = []
    booted.app.hooks.on('graphql:operation', event => {
      events.push({ ...event })
    })
    await booted.plugin.execute({ query: `{ bookAsync(id: "missing") { __typename } }` })
    await booted.plugin.execute({ query: `{ plain(id: "missing") { title } }` })
    expect(events.map(event => [event.outcome, event.errors?.length ?? 0])).toEqual([
      ['success', 0],
      ['partial', 1],
    ])
  })

  it('accept instances with their own types, and request-scoped providers', async () => {
    const instance = {
      types: ['NotFoundRejection'],
      toResult: (error: unknown) =>
        error instanceof NotFoundException ? { __typename: 'NotFoundRejection', message: 'instance' } : undefined,
    }
    await using booted = await boot(metadata(), { resultMappers: [instance] })
    expect(
      booted.plugin.execute({ query: '{ book(id: "missing") { ... on NotFoundRejection { message } } }' }),
    ).toEqual({ data: { book: { message: 'instance' } } })

    let created = 0
    class Scoped implements GraphQLResultMapper {
      static readonly types = ['NotFoundRejection']
      constructor() {
        created++
      }
      toResult(): unknown {
        return { __typename: 'NotFoundRejection', message: 'scoped' }
      }
    }
    const scoped = graphqlMetadata({
      providers: [Books, Deny, DenyLater, Unauthenticated, { class: Scoped, scope: 'request' }],
      types,
      externals: HTTP_EXTERNALS,
    })
    await using second = await boot(scoped, { resultMappers: [Scoped] })
    expect(created).toBe(0)
    expect(
      await second.plugin.execute({
        query:
          '{ a: book(id: "missing") { ... on NotFoundRejection { message } } b: book(id: "missing") { __typename } }',
      }),
    ).toEqual({ data: { a: { message: 'scoped' }, b: { __typename: 'NotFoundRejection' } } })
    expect(created).toBe(1)
  })

  it('leave the resolve function of fields that carry no result unchanged', async () => {
    await using without = await boot(metadata())
    await using withMappers = await boot(metadata(), { resultMappers: [Rejections] })
    const fieldsOf = (schema: typeof without.plugin.schema) => schema.getQueryType()?.getFields() ?? {}
    const before = fieldsOf(without.plugin.schema)
    const after = fieldsOf(withMappers.plugin.schema)
    for (const name of ['plain', 'list', 'unrelated', 'shelf']) {
      expect(String(after[name]?.resolve)).toBe(String(before[name]?.resolve))
    }
    for (const name of ['book', 'bookAsync', 'guarded', 'other']) {
      expect(String(after[name]?.resolve)).not.toBe(String(before[name]?.resolve))
    }
    expect(withMappers.logs.messages('debug')).toContain('GraphQL schema built')
    const built = withMappers.logs.entries.find(entry => entry.message === 'GraphQL schema built')
    expect(built?.context?.['resultFields']).toBe(12)
  })
})

describe('result mappers on subscriptions', () => {
  it('turn an error at the start into a stream of one event', async () => {
    await using booted = await boot(metadata(), { resultMappers: [Rejections] })
    const stream = await booted.plugin.subscribe({ query: `subscription { watch { ${SELECTION} } }` })
    expect(await stream.next()).toEqual({
      done: false,
      value: { data: { watch: { __typename: 'ForbiddenRejection', reason: 'Subscription.watch' } } },
    })
    expect(await stream.next()).toEqual({ done: true, value: undefined })
    expect(booted.plugin.activeSubscriptions).toBe(0)
  })

  it('map an error of a method returning the stream, not of the body of an async generator', async () => {
    await using booted = await boot(metadata(), { resultMappers: [Rejections] })
    const checked = await booted.plugin.subscribe({ query: `subscription { watchChecked { ${SELECTION} } }` })
    expect((await checked.next()).value).toEqual({
      data: { watchChecked: { __typename: 'NotFoundRejection', message: 'No book to watch' } },
    })
    // the body runs in the source stream: its errors end the stream with errors[]
    const body = await booted.plugin.subscribe({ query: `subscription { watchBody { ${SELECTION} } }` })
    const event = (await body.next()).value as { errors?: { extensions?: { code?: string } }[] }
    expect(event.errors?.[0]?.extensions?.code).toBe('NOT_FOUND')
  })

  it('stream the value as one next event, then complete, over SSE', async () => {
    await using booted = await boot(metadata(), { http: {}, resultMappers: [Rejections] }, [
      HttpPlugin.configure({ host: '127.0.0.1', port: 0 }),
    ])
    await booted.app.start()
    const http = booted.app.getPlugin('http') as HttpPlugin
    const stream: InjectSseResponse = await http.injectSse({
      method: 'POST',
      url: '/graphql',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ query: 'subscription { watch { ... on ForbiddenRejection { reason } } }' }),
    })
    const received: [string, string][] = []
    for await (const message of stream) received.push([message.event, message.data])
    expect(received).toEqual([
      ['next', '{"data":{"watch":{"reason":"Subscription.watch"}}}'],
      ['complete', ''],
    ])
    // queries over HTTP: the value is data
    const response = await http.inject({
      method: 'POST',
      url: '/graphql',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ book(id: "missing") { ... on NotFoundRejection { message } } }' }),
    })
    expect(response.json()).toEqual({ data: { book: { message: 'No book missing' } } })
  })
})

describe('result mappers at boot', () => {
  it('fail with ZNIGHT066 for types that are missing or not object types of the schema', async () => {
    class NoTypes implements GraphQLResultMapper {
      toResult(): unknown {
        return undefined
      }
    }
    class Typo implements GraphQLResultMapper {
      static readonly types = ['NotFoundRejecton', 'BookResult', 'NotFoundRejection']
      toResult(): unknown {
        return undefined
      }
    }
    const providers = [Books, Deny, DenyLater, Unauthenticated, NoTypes, Typo]
    const meta = graphqlMetadata({ providers, types, externals: HTTP_EXTERNALS })
    const failure = await boot(meta, { resultMappers: [NoTypes as never, Typo] }).then(
      () => undefined,
      (error: unknown) => error as { code: string; message: string },
    )
    expect(failure?.code).toBe('ZNIGHT066')
    expect(failure?.message).toContain(
      'the result mapper NoTypes declares no types (static readonly types = [...object type names])',
    )
    expect(failure?.message).toContain(
      'the result mapper Typo declares NotFoundRejecton, which is not an object type of the schema',
    )
    expect(failure?.message).toContain(
      'the result mapper Typo declares BookResult, which is not an object type of the schema',
    )
  })

  it('fail for refs that are not result mappers', async () => {
    class NotProvided implements GraphQLResultMapper {
      static readonly types = ['NotFoundRejection']
      toResult(): unknown {
        return undefined
      }
    }
    const missing = await boot(metadata(), { resultMappers: [NotProvided] }).then(
      () => undefined,
      (error: unknown) => error as { code: string },
    )
    expect(missing?.code).toBe('ZNIGHT001')
    const invalid = await boot(metadata(), { resultMappers: [{ map: () => undefined }] as never }).then(
      () => undefined,
      (error: unknown) => error as { code: string; message: string },
    )
    expect(invalid?.code).toBe('ZNIGHT066')
    expect(invalid?.message).toContain('resultMappers')
  })
})
