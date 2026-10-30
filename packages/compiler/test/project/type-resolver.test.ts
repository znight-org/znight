import type { TypeInfo } from '../../src/project/index.ts'

import { normalizeOptions } from '../../src/options.ts'
import {
  formatType,
  literalType,
  Project,
  primitiveType,
  referenceType,
  serializeType,
  substituteType,
  typeParameterType,
  withTypeParameters,
} from '../../src/project/index.ts'
import { aliasBody, appProject, declarationOf, fileOf, tempDir } from './helpers.ts'
import { describe, expect, test as it } from 'bun:test'

const project = appProject({ conditions: ['@znight/source'] })
const sample = fileOf(project, 'src/types-sample.ts')
const generics = fileOf(project, 'src/generics.ts')

const USER = 'src/users/user.model.ts#User'
const LOGGER = '@fixture/lib#Logger'
const REPOSITORY = 'src/generics.ts#Repository'

function typeOf(alias: string): TypeInfo {
  return project.resolveType(sample, aliasBody(sample, alias))
}

function serialized(alias: string): string {
  return serializeType(typeOf(alias))
}

describe('resolveType: structure', () => {
  it('keywords', () => {
    expect(serialized('TKeywords')).toBe(
      '[string, number, boolean, bigint, symbol, null, undefined, void, any, unknown, never, object]',
    )
  })

  it('literals (negative numbers, bigints, template literals without substitutions)', () => {
    expect(serialized('TLiterals')).toBe('["a", 1, -2, true, 10n, -3n, "tpl"]')
  })

  it('Array<T>, ReadonlyArray<T> and readonly T[] are all T[]', () => {
    expect(serialized('TArrays')).toBe(`[${USER}[], ${USER}[], ${USER}[], ${USER}[][], (${LOGGER} | ${USER})[]]`)
    expect(serialized('TParenthesized')).toBe(`(${LOGGER} | ${USER})[]`)
  })

  it('tuples with optional, rest and named members', () => {
    expect(serialized('TTuple')).toBe('[string, number?, ...boolean[]]')
  })

  it('unions and intersections are normalized', () => {
    expect(serialized('TUnion')).toBe(`null | ${USER} | undefined`)
    expect(serialized('TBooleanUnion')).toBe('"x" | boolean')
    expect(serialized('TAbsorbed')).toBe('1 | string')
    expect(serialized('TIntersection')).toBe(`${LOGGER} & ${USER}`)
  })

  it('Promise<T> is a promise type', () => {
    expect(typeOf('TPromise')).toMatchObject({ kind: 'promise', inner: { kind: 'reference', identity: REPOSITORY } })
  })
})

describe('resolveType: references', () => {
  it('default type arguments are filled from the declaration', () => {
    expect(serialized('TDefaults')).toBe(`${REPOSITORY}<${USER}, string>`)
    // `Store<K = string, V = K[]>`: defaults may refer to previous parameters.
    expect(serialized('TStore')).toBe('src/generics.ts#Store<string, string[]>')
    expect(serialized('TBox')).toBe('src/generics.ts#Box<number>')
  })

  it('type aliases are expanded with their arguments substituted', () => {
    expect(serialized('TAlias')).toBe(`${REPOSITORY}<${USER}, string>`)
    expect(serialized('TMaybe')).toBe(`${USER} | undefined`)
    expect(serialized('TPair')).toBe(`[${USER}, ${USER}]`)
  })

  it('recursive aliases are opaque as a whole', () => {
    expect(typeOf('TJson')).toEqual({ kind: 'opaque', text: 'Json', reason: 'recursive-alias' })
    const loop = project.resolveType(generics, aliasBody(generics, 'Loop'))
    expect(loop).toMatchObject({ kind: 'opaque', reason: 'recursive-alias' })
  })

  it('references keep display names for messages', () => {
    expect(formatType(typeOf('TDefaults'))).toBe('Repository<User, string>')
  })

  it('namespace members, `export =` namespaces and default-import members', () => {
    expect(serialized('TNamespace')).toBe('src/ns.ts#Models.Inner')
    expect(serialized('TNamespaceNested')).toBe('src/ns.ts#Models.Deep.Leaf')
    expect(serialized('TLegacy')).toBe('legacy-ns#Client')
    expect(serialized('TPgDefault')).toBe('pg#Pool')
    expect(serialized('TPool')).toBe('pg#Pool')
  })

  it('globals are references to globalThis identities', () => {
    expect(serialized('TGlobal')).toBe('globalThis#Date')
    expect(serialized('TGlobalGeneric')).toBe(`globalThis#Map<string, ${USER}>`)
  })

  it('unresolvable references are opaque with a reason', () => {
    expect(typeOf('TMissing')).toEqual({ kind: 'opaque', text: 'Missing', reason: 'unresolved' })
    expect(typeOf('TUndeclared')).toEqual({
      kind: 'reference',
      identity: 'globalThis#NotDeclaredAnywhere',
      name: 'NotDeclaredAnywhere',
      typeArgs: [],
    })
  })
})

