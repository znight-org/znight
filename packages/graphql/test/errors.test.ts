import type { GraphQLContext, GraphQLErrorMapper } from '../src/index.ts'

import {
  ConflictException,
  ForbiddenException,
  HttpException,
  UnauthorizedException,
  ValidationException,
} from '@znight/http'
import { GraphQLError } from 'graphql'
import * as v from 'valibot'
import { z } from 'zod'

import { GraphQLException, validateArgs } from '../src/index.ts'
import { bind, boot, field, graphqlMetadata } from './support/app.ts'
import { describe, expect, it } from 'bun:test'

class DomainError extends Error {}
class Unmapped extends Error {}

/** The error each field throws, by name. */
const THROWN: Record<string, () => unknown> = {
  exception: () =>
    new GraphQLException('No such book', { code: 'NOT_FOUND', extensions: { id: '7', code: 'ignored' } }),
  graphql: () => new GraphQLError('Raw graphql error', { extensions: { code: 'CUSTOM' } }),
  domain: () => new DomainError('domain failure'),
  unauthorized: () =>
    new UnauthorizedException('Who are you?', undefined, { headers: { 'www-authenticate': 'Bearer' } }),
  forbidden: () => new ForbiddenException(),
  conflict: () => new ConflictException('Duplicate ISBN'),
  teapot: () => new HttpException(418, 'I am a teapot'),
  server: () => new HttpException(503, 'database down'),
  validation: () => new ValidationException('input', [{ message: 'Too short', path: ['title'] }]),
  plain: () => new Unmapped('connection string postgres://secret'),
  string: () => 'not even an error',
}

class Thrower {
  fail(_args: unknown, _parent: unknown, _ctx: unknown, info: { fieldName: string }): never {
    throw (THROWN[info.fieldName] as () => unknown)()
  }
  async later(): Promise<never> {
    await Promise.resolve()
    throw new Unmapped('later')
  }
}

let mapperCalls = 0
class DomainMapper implements GraphQLErrorMapper {
  map(error: unknown, ctx: GraphQLContext): GraphQLException | undefined {
    mapperCalls++
    if (error instanceof DomainError) {
      return new GraphQLException(`mapped: ${error.message}`, {
        code: 'DOMAIN',
        extensions: { requestId: ctx.requestId },
      })
    }
    return undefined
  }
}

function metadata() {
  return graphqlMetadata({
    providers: [Thrower, DomainMapper],
    types: [
      {
        kind: 'object',
        name: 'Book',
        fields: [{ name: 'id', type: 'ID' }, field('broken', 'String', bind(Thrower, 'later', { operation: 'field' }))],
      },
      {
        kind: 'object',
        name: 'Query',
        fields: [
          ...Object.keys(THROWN).map(name => field(name, 'String', bind(Thrower, 'fail'))),
          { name: 'book', type: 'Book', resolver: { ...bind(Thrower, 'later'), invoke: () => ({ id: '1' }) } },
          field('required', 'String!', bind(Thrower, 'later')),
        ],
      },
    ],
  })
}

