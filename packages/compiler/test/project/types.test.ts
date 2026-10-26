import {
  arrayType,
  formatType,
  freeTypeParameters,
  intersectionType,
  literalType,
  opaqueType,
  primitiveType,
  promiseType,
  referenceType,
  serializeType,
  substituteType,
  tupleType,
  typeParameterType,
  typesEqual,
  unionType,
} from '../../src/project/index.ts'
import { describe, expect, test as it } from 'bun:test'

const user = referenceType('src/user.ts#User', 'User')
const logger = referenceType('@acme/lib#Logger', 'Logger')
const string = primitiveType('string')
const number = primitiveType('number')
const undefinedType = primitiveType('undefined')

describe('serializeType (normative canonical form)', () => {
  it('primitives by keyword, literals as JSON, bigints with n', () => {
    expect(serializeType(string)).toBe('string')
    expect(serializeType(literalType('admin'))).toBe('"admin"')
    expect(serializeType(literalType('quote"d'))).toBe('"quote\\"d"')
    expect(serializeType(literalType(42))).toBe('42')
    expect(serializeType(literalType(-1.5))).toBe('-1.5')
    expect(serializeType(literalType(-0))).toBe('0')
    expect(serializeType(literalType(true))).toBe('true')
    expect(serializeType(literalType(10n))).toBe('10n')
  })

  it('references use identities, with type arguments', () => {
    expect(serializeType(user)).toBe('src/user.ts#User')
    expect(serializeType(referenceType('src/repo.ts#Repository', 'Repository', [user, string]))).toBe(
      'src/repo.ts#Repository<src/user.ts#User, string>',
    )
  })

  it('arrays, tuples, promises, opaque types and type parameters', () => {
    expect(serializeType(arrayType(user))).toBe('src/user.ts#User[]')
    expect(serializeType(arrayType(unionType([user, undefinedType])))).toBe('(src/user.ts#User | undefined)[]')
    expect(
      serializeType(
        tupleType([
          { type: string, optional: false, rest: false },
          { type: unionType([number, undefinedType]), optional: true, rest: false },
          { type: arrayType(user), optional: false, rest: true },
        ]),
      ),
    ).toBe('[string, (number | undefined)?, ...src/user.ts#User[]]')
    expect(serializeType(promiseType(user))).toBe('Promise<src/user.ts#User>')
    expect(serializeType(opaqueType('(x:   string) =>\n void', 'function'))).toBe('opaque("(x: string) => void")')
    expect(serializeType(typeParameterType('T'))).toBe('T')
  })

  it('intersections parenthesize union members', () => {
    expect(serializeType(intersectionType([unionType([user, logger]), string]))).toBe(
      '(@acme/lib#Logger | src/user.ts#User) & string',
    )
  })

  it('formatType uses display names', () => {
    expect(formatType(referenceType('src/repo.ts#Repository', 'Repository', [user]))).toBe('Repository<User>')
    expect(formatType(opaqueType('{ a: string }', 'object-literal'))).toBe('{ a: string }')
    expect(formatType(unionType([user, undefinedType]))).toBe('User | undefined')
  })
})

describe('unionType normalization', () => {
  it('flattens, de-duplicates and sorts by serialization', () => {
    const union = unionType([user, unionType([undefinedType, user]), primitiveType('null')])
    expect(serializeType(union)).toBe('null | src/user.ts#User | undefined')
    expect(typesEqual(unionType([undefinedType, user]), unionType([user, undefinedType]))).toBe(true)
  })

  it('collapses single members and empty unions', () => {
    expect(unionType([user, user])).toEqual(user)
    expect(unionType([])).toEqual(primitiveType('never'))
  })

  it('true | false → boolean, literals absorbed by their primitive', () => {
    expect(serializeType(unionType([literalType(true), literalType(false), literalType('x')]))).toBe('"x" | boolean')
    expect(serializeType(unionType([string, literalType('a'), literalType(1)]))).toBe('1 | string')
    expect(serializeType(unionType([primitiveType('bigint'), literalType(1n)]))).toBe('bigint')
  })

  it('never is dropped, any and unknown absorb everything', () => {
    expect(unionType([user, primitiveType('never')])).toEqual(user)
    expect(unionType([user, primitiveType('any')])).toEqual(primitiveType('any'))
    expect(unionType([user, primitiveType('unknown')])).toEqual(primitiveType('unknown'))
  })
})

describe('intersectionType normalization', () => {
  it('flattens, de-duplicates and sorts', () => {
    expect(serializeType(intersectionType([user, intersectionType([logger, user])]))).toBe(
      '@acme/lib#Logger & src/user.ts#User',
    )
  })

  it('never and any absorb, unknown is dropped, empty is unknown', () => {
    expect(intersectionType([user, primitiveType('never')])).toEqual(primitiveType('never'))
    expect(intersectionType([user, primitiveType('any')])).toEqual(primitiveType('any'))
    expect(intersectionType([user, primitiveType('unknown')])).toEqual(user)
    expect(intersectionType([])).toEqual(primitiveType('unknown'))
  })
})

describe('substituteType', () => {
  const T = typeParameterType('T')

  it('replaces bound parameters everywhere and re-normalizes', () => {
    const generic = referenceType('src/repo.ts#Repository', 'Repository', [
      unionType([T, undefinedType]),
      arrayType(T),
      promiseType(T),
      tupleType([{ type: T, optional: false, rest: false }]),
      intersectionType([T, logger]),
    ])
    const bound = substituteType(generic, new Map([['T', unionType([user, undefinedType])]]))
    expect(serializeType(bound)).toBe(
      'src/repo.ts#Repository<src/user.ts#User | undefined, (src/user.ts#User | undefined)[], Promise<src/user.ts#User | undefined>, [src/user.ts#User | undefined], @acme/lib#Logger & (src/user.ts#User | undefined)>',
    )
  })

  it('keeps unbound parameters and returns the same type without bindings', () => {
    expect(substituteType(T, new Map([['U', user]]))).toEqual(T)
    expect(substituteType(user, new Map())).toBe(user)
  })

  it('freeTypeParameters lists the unbound parameters', () => {
    expect(freeTypeParameters(referenceType('x#Map', 'Map', [typeParameterType('K'), arrayType(T), user]))).toEqual([
      'K',
      'T',
    ])
    expect(freeTypeParameters(user)).toEqual([])
  })
})