describe('resolveType: opaque types', () => {
  it.each([
    ['TFunction', 'function', '(x: string) => void'],
    ['TConstructor', 'constructor', 'new () => User'],
    ['TObject', 'object-literal', '{ a: string }'],
    ['TTypeof', 'typeof', 'typeof pg'],
    ['TImport', 'import-type', "import('./generics.ts').Repository<User>"],
    ['TKeyof', 'type-operator', 'keyof User'],
    ['TIndexed', 'indexed-access', "User['id']"],
    ['TMapped', 'mapped', '{ [K in keyof User]: User[K] }'],
    ['TConditional', 'conditional', 'User extends object ? 1 : 2'],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the expected text is TypeScript source containing `${string}`
    ['TTemplate', 'template-literal', '`user-${string}`'],
    ['TNotAType', 'typeof', 'typeof legacy'],
  ])('%s is opaque (%s)', (alias, reason, text) => {
    expect(typeOf(alias)).toEqual({ kind: 'opaque', text, reason: reason as never })
  })

  it('a missing annotation is opaque', () => {
    expect(project.resolveType(sample, undefined)).toEqual({ kind: 'opaque', text: '', reason: 'missing-annotation' })
  })
})

describe('resolveType: enum members', () => {
  it('an enum member type is the literal of the member, like the shapes API', () => {
    const dir = tempDir({
      'src/kinds.ts': [
        "export enum Kind { Cat = 'cat', Dog = 'dog' }",
        'export enum Level { Low, High = 10, Higher }',
        "export namespace Zoo { export enum Kind { Bird = 'bird' } }",
        "export enum Merged { A = 'a' }",
        "export namespace Merged { export type Extra = 'extra' }",
        'declare function at(): number',
        'export enum Computed { X = at() }',
        "export const NotAnEnum = { Cat: 'cat' } as const",
      ].join('\n'),
      'src/use.ts': [
        "import { Kind, Level, Merged, NotAnEnum, Zoo, Computed } from './kinds.ts'",
        "import type * as kinds from './kinds.ts'",
        'type TCat = Kind.Cat',
        'type TPet = Kind.Cat | Kind.Dog',
        'type TLevels = [Level.Low, Level.High, Level.Higher]',
        'type TNamespaced = Zoo.Kind.Bird',
        'type TQualified = kinds.Kind.Dog',
        'type TMergedMember = Merged.A',
        'type TMergedType = Merged.Extra',
        'type TWhole = Kind',
        'type TUnknown = Kind.Fish',
        'type TComputed = Computed.X',
        'type TNotAnEnum = NotAnEnum.Cat',
        'type TLocal = Local.Two',
        'enum Local { One = 1, Two = One + 1 }',
      ].join('\n'),
    })
    try {
      const temp = new Project(normalizeOptions({ root: dir.root }))
      temp.refresh()
      const file = fileOf(temp, 'src/use.ts')
      const of = (alias: string): TypeInfo => temp.resolveType(file, aliasBody(file, alias))
      expect(of('TCat')).toEqual(literalType('cat'))
      expect(serializeType(of('TPet'))).toBe('"cat" | "dog"')
      expect(serializeType(of('TLevels'))).toBe('[0, 10, 11]')
      expect(of('TNamespaced')).toEqual(literalType('bird'))
      expect(of('TQualified')).toEqual(literalType('dog'))
      expect(of('TMergedMember')).toEqual(literalType('a'))
      expect(of('TLocal')).toEqual(literalType(2))
      // a type of a merged namespace is still that type; the enum itself is still a reference
      expect(of('TMergedType')).toEqual(literalType('extra'))
      expect(of('TWhole')).toMatchObject({ kind: 'reference', identity: 'src/kinds.ts#Kind' })
      // an unknown member, an enum that cannot be evaluated, a const object: opaque as before
      expect(of('TUnknown')).toEqual({ kind: 'opaque', text: 'Kind.Fish', reason: 'unresolved' })
      expect(of('TComputed')).toEqual({ kind: 'opaque', text: 'Computed.X', reason: 'unresolved' })
      expect(of('TNotAnEnum')).toMatchObject({ kind: 'opaque', text: 'NotAnEnum.Cat' })
    } finally {
      dir.cleanup()
    }
  })
})