describe('error formatting', () => {
  it('renders GraphQLException and user GraphQLErrors as they are', async () => {
    await using booted = await boot(metadata())
    const result = await booted.plugin.execute({ query: '{ exception graphql }' })
    expect(result).toEqual({
      data: { exception: null, graphql: null },
      errors: [
        {
          message: 'No such book',
          locations: [{ line: 1, column: 3 }],
          path: ['exception'],
          extensions: { id: '7', code: 'NOT_FOUND' },
        },
        {
          message: 'Raw graphql error',
          locations: [{ line: 1, column: 13 }],
          path: ['graphql'],
          extensions: { code: 'CUSTOM' },
        },
      ],
    })
  })

  it('tries the mappers in order, with the operation context', async () => {
    await using booted = await boot(metadata(), { errorMappers: [new DomainMapper()] })
    const result = await booted.plugin.execute({ query: '{ domain }' }, { requestId: 'req-1' })
    expect(result.errors).toEqual([
      {
        message: 'mapped: domain failure',
        locations: [{ line: 1, column: 3 }],
        path: ['domain'],
        extensions: { requestId: 'req-1', code: 'DOMAIN' },
      },
    ])
  })

  it('maps HttpExceptions by status, without their headers, and masks 5xx', async () => {
    await using booted = await boot(metadata())
    const result = await booted.plugin.execute({
      query: '{ unauthorized forbidden conflict teapot server validation }',
    })
    expect(result.errors?.map(error => [error.message, error.extensions])).toEqual([
      ['Who are you?', { code: 'UNAUTHENTICATED' }],
      ['Forbidden', { code: 'FORBIDDEN' }],
      ['Duplicate ISBN', { code: 'CONFLICT' }],
      ['I am a teapot', { code: 'BAD_REQUEST' }],
      ['Unexpected error.', { code: 'INTERNAL_SERVER_ERROR' }],
      ['Invalid input', { code: 'BAD_USER_INPUT', issues: [{ path: 'title', message: 'Too short' }] }],
    ])
  })

  it('masks unexpected errors and logs them once, with the request id, coordinate and path', async () => {
    mapperCalls = 0
    await using booted = await boot(metadata(), { errorMappers: [DomainMapper] })
    const result = await booted.plugin.execute({ query: '{ plain string b: book { broken } }' }, { requestId: 'req-2' })
    expect(result).toEqual({
      data: { plain: null, string: null, b: { broken: null } },
      errors: [
        {
          message: 'Unexpected error.',
          locations: [{ line: 1, column: 3 }],
          path: ['plain'],
          extensions: { code: 'INTERNAL_SERVER_ERROR' },
        },
        {
          message: 'Unexpected error.',
          locations: [{ line: 1, column: 9 }],
          path: ['string'],
          extensions: { code: 'INTERNAL_SERVER_ERROR' },
        },
        {
          message: 'Unexpected error.',
          locations: [{ line: 1, column: 26 }],
          path: ['b', 'broken'],
          extensions: { code: 'INTERNAL_SERVER_ERROR' },
        },
      ],
    })
    expect(mapperCalls).toBe(3)
    const logged = booted.logs.entries.filter(entry => entry.level === 'error')
    expect(logged.map(entry => entry.message)).toEqual([
      'GraphQL: unexpected error in Query.plain',
      'GraphQL: unexpected error in Query.string',
      'GraphQL: unexpected error in Book.broken',
    ])
    expect(logged[2]?.context).toMatchObject({ requestId: 'req-2', coordinate: 'Book.broken', path: 'b.broken' })
    expect(logged[0]?.context?.['err']).toBeInstanceOf(Unmapped)
  })

  it('exposes unexpected messages with exposeErrors', async () => {
    await using booted = await boot(metadata(), { exposeErrors: true })
    const result = await booted.plugin.execute({ query: '{ plain }' })
    expect(result.errors?.[0]).toMatchObject({
      message: 'connection string postgres://secret',
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    })
  })

  it('codes graphql-js execution errors (non-null violations)', async () => {
    await using booted = await boot(metadata())
    const result = await booted.plugin.execute({ query: '{ required }' })
    expect(result.data).toBeNull()
    expect(result.errors?.[0]?.extensions?.['code']).toBe('INTERNAL_SERVER_ERROR')
  })
})

describe('validateArgs', () => {
  const zodSchema = z.object({ title: z.string().trim().min(1), tags: z.array(z.string()).default([]) })
  const valibotSchema = v.object({ title: v.pipe(v.string(), v.minLength(2)) })

  it('returns the schema output synchronously when the schema is synchronous', () => {
    expect(validateArgs(zodSchema, { title: ' Dune ' }, 'input')).toEqual({ title: 'Dune', tags: [] })
    expect(validateArgs(valibotSchema, { title: 'Dune' }, 'input')).toEqual({ title: 'Dune' })
  })

  it('throws BAD_USER_INPUT with the issues', () => {
    let error: unknown
    try {
      void validateArgs(valibotSchema, { title: 'D' }, 'input')
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(GraphQLException)
    expect(error).toMatchObject({ message: 'Invalid input', code: 'BAD_USER_INPUT' })
    expect((error as GraphQLException).extensions?.['issues']).toEqual([
      { path: 'title', message: expect.stringContaining('length') },
    ])
  })

  it('returns a promise for asynchronous schemas', async () => {
    const asyncSchema = z.string().refine(async value => value !== 'taken', 'Already taken')
    const ok = validateArgs(asyncSchema, 'free', 'name')
    expect(ok).toBeInstanceOf(Promise)
    expect(await ok).toBe('free')
    await expect(validateArgs(asyncSchema, 'taken', 'name')).rejects.toMatchObject({
      code: 'BAD_USER_INPUT',
      extensions: { issues: [{ path: '', message: 'Already taken' }] },
    })
  })

  it('refuses something that is not a Standard Schema', () => {
    expect(() => validateArgs({} as never, 1, 'x')).toThrow(TypeError)
  })
})
