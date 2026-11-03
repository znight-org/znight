/**
 * Additions to `TypeHelpers.shape()` for GraphQL (RFC 0005 §6.8, C1): `members: 'instance'`
 * (getters, public members only, `toJSON()` ignored, `kind` and `declaredBy` of each property),
 * enum members in declaration order, the literals of an alias of a literal union in source order,
 * and the identities of the type arguments of `definitionsOf()` calls. The default (`'json'`) mode
 * is unchanged.
 */
import type { ClassInfo, DefinitionInfo, ShapeOptions, ShapeProperty, ShapeResult } from '../../src/index.ts'
import type { TempDir } from '../project/helpers.ts'
import type { Seen } from './helpers.ts'

import { tempApp } from '../analysis/helpers.ts'
import { analyzeMarked, MARK_PACKAGE, namedOf, printResult, printShape } from './helpers.ts'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

const LIB_PACKAGE: Record<string, string> = {
  'node_modules/@acme/lib/package.json': JSON.stringify({
    name: '@acme/lib',
    version: '1.0.0',
    type: 'module',
    exports: { '.': { types: './index.d.ts', default: './index.js' } },
  }),
  'node_modules/@acme/lib/index.d.ts': [
    'export declare class Remote {',
    '  readonly id: string;',
    '  protected audit: string;',
    '  private secret;',
    '  constructor(id: string);',
    '  /** The label. */',
    '  get label(): string;',
    '  static get count(): number;',
    '  describe(): string;',
    '}',
    'export declare function scalar<T>(name: string): unknown',
    '',
  ].join('\n'),
  'node_modules/@acme/lib/index.js': 'export const scalar = () => ({})\n',
}

const MODEL = `
export class Base {
  /** Base id. */
  readonly id: string = ''
  protected audit = ''
  get baseLabel(): string {
    return ''
  }
}

/** A book. */
export class Book extends Base {
  /** Title. */
  title: string = ''
  private secret = ''
  protected internal = 0
  #hidden = 1
  static count = 0
  callback: () => void = () => {}
  accessor rank: number = 0
  constructor(
    readonly isbn: string,
    protected owner: string,
    private key: string,
    public pages?: number,
  ) {
    super()
  }
  /** Upper-cased title. */
  get upper(): string {
    return ''
  }
  get untyped() {
    return 1
  }
  set rw(value: number) {}
  get rw(): number {
    return 0
  }
  set writeOnly(value: string) {}
  protected get prot(): string {
    return ''
  }
  private get priv(): string {
    return ''
  }
  get #secretGetter(): string {
    return ''
  }
  static get total(): number {
    return 0
  }
  method(): string {
    return ''
  }
  toJSON(): { title: string } {
    return { title: this.title }
  }
}

export interface Named {
  name: string
  get label(): string
  set label(value: string)
  get code(): number
  greet(): string
}
export interface Person extends Named {
  age: number
  handler: () => void
}

export type BookPatch = Partial<Pick<Book, 'title' | 'upper'>>
export type Tagged = Person & { tag: string }

/** Book status. */
export enum Status {
  /** Not published yet. */
  Draft = 'draft',
  /** @deprecated use Archived */
  Live = 'live',
  Archived = 'archived',
}
export enum Level {
  Low,
  Mid = 5,
  High,
}
export enum Keys {
  'two words' = 'tw',
  B = 2,
}
export enum Merged {
  A = 'a',
}
export enum Merged {
  B = 'b',
}
export type Sort = 'title' | 'newest' | ('author' | 'newest')
export type Numbers = 3 | 1 | -2
export type One = 'only'
export type MaybeSort = 'zeta' | null | 'alpha' | undefined
export type Wide = 'a' | string
export type Flag = true | false
export type Ref = Sort | 'other'
`

const ROUTES = `
import { Mark } from '@acme/mark'
import type { Remote } from '@acme/lib'
import type { Base, Book, BookPatch, Flag, Keys, Level, MaybeSort, Merged, Numbers, One, Person, Ref, Sort, Status, Tagged, Wide } from './model.ts'

@Mark()
export class Routes {
  book(): Book {
    return null!
  }
  base(): Base {
    return null!
  }
  person(): Person {
    return null!
  }
  patch(): BookPatch {
    return null!
  }
  tagged(): Tagged {
    return null!
  }
  remote(): Remote {
    return null!
  }
  status(): Status {
    return null!
  }
  level(): Level {
    return null!
  }
  keys(): Keys {
    return null!
  }
  merged(): Merged {
    return null!
  }
  sort(): Sort {
    return null!
  }
  numbers(): Numbers {
    return null!
  }
  one(): One {
    return null!
  }
  maybe(): MaybeSort {
    return null!
  }
  wide(): Wide {
    return null!
  }
  flag(): Flag {
    return null!
  }
  ref(): Ref {
    return null!
  }
}
`