describe('generics', () => {
  it('type parameters in scope are unbound parameters', () => {
    const scope = withTypeParameters(new Map(), [])
    expect(scope.size).toBe(0)
    const box = declarationOf(generics, 'Box')
    expect(project.typeScopeOf(box)).toEqual(new Map([['T', typeParameterType('T')]]))
    const maybe = aliasBody(generics, 'Maybe')
    expect(
      serializeType(project.resolveType(generics, maybe, project.typeScopeOf(declarationOf(generics, 'Maybe')))),
    ).toBe('T | undefined')
  })

  it('typeParametersOf resolves constraints and defaults', () => {
    expect(project.typeParametersOf(declarationOf(generics, 'Store'))).toEqual([
      { name: 'K', constraint: undefined, default: primitiveType('string') },
      { name: 'V', constraint: undefined, default: { kind: 'array', element: typeParameterType('K') } },
    ])
    expect(project.typeParametersOf(declarationOf(generics, 'Derived'))).toEqual([])
  })

  it('bindTypeArguments fills missing arguments from defaults', () => {
    const store = declarationOf(generics, 'Store')
    expect(project.bindTypeArguments(store, [])).toEqual(
      new Map<string, TypeInfo>([
        ['K', primitiveType('string')],
        ['V', { kind: 'array', element: primitiveType('string') }],
      ]),
    )
    const user = referenceType(USER, 'User')
    expect(serializeType(project.bindTypeArguments(store, [user]).get('V') as TypeInfo)).toBe(`${USER}[]`)
    expect(project.bindTypeArguments(declarationOf(generics, 'Base'), [])).toEqual(
      new Map([['T', primitiveType('unknown')]]),
    )
  })

  it('heritage clauses keep the declaration type parameters for substitution', () => {
    const box = declarationOf(generics, 'Box')
    const heritage = project.heritageOf(box)
    expect(heritage.map(clause => `${clause.relation} ${serializeType(clause.type)}`)).toEqual([
      'extends src/generics.ts#Base<T[]>',
      `implements ${REPOSITORY}<T, string>`,
    ])
    const bindings = project.bindTypeArguments(box, [referenceType(USER, 'User')])
    expect(serializeType(substituteType(heritage[0]?.type as TypeInfo, bindings))).toBe(
      `src/generics.ts#Base<${USER}[]>`,
    )
    expect(project.heritageOf(declarationOf(generics, 'Derived')).map(clause => serializeType(clause.type))).toEqual([
      `src/generics.ts#Base<${USER}>`,
    ])
  })

  it('interface heritage', () => {
    const repository = fileOf(project, 'src/users/user.repository.ts')
    expect(
      project.heritageOf(declarationOf(repository, 'UserRepository')).map(clause => serializeType(clause.type)),
    ).toEqual([`${REPOSITORY}<${USER}, string>`])
    expect(project.heritageOf(declarationOf(repository, 'PgUserRepository')).map(clause => clause.relation)).toEqual([
      'implements',
    ])
  })

  it('unanalysable heritage (`extends Mixin(Base)`) is opaque', () => {
    const dir = tempDir({
      'src/mixin.ts': [
        'declare function Mixin<T>(base: T): T',
        'class Base {}',
        'const NotAClass = 1',
        'export class Mixed extends Mixin(Base) {}',
        'export class FromValue extends NotAClass {}',
      ].join('\n'),
    })
    try {
      const temp = new Project(normalizeOptions({ root: dir.root }))
      temp.refresh()
      const file = fileOf(temp, 'src/mixin.ts')
      const [mixed] = temp.heritageOf(declarationOf(file, 'Mixed'))
      expect(mixed?.symbol).toMatchObject({ kind: 'unresolved', reason: 'unsupported-expression' })
      expect(mixed?.type).toEqual({ kind: 'opaque', text: 'Mixin(Base)', reason: 'unsupported' })
      const [fromValue] = temp.heritageOf(declarationOf(file, 'FromValue'))
      expect(fromValue?.type).toEqual({ kind: 'opaque', text: 'NotAClass', reason: 'not-a-type' })
      expect(temp.heritageOf(declarationOf(file, 'NotAClass'))).toEqual([])
    } finally {
      dir.cleanup()
    }
  })
})
