import type { BatchLoad, GraphQLContext } from '../src/index.ts'

import { ErrorCode } from '@znight/core'

import { GraphQLException, MemoryPubSub, orderByKeys } from '../src/index.ts'
import { bind, boot, field, graphqlMetadata } from './support/app.ts'
import { describe, expect, it } from 'bun:test'

interface Book {
  readonly id: string
  readonly authorId: string
}

const AUTHORS: Record<string, string> = { a1: 'Herbert', a2: 'Tolkien' }
const BOOKS: Book[] = [
  { id: 'b1', authorId: 'a1' },
  { id: 'b2', authorId: 'a2' },
  { id: 'b3', authorId: 'a1' },
  { id: 'b4', authorId: 'missing' },
]

let batches: (readonly string[])[] = []

class AuthorsById implements BatchLoad<string, string> {
  readonly options = { maxBatchSize: 10 }
  load(ids: readonly string[]): Promise<readonly (string | Error)[]> {
    batches.push(ids)
    const rows = ids.filter(id => id in AUTHORS).map(id => ({ id, name: AUTHORS[id] as string }))
    return Promise.resolve(orderByKeys(ids, rows, row => row.id).map(row => (row instanceof Error ? row : row.name)))
  }
}

class BrokenLoader implements BatchLoad<string, string> {
  load(): Promise<readonly string[]> {
    return Promise.resolve(['only one'])
  }
}

const pubsub = new MemoryPubSub<{ added: Book }>()

class Books {
  books(): Book[] {
    return BOOKS
  }
  author(_args: unknown, parent: Book, ctx: GraphQLContext): Promise<string> {
    // the class form, as services do
    return ctx.loader(AuthorsById).load(parent.authorId)
  }
  broken(_args: unknown, parent: Book, ctx: GraphQLContext): Promise<string> {
    return ctx.loader('test#BrokenLoader').load(parent.id) as Promise<string>
  }
  added(_args: unknown, _parent: unknown, ctx: GraphQLContext): AsyncIterableIterator<Book> {
    return pubsub.subscribe('added', { signal: ctx.signal })
  }
}

function metadata() {
  return graphqlMetadata({
    providers: [Books, AuthorsById, BrokenLoader],
    types: [
      {
        kind: 'object',
        name: 'Book',
        fields: [
          { name: 'id', type: 'ID!' },
          field('author', 'String', bind(Books, 'author', { operation: 'field', loaders: ['test#AuthorsById'] }), {}),
          field('broken', 'String', bind(Books, 'broken', { operation: 'field' })),
        ],
      },
      { kind: 'object', name: 'Query', fields: [field('books', '[Book!]!', bind(Books, 'books'))] },
      {
        kind: 'object',
        name: 'Subscription',
        fields: [field('added', 'Book!', bind(Books, 'added', { operation: 'subscription' }))],
      },
    ],
  })
}