const SCALARS = `
import { scalar } from '@acme/lib'
import * as lib from '@acme/lib'
import type * as model from './model.ts'

export type EmailAddress = string & { readonly __brand: 'Email' }
export const Email = scalar<EmailAddress>('Email')
export const Bytes = scalar<Uint8Array>('Base64')
export const Qualified = lib.scalar<model.Sort>('Sort')
export const Generic = scalar<Array<string>>('Pairs')
export const Inline = scalar<{ a: string }>('Inline')
export const Plain = scalar('Plain')
`

const SCALAR_ROUTES = `
import { Mark } from '@acme/mark'
import type { EmailAddress } from './scalars.ts'

@Mark()
export class Contacts {
  email(): EmailAddress {
    return null!
  }
  emails(): EmailAddress[] {
    return null!
  }
}
`

/** `name: kind declaredBy` of each property of an object shape. */
function members(properties: readonly ShapeProperty[]): string[] {
  return properties.map(
    property =>
      `${property.readonly ? 'readonly ' : ''}${property.name}${property.optional ? '?' : ''}: ${printShape(property.shape)} [${property.kind ?? '-'} ${property.declaredBy ?? '-'}]`,
  )
}

function propertiesOf(result: ShapeResult, key: string): readonly ShapeProperty[] {
  const shape = namedOf(result, key).shape
  if (shape.kind !== 'object') {
    throw new Error(`${key} is not an object: ${printShape(shape)}`)
  }
  return shape.properties
}

const INSTANCE: ShapeOptions = { members: 'instance' }

