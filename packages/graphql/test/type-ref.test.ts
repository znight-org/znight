import { GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql'

import { namedTypeOf, parseTypeRef, printTypeRef } from '../src/type-ref.ts'
import { describe, expect, it } from 'bun:test'

describe('parseTypeRef', () => {
  it('parses named, non-null and list references', () => {
    expect(parseTypeRef('Book')).toEqual({ kind: 'named', name: 'Book', nonNull: false })
    expect(parseTypeRef('Book!')).toEqual({ kind: 'named', name: 'Book', nonNull: true })
    expect(parseTypeRef('[Book!]!')).toEqual({
      kind: 'list',
      of: { kind: 'named', name: 'Book', nonNull: true },
      nonNull: true,
    })
    expect(parseTypeRef('[[Int]]')).toEqual({
      kind: 'list',
      of: { kind: 'list', of: { kind: 'named', name: 'Int', nonNull: false }, nonNull: false },
      nonNull: false,
    })
    expect(parseTypeRef('_private_9')).toEqual({ kind: 'named', name: '_private_9', nonNull: false })
  })

  it.each([
    '',
    '!',
    'Book!!',
    '[Book',
    'Book]',
    '[]',
    '[Book]]',
    '[[Book]',
    ' Book',
    'Book ',
    '[ Book ]',
    '9Book',
    'Bo-ok',
    'Book!?',
    '[Book]!!',
  ])('rejects the malformed reference %p', text => {
    expect(parseTypeRef(text)).toBeUndefined()
  })

  it('round-trips through printTypeRef', () => {
    for (const text of ['Book', 'Book!', '[Book]', '[Book!]', '[Book]!', '[Book!]!', '[[Int!]]!', '[[[ID]!]]']) {
      const ref = parseTypeRef(text)
      expect(ref === undefined ? undefined : printTypeRef(ref)).toBe(text)
    }
  })

  it('prints like graphql-js', () => {
    const book = new GraphQLObjectType({ name: 'Book', fields: { ok: { type: GraphQLBoolean } } })
    const cases = [
      book,
      new GraphQLNonNull(book),
      new GraphQLList(new GraphQLNonNull(book)),
      new GraphQLNonNull(new GraphQLList(new GraphQLList(GraphQLString))),
    ]
    for (const type of cases) {
      const ref = parseTypeRef(String(type))
      expect(ref === undefined ? undefined : printTypeRef(ref)).toBe(String(type))
    }
  })
})

describe('namedTypeOf', () => {
  it('returns the innermost type name', () => {
    expect(namedTypeOf('Book')).toBe('Book')
    expect(namedTypeOf('[[Book!]!]')).toBe('Book')
    expect(namedTypeOf(parseTypeRef('[Int]!') ?? 'x')).toBe('Int')
  })

  it('returns undefined for a malformed reference', () => {
    expect(namedTypeOf('[Book')).toBeUndefined()
  })
})