describe('loaders', () => {
  it('batch the keys of one execution, with a cache per execution', async () => {
    await using booted = await boot(metadata())
    batches = []
    const result = await booted.plugin.execute({ query: '{ books { id author } }' })
    expect(result.data).toEqual({
      books: [
        { id: 'b1', author: 'Herbert' },
        { id: 'b2', author: 'Tolkien' },
        { id: 'b3', author: 'Herbert' },
        { id: 'b4', author: null },
      ],
    })
    expect(result.errors).toEqual([
      {
        message: 'Not found: missing',
        locations: [{ line: 1, column: 14 }],
        path: ['books', 3, 'author'],
        extensions: { code: 'NOT_FOUND' },
      },
    ])
    expect(batches).toEqual([['a1', 'a2', 'missing']])
    await booted.plugin.execute({ query: '{ books { author } }' })
    // a new execution: a new loader, a new batch
    expect(batches).toHaveLength(2)
  })

  it('fail every key of a batch returning the wrong number of values (ZNIGHT065)', async () => {
    await using booted = await boot(metadata())
    const result = await booted.plugin.execute({ query: '{ books { broken } }' })
    expect(result.errors).toHaveLength(4)
    expect(new Set(result.errors?.map(error => error.extensions?.['code']))).toEqual(new Set(['INTERNAL_SERVER_ERROR']))
    const logged = booted.logs.entries.filter(entry => entry.level === 'error')
    // the same cause for the four keys: logged once
    expect(logged).toHaveLength(1)
    expect(logged[0]?.context?.['err']).toMatchObject({ code: ErrorCode.InvalidLoader })
    expect(String((logged[0]?.context?.['err'] as Error | undefined)?.message)).toContain(
      'returned 1 values for 4 keys',
    )
  })

  it('renew the loaders for every subscription event', async () => {
    await using booted = await boot(metadata())
    const stream = await booted.plugin.subscribe({ query: 'subscription { added { id author } }' })
    batches = []
    const first = stream.next()
    await Bun.sleep(0)
    await pubsub.publish('added', { id: 'b9', authorId: 'a1' })
    expect((await first).value).toEqual({ data: { added: { id: 'b9', author: 'Herbert' } } })
    await pubsub.publish('added', { id: 'b10', authorId: 'a1' })
    expect((await stream.next()).value).toEqual({ data: { added: { id: 'b10', author: 'Herbert' } } })
    // same key twice, in two events: two batches (no cache across events)
    expect(batches).toEqual([['a1'], ['a1']])
    expect(booted.plugin.activeSubscriptions).toBe(1)
    await stream.return()
    expect(booted.plugin.activeSubscriptions).toBe(0)
  })

  it('reject invalid options and providers that are not loaders', async () => {
    class BadOptions implements BatchLoad<string, string> {
      readonly options = { maxBatchSize: 0 }
      load(keys: readonly string[]): Promise<readonly string[]> {
        return Promise.resolve(keys)
      }
    }
    class Plain {}
    class Uses {
      bad(_a: unknown, _p: unknown, ctx: GraphQLContext): Promise<unknown> {
        return ctx.loader('test#BadOptions').load('x')
      }
      plain(_a: unknown, _p: unknown, ctx: GraphQLContext): Promise<unknown> {
        return ctx.loader('test#Plain').load('x')
      }
      unknown(_a: unknown, _p: unknown, ctx: GraphQLContext): Promise<unknown> {
        return ctx.loader(class Nope {} as never).load('x')
      }
    }
    const meta = graphqlMetadata({
      providers: [Uses, BadOptions, Plain],
      types: [
        {
          kind: 'object',
          name: 'Query',
          fields: ['bad', 'plain', 'unknown'].map(name => field(name, 'String', bind(Uses, name))),
        },
      ],
    })
    await using booted = await boot(meta)
    await booted.plugin.execute({ query: '{ bad plain unknown }' })
    const causes = booted.logs.entries
      .filter(entry => entry.level === 'error')
      .map(entry => (entry.context?.['err'] as { code?: string } | undefined)?.code)
    expect(causes).toEqual([ErrorCode.InvalidLoader, ErrorCode.InvalidLoader, ErrorCode.MissingProvider])
  })
})

describe('orderByKeys', () => {
  const rows = [
    { id: 3, name: 'c' },
    { id: 1, name: 'a' },
  ]

  it('orders values by key, a NOT_FOUND error for missing keys', () => {
    const ordered = orderByKeys([1, 2, 3, 1], rows, row => row.id)
    expect(ordered[0]).toEqual({ id: 1, name: 'a' })
    expect(ordered[1]).toBeInstanceOf(GraphQLException)
    expect(ordered[1]).toMatchObject({ code: 'NOT_FOUND', message: 'Not found: 2' })
    expect(ordered[2]).toEqual({ id: 3, name: 'c' })
    expect(ordered[3]).toBe(ordered[0] as never)
  })

  it('gives null for missing keys with missing: null', () => {
    expect(orderByKeys([2, 3], rows, row => row.id, { missing: 'null' })).toEqual([null, { id: 3, name: 'c' }])
    expect(() => orderByKeys([1], rows, row => row.id, { missing: 'nope' as never })).toThrow(TypeError)
  })
})