describe('TypeHelpers.shape() with members', () => {
  let app: TempDir
  let seen: Seen
  let routes: ClassInfo

  beforeAll(async () => {
    app = tempApp({ ...MARK_PACKAGE, ...LIB_PACKAGE, 'src/model.ts': MODEL, 'src/routes.ts': ROUTES })
    const analysis = await analyzeMarked(app.root)
    seen = analysis.seen
    expect(analysis.result.diagnostics).toEqual([])
    routes = seen.classes.get('Routes') as ClassInfo
  })
  afterAll(() => app.cleanup())

  const shapeOf = (name: string, options?: ShapeOptions): ShapeResult => {
    const found = routes.methods.find(candidate => candidate.name === name)
    if (!found || !seen.types) {
      throw new Error(`no method ${name}`)
    }
    return seen.types.shape({ returnOf: found }, options)
  }

  it("keeps the 'json' default: toJSON() wins, protected fields stay, no kind nor declaredBy", () => {
    const book = shapeOf('book')
    expect(printResult(book)).toBe('@src/model.ts#Book\nsrc/model.ts#Book (class) = { title: string }')
    const base = shapeOf('base')
    expect(printShape(namedOf(base, 'src/model.ts#Base').shape)).toBe('{ readonly id: string; audit: string }')
    for (const property of propertiesOf(base, 'src/model.ts#Base')) {
      expect(Object.keys(property)).toEqual(['name', 'shape', 'optional', 'readonly', 'doc', 'location'])
    }
    // an explicit 'json' is the default: same cache, same objects
    const explicit = shapeOf('base', { members: 'json' })
    expect(explicit.named.get('src/model.ts#Base')).toBe(base.named.get('src/model.ts#Base') as never)
    expect(printShape(namedOf(shapeOf('person'), 'src/model.ts#Person').shape)).toBe(
      '{ name: string; age: number; handler: opaque(function: () => void) }',
    )
  })

  it("describes instances with 'instance': public fields and getters, base members first, toJSON() ignored", () => {
    const result = shapeOf('book', INSTANCE)
    expect(members(propertiesOf(result, 'src/model.ts#Book'))).toEqual([
      'readonly id: string [field src/model.ts#Base]',
      'readonly baseLabel: string [getter src/model.ts#Base]',
      'readonly isbn: string [field src/model.ts#Book]',
      'pages?: number [field src/model.ts#Book]',
      'title: string [field src/model.ts#Book]',
      'callback: opaque(function: () => void) [field src/model.ts#Book]',
      'rank: number [field src/model.ts#Book]',
      'readonly upper: string [getter src/model.ts#Book]',
      'readonly untyped: opaque(missing-annotation: untyped) [getter src/model.ts#Book]',
      'rw: number [getter src/model.ts#Book]',
    ])
    const upper = propertiesOf(result, 'src/model.ts#Book').find(property => property.name === 'upper')
    expect(upper?.doc?.text).toBe('Upper-cased title.')
    expect(upper?.location?.line).toBe(30)
    // function-typed fields stay opaque (as in 'json' mode), getters without annotation too
    expect(result.issues.map(issue => [issue.reason, issue.path])).toEqual([
      ['function', 'Book.callback'],
      ['missing-annotation', 'Book.untyped'],
    ])
    // a separate cache: 'json' results are not affected
    expect(shapeOf('book').named.get('src/model.ts#Book')).not.toBe(result.named.get('src/model.ts#Book') as never)
    expect(printShape(namedOf(shapeOf('base', INSTANCE), 'src/model.ts#Base').shape)).toBe(
      '{ readonly id: string; readonly baseLabel: string }',
    )
  })

  it('describes interfaces with getter signatures, and keeps kind and declaredBy through utility types', () => {
    expect(members(propertiesOf(shapeOf('person', INSTANCE), 'src/model.ts#Person'))).toEqual([
      'name: string [field src/model.ts#Named]',
      'label: string [getter src/model.ts#Named]',
      'readonly code: number [getter src/model.ts#Named]',
      'age: number [field src/model.ts#Person]',
      'handler: opaque(function: () => void) [field src/model.ts#Person]',
    ])
    expect(members(propertiesOf(shapeOf('patch', INSTANCE), 'src/model.ts#BookPatch'))).toEqual([
      'title?: string [field src/model.ts#Book]',
      'readonly upper?: string [getter src/model.ts#Book]',
    ])
    expect(members(propertiesOf(shapeOf('tagged', INSTANCE), 'src/model.ts#Tagged'))).toEqual([
      'name: string [field src/model.ts#Named]',
      'label: string [getter src/model.ts#Named]',
      'readonly code: number [getter src/model.ts#Named]',
      'age: number [field src/model.ts#Person]',
      'handler: opaque(function: () => void) [field src/model.ts#Person]',
      'tag: string [field src/model.ts#Tagged]',
    ])
  })

  it('describes classes of declaration files like their sources', () => {
    expect(members(propertiesOf(shapeOf('remote', INSTANCE), '@acme/lib#Remote'))).toEqual([
      'readonly id: string [field @acme/lib#Remote]',
      'readonly label: string [getter @acme/lib#Remote]',
    ])
    expect(printShape(namedOf(shapeOf('remote'), '@acme/lib#Remote').shape)).toBe(
      '{ readonly id: string; audit: string }',
    )
  })

  it('lists enum members in declaration order, with their values, JSDoc and locations', () => {
    for (const options of [undefined, INSTANCE]) {
      const status = namedOf(shapeOf('status', options), 'src/model.ts#Status')
      expect(
        status.enumMembers?.map(member => [member.name, member.value, member.doc?.text, member.location.line]),
      ).toEqual([
        ['Draft', 'draft', 'Not published yet.', 79],
        ['Live', 'live', '', 81],
        ['Archived', 'archived', undefined, 82],
      ])
      expect(status.enumMembers?.[1]?.doc?.tags).toEqual([
        expect.objectContaining({ name: 'deprecated', text: 'use Archived' }),
      ])
    }
    // numeric enums: no reverse mapping
    expect(
      namedOf(shapeOf('level'), 'src/model.ts#Level').enumMembers?.map(member => [member.name, member.value]),
    ).toEqual([
      ['Low', 0],
      ['Mid', 5],
      ['High', 6],
    ])
    expect(
      namedOf(shapeOf('keys'), 'src/model.ts#Keys').enumMembers?.map(member => [member.name, member.value]),
    ).toEqual([
      ['two words', 'tw'],
      ['B', 2],
    ])
    // merged declarations: the members of every declaration, in declaration order
    expect(
      namedOf(shapeOf('merged'), 'src/model.ts#Merged').enumMembers?.map(member => [member.name, member.value]),
    ).toEqual([
      ['A', 'a'],
      ['B', 'b'],
    ])
    expect(namedOf(shapeOf('status', { jsdoc: false }), 'src/model.ts#Status').enumMembers?.[0]?.doc).toBeUndefined()
    expect(namedOf(shapeOf('sort'), 'src/model.ts#Sort').enumMembers).toBeUndefined()
  })

  it('rejects an invalid members option', () => {
    expect(() => shapeOf('book', { members: 'all' as never })).toThrow("members must be 'json' or 'instance'")
  })

  it('lists the literals of an alias of a literal union in source order', () => {
    const sort = namedOf(shapeOf('sort'), 'src/model.ts#Sort')
    // the shape is a normalised (sorted) union
    expect(printShape(sort.shape)).toBe('"author" | "newest" | "title"')
    expect(sort.literals).toEqual(['title', 'newest', 'author'])
    expect(namedOf(shapeOf('numbers'), 'src/model.ts#Numbers').literals).toEqual([3, 1, -2])
    expect(namedOf(shapeOf('one'), 'src/model.ts#One').literals).toEqual(['only'])
    // null and undefined members are skipped
    expect(namedOf(shapeOf('maybe'), 'src/model.ts#MaybeSort').literals).toEqual(['zeta', 'alpha'])
    // not a union of literals only
    expect(namedOf(shapeOf('wide'), 'src/model.ts#Wide').literals).toBeUndefined()
    expect(namedOf(shapeOf('flag'), 'src/model.ts#Flag').literals).toBeUndefined()
    expect(namedOf(shapeOf('ref'), 'src/model.ts#Ref').literals).toBeUndefined()
    expect(namedOf(shapeOf('status'), 'src/model.ts#Status').literals).toBeUndefined()
  })
})

describe('DefinitionInfo.typeArgIdentities', () => {
  let app: TempDir
  let seen: Seen
  let definitions: readonly DefinitionInfo[] = []

  beforeAll(async () => {
    app = tempApp({
      ...MARK_PACKAGE,
      ...LIB_PACKAGE,
      'src/model.ts': MODEL,
      'src/scalars.ts': SCALARS,
      'src/contacts.ts': SCALAR_ROUTES,
    })
    const analysis = await analyzeMarked(app.root, ctx => {
      definitions = ctx.definitionsOf('@acme/lib#scalar')
    })
    seen = analysis.seen
    expect(analysis.result.diagnostics).toEqual([])
  })
  afterAll(() => app.cleanup())

  it('gives the identity of each type argument that is a plain type reference', () => {
    expect(definitions.map(definition => [definition.name, definition.typeArgIdentities])).toEqual([
      ['Bytes', ['globalThis#Uint8Array']],
      ['Email', ['src/scalars.ts#EmailAddress']],
      ['Generic', [undefined]],
      ['Inline', [undefined]],
      ['Plain', []],
      ['Qualified', ['src/model.ts#Sort']],
    ])
    // the resolved type expands the alias: its identity is lost
    expect(definitions.find(definition => definition.name === 'Email')?.typeArgs).toEqual([
      expect.objectContaining({ kind: 'intersection' }),
    ])
  })

  it('lets keep match a type by alias identity', () => {
    const contacts = seen.classes.get('Contacts') as ClassInfo
    const email = definitions.find(definition => definition.name === 'Email')
    const keep = (email?.typeArgIdentities ?? []).filter(identity => identity !== undefined)
    const [single, list] = contacts.methods.map(method => seen.types?.shape({ returnOf: method }, { keep }))
    expect(single?.root).toEqual({
      kind: 'reference',
      identity: 'src/scalars.ts#EmailAddress',
      name: 'EmailAddress',
      typeArgs: [],
      explicitTypeArgs: 0,
    })
    expect(printShape(list?.root ?? { kind: 'never' })).toBe('ref(EmailAddress/0)[]')
    // without keep: a named alias
    const plain = seen.types?.shape({ returnOf: contacts.methods[0] as never })
    expect(printResult(plain as ShapeResult)).toBe(
      '@src/scalars.ts#EmailAddress\nsrc/scalars.ts#EmailAddress (alias) = string',
    )
  })
})
