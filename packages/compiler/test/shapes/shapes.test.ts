/**
 * `TypeHelpers.shape()` (C1 of RFC 0002): structural view of annotations for schema generators —
 * primitives, literals, unions, optional properties, arrays, tuples, interfaces with `extends`,
 * aliases, classes (fields, parameter properties, getters excluded, `toJSON`), records, index
 * signatures, utility types, generics, recursion, enums, `Date`/`URL`/bytes, `bigint`, non-JSON
 * types, kept references, targets and issues.
 */
import type { ClassInfo, ShapeOptions, ShapeResult, ShapeTarget } from '../../src/index.ts'
import type { TempDir } from '../project/helpers.ts'
import type { Seen } from './helpers.ts'

import { tempApp } from '../analysis/helpers.ts'
import { analyzeMarked, MARK_PACKAGE, namedOf, printResult, printShape } from './helpers.ts'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

const MODEL = `
/** A book of the shelf. */
export interface Book {
  /**
   * Identifier.
   * @format int64
   */
  readonly id: number
  title: string
  subtitle?: string
  author: string | null
  tags: readonly string[]
  published: Date
  site: URL
  rating: 1 | 2 | 3
  cover: Uint8Array
  meta: Record<string, string>
  status: BookStatus
  /** @deprecated use tags */
  genre?: string | undefined
}

/** Publication status. */
export enum BookStatus {
  Draft = 'draft',
  Published = 'published',
}
export enum Level {
  Low,
  Mid = 5,
  High,
}

export interface Page<T> {
  items: T[]
  total: number
  next?: Page<T>
}
export interface Entity {
  id: string
  createdAt: Date
}
export interface Author extends Entity {
  name: string
  id: string
}
export interface Author {
  /** Merged declaration. */
  country?: string
}
export type BookSummary = Pick<Book, 'id' | 'title'>
export type BookPatch = Partial<Omit<Book, 'id' | 'cover'>>
export type Ratings = Record<'low' | 'high', number>
export type Figure = { kind: 'circle'; radius: number } | { kind: 'square'; side: number }
export type Tree = { value: number; children: Tree[] }
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
export type Tuple = [string, number?, ...boolean[]]
export type Branded = string & { readonly __brand: 'Id' }
export type Keys = keyof Entity
export type TitleType = Book['title']
export type Mapped = { readonly [K in 'a' | 'b']?: number }
export type Simplify<T> = { [K in keyof T]: T[K] }
export type Plain = Simplify<Author>
export type Strict = Required<Entity & { note?: string }>
export type NoNull = NonNullable<string | null | undefined>
export type OnlyStrings = Extract<'a' | 'b' | 1, string>
export type WithoutB = Exclude<'a' | 'b' | 'c', 'b'>
export type Cond<T> = T extends string ? 'yes' : 'no'
export type Merged = Entity & { name: string }
export type Callable = { (): void; name: string }
export type Grow<T> = { next: Grow<T[]> }
export interface LoopA extends LoopB {
  a: string
}
export interface LoopB extends LoopA {
  b: string
}

export class Base {
  /** From the base class. */
  readonly createdBy: string = 'system'
}
export class Shelf extends Base {
  readonly name: string
  private secret = 'x'
  #hidden = 1
  static count = 0
  label = \`shelf\`
  opened = new Date()
  get size(): number {
    return 0
  }
  constructor(
    /** The shelf id. */
    readonly id: number,
    public owner?: string,
    plain?: string,
  ) {
    super()
    this.name = plain ?? ''
  }
  method(): void {}
}
export class Money {
  constructor(readonly cents: bigint) {}
  toJSON(): string {
    return String(this.cents)
  }
}
export class Euro extends Money {}
export class Raw {
  toJSON() {
    return 1
  }
}
export class Stats {
  total: bigint = 0n
  byGenre: Map<string, number> = new Map()
  callback: () => void = () => {}
  pattern?: RegExp
}
export class Box<T = string> {
  constructor(readonly value: T) {}
}
`

const ROUTES = `
import { Arg, Mark, Returns } from '@acme/mark'
import type { Author, Book, Box, Page, Stats } from './model.ts'
import type { Readable } from 'node:stream'

@Mark()
export class Routes {
  list(@Arg() q?: string, @Arg() limit = 20): Promise<Page<Book>> {
    return null!
  }
  one(): Promise<Book | undefined> {
    return null!
  }
  generic<T>(value: T): T {
    return value
  }
  none() {}
  @Returns<Book[]>(200)
  raw(): Response {
    return null!
  }
  stats(): Stats {
    return null!
  }
  boxed(): Box {
    return null!
  }
  stream(): Readable {
    return null!
  }
  inline(): { author: Author; count: number; [extra: string]: unknown } {
    return null!
  }
  nested(): Promise<Promise<string>> {
    return null!
  }
  either(): Stats | Author {
    return null!
  }
}

export class Repo<T> {
  constructor(
    readonly items: T[],
    readonly label: string,
  ) {}
}
export class BookRepo extends Repo<Book> {
  /** The current page. */
  page: Page<Book> | null = null
  @Returns(200)
  noop(): void {}
}
`

describe('TypeHelpers.shape()', () => {
  let app: TempDir
  let seen: Seen
  let routes: ClassInfo

  beforeAll(async () => {
    app = tempApp({ ...MARK_PACKAGE, 'src/model.ts': MODEL, 'src/routes.ts': ROUTES })
    const analysis = await analyzeMarked(app.root)
    seen = analysis.seen
    expect(analysis.result.diagnostics).toEqual([])
    routes = seen.classes.get('Routes') as ClassInfo
  })
  afterAll(() => app.cleanup())

  const shapeOf = (target: ShapeTarget, options?: ShapeOptions): ShapeResult => {
    if (!seen.types) {
      throw new Error('validate did not run')
    }
    return seen.types.shape(target, options)
  }
  const method = (name: string): ShapeTarget => {
    const found = routes.methods.find(candidate => candidate.name === name)
    if (!found) {
      throw new Error(`no method ${name}`)
    }
    return { returnOf: found }
  }

  it('describes interfaces: optional properties, nullables, arrays, dates, literals, records, enums and JSDoc', () => {
    const result = shapeOf(method('list'))
    expect(printShape(result.root)).toBe('@src/model.ts#Page<src/model.ts#Book>')
    const page = namedOf(result, 'src/model.ts#Page<src/model.ts#Book>')
    expect(page).toMatchObject({ identity: 'src/model.ts#Page', name: 'Page', declaration: 'interface' })
    expect(page.typeArgs).toEqual([{ kind: 'named', key: 'src/model.ts#Book' }])
    expect(printShape(page.shape)).toBe(
      '{ items: @src/model.ts#Book[]; total: number; next?: @src/model.ts#Page<src/model.ts#Book> }',
    )
    const book = namedOf(result, 'src/model.ts#Book')
    expect(printShape(book.shape)).toBe(
      '{ readonly id: number; title: string; subtitle?: string; author: null | string; tags: string[]; published: date; site: url; rating: 1 | 2 | 3; cover: binary; meta: { [string]: string }; status: @src/model.ts#BookStatus; genre?: string }',
    )
    expect(book.doc?.text).toBe('A book of the shelf.')
    expect(book.location.line).toBe(3)
    const properties = book.shape.kind === 'object' ? book.shape.properties : []
    const id = properties.find(property => property.name === 'id')
    expect(id?.doc).toMatchObject({ text: 'Identifier.', tags: [{ name: 'format', text: 'int64' }] })
    expect(id?.location?.line).toBe(8)
    expect(properties.find(property => property.name === 'genre')?.doc?.tags).toEqual([
      expect.objectContaining({ name: 'deprecated', text: 'use tags' }),
    ])
    expect(namedOf(result, 'src/model.ts#BookStatus')).toMatchObject({
      declaration: 'enum',
      shape: {
        kind: 'union',
        members: [
          { kind: 'literal', value: 'draft' },
          { kind: 'literal', value: 'published' },
        ],
      },
      doc: { summary: 'Publication status.' },
    })
    expect([...result.named.keys()]).toEqual([
      'src/model.ts#Book',
      'src/model.ts#BookStatus',
      'src/model.ts#Page<src/model.ts#Book>',
    ])
    expect(result.issues).toEqual([])
  })

  it('unwraps the top-level Promise of a return type only', () => {
    expect(printShape(shapeOf(method('one')).root)).toBe('@src/model.ts#Book | undefined')
    const nested = shapeOf(method('nested'))
    expect(printShape(nested.root)).toBe('opaque(non-json: Promise<string>)')
    expect(nested.issues.map(issue => issue.reason)).toEqual(['non-json'])
  })

  it('describes parameters, decorator type arguments, properties and resolved TypeInfo', () => {
    const list = routes.methods.find(candidate => candidate.name === 'list')
    // the annotation (`q?: string`): optionality is ParameterInfo.optional
    expect(printShape(shapeOf({ parameter: list?.params[0] as never }).root)).toBe('string')
    // no annotation: the default value is not inferred
    expect(shapeOf({ parameter: list?.params[1] as never }).root).toEqual({
      kind: 'opaque',
      text: '',
      reason: 'missing-annotation',
    })
    const raw = routes.methods.find(candidate => candidate.name === 'raw')
    const response = raw?.decorators[0]
    expect(response?.typeArgs.map(type => seen.types?.format(type))).toEqual(['Book[]'])
    expect(printShape(shapeOf({ decorator: response as never, typeArgument: 0 }).root)).toBe('@src/model.ts#Book[]')
    expect(shapeOf({ decorator: response as never, typeArgument: 1 }).root).toMatchObject({
      reason: 'missing-annotation',
    })
    const book = shapeOf({ type: (list?.returnType as never) ?? { kind: 'primitive', name: 'never' } })
    // from a TypeInfo: the Promise is not unwrapped, references are named
    expect(printShape(book.root)).toBe('opaque(non-json: Promise)')
    const page = shapeOf({
      type: {
        kind: 'reference',
        identity: 'src/model.ts#Page',
        name: 'Page',
        typeArgs: [{ kind: 'primitive', name: 'string' }],
      },
    })
    expect(printShape(page.root)).toBe('@src/model.ts#Page<string>')
    expect(printShape(namedOf(page, 'src/model.ts#Page<string>').shape)).toBe(
      '{ items: string[]; total: number; next?: @src/model.ts#Page<string> }',
    )
  })

  it('substitutes the type parameters of inherited constructors, and describes fields', () => {
    const repo = seen.classes.get('BookRepo') as ClassInfo
    expect(repo.ctor.declaredBy).toBe('src/routes.ts#Repo')
    expect(printShape(shapeOf({ parameter: repo.ctor.params[0] as never }).root)).toBe('@src/model.ts#Book[]')
    expect(printShape(shapeOf({ parameter: repo.ctor.params[1] as never }).root)).toBe('string')
    const page = shapeOf({ property: repo.properties[0] as never })
    expect(printShape(page.root)).toBe('null | @src/model.ts#Page<src/model.ts#Book>')
    expect(repo.properties[0]?.doc?.text).toBe('The current page.')
  })

  it('describes classes: own and inherited fields, parameter properties, toJSON', () => {
    const stats = shapeOf(method('stats'))
    expect(printResult(stats)).toMatchSnapshot()
    // sorted by path, located at the annotations of model.ts
    expect(stats.issues.map(issue => [issue.reason, issue.path, issue.location?.line])).toEqual([
      ['non-json', 'Stats.byGenre', 118],
      ['function', 'Stats.callback', 119],
      ['non-json', 'Stats.pattern', 120],
      ['bigint', 'Stats.total', 117],
    ])
    expect(stats.issues[0]?.location?.file).toBe(`${app.root}/src/model.ts`)
  })

  it('applies utility types, mapped types, keyof, indexed access and intersections', () => {
    const result = shapeOf(method('inline'))
    expect(printShape(result.root)).toBe('{ author: @src/model.ts#Author; count: number; [string]: unknown }')
    expect(printShape(namedOf(result, 'src/model.ts#Author').shape)).toBe(
      '{ id: string; createdAt: date; name: string; country?: string }',
    )
    expect(namedOf(result, 'src/model.ts#Author').doc).toBeUndefined()
  })

  it('keeps references listed in keep, with their type arguments', () => {
    const boxed = shapeOf(method('boxed'), { keep: ['src/model.ts#Box'] })
    expect(boxed.root).toEqual({
      kind: 'reference',
      identity: 'src/model.ts#Box',
      name: 'Box',
      typeArgs: [{ kind: 'string' }],
      explicitTypeArgs: 0,
    })
    expect(boxed.named.size).toBe(0)
    // the same declaration expanded without `keep` (default type argument filled in)
    expect(printShape(shapeOf(method('boxed')).root)).toBe('@src/model.ts#Box<string>')
    expect(printShape(shapeOf(method('raw'), { keep: ['globalThis#Response'] }).root)).toBe('ref(Response/0)')
    expect(printShape(shapeOf(method('raw')).root)).toBe('opaque(non-json: Response)')
    expect(printShape(shapeOf(method('stream')).root)).toBe('binary')
  })

  it('reports unbound type parameters and missing annotations', () => {
    const generic = shapeOf(method('generic'))
    expect(generic.root).toEqual({ kind: 'opaque', text: 'T', reason: 'type-parameter' })
    expect(generic.issues).toEqual([
      expect.objectContaining({ reason: 'type-parameter', path: '', named: undefined, text: 'T' }),
    ])
    expect(shapeOf(method('none')).root).toMatchObject({ reason: 'missing-annotation' })
  })

  it('merges the named shapes of several roots', () => {
    const either = shapeOf(method('either'))
    expect(printShape(either.root)).toBe('@src/model.ts#Author | @src/model.ts#Stats')
    expect([...either.named.keys()]).toEqual(['src/model.ts#Author', 'src/model.ts#Stats'])
    expect(either.issues.map(issue => issue.path)).toEqual([
      'Stats.byGenre',
      'Stats.callback',
      'Stats.pattern',
      'Stats.total',
    ])
  })

  it('caches named shapes per options for the whole compile', () => {
    const first = shapeOf(method('list'))
    const second = shapeOf(method('list'))
    expect(second.named.get('src/model.ts#Book')).toBe(first.named.get('src/model.ts#Book') as never)
    // issues of named shapes are shared objects: de-duplicate them by identity across results
    expect(shapeOf(method('stats')).issues[0]).toBe(shapeOf(method('either')).issues[0] as never)
    const withoutDoc = shapeOf(method('list'), { jsdoc: false })
    expect(withoutDoc.named.get('src/model.ts#Book')).not.toBe(first.named.get('src/model.ts#Book') as never)
    expect(withoutDoc.named.get('src/model.ts#Book')?.doc).toBeUndefined()
  })

  it('rejects invalid targets and options', () => {
    expect(() => shapeOf({} as never)).toThrow('unknown target')
    expect(() => shapeOf(method('list'), { schemaAliases: { x: 'both' as never } })).toThrow("'input' or 'output'")
  })
})

describe('TypeHelpers.shape() on aliases', () => {
  let app: TempDir
  let seen: Seen
  const ALIASES = [
    'BookSummary',
    'BookPatch',
    'Ratings',
    'Figure',
    'Tree',
    'Json',
    'Tuple',
    'Branded',
    'Keys',
    'TitleType',
    'Mapped',
    'Plain',
    'Strict',
    'NoNull',
    'OnlyStrings',
    'WithoutB',
    'Cond<string>',
    'Merged',
    'Callable',
    'Grow<string>',
    'LoopA',
    'Shelf',
    'Money',
    'Euro',
    'Raw',
    'Level',
  ]

  beforeAll(async () => {
    const methods = ALIASES.map((name, index) => `  m${index}(): ${name} {\n    return null!\n  }`).join('\n')
    app = tempApp({
      ...MARK_PACKAGE,
      'src/model.ts': MODEL,
      'src/aliases.ts': `import { Mark } from '@acme/mark'\nimport type { ${[
        ...new Set(ALIASES.map(name => name.replace(/<.*$/, ''))),
      ].join(', ')} } from './model.ts'\n\n@Mark()\nexport class Aliases {\n${methods}\n}\n`,
    })
    seen = (await analyzeMarked(app.root)).seen
  })
  afterAll(() => app.cleanup())

  it('applies aliases structurally (snapshot)', () => {
    const cls = seen.classes.get('Aliases') as ClassInfo
    const rendered = cls.methods.map(
      (method, index) => `## ${ALIASES[index]}\n${printResult(seen.types?.shape({ returnOf: method }) as ShapeResult)}`,
    )
    expect(rendered.join('\n\n')).toMatchSnapshot()
  })
})

describe('TypeHelpers.shape() on long chains of declarations', () => {
  it('follows 60 interfaces referencing each other without a recursion issue', async () => {
    const chain = Array.from(
      { length: 60 },
      (_, index) => `export interface Level${index} {\n  next${index < 59 ? `: Level${index + 1}` : ': string'}\n}`,
    ).join('\n')
    const app = tempApp({
      ...MARK_PACKAGE,
      'src/chain.ts': chain,
      'src/routes.ts': `import { Mark } from '@acme/mark'
import type { Level0 } from './chain.ts'
@Mark()
export class Routes {
  first(): Level0 {
    return null!
  }
}
`,
    })
    try {
      const { seen } = await analyzeMarked(app.root)
      const method = (seen.classes.get('Routes') as ClassInfo).methods[0]
      const result = seen.types?.shape({ returnOf: method as never }) as ShapeResult
      expect(result.named.size).toBe(60)
      expect(result.issues).toEqual([])
      expect(printShape(namedOf(result, 'src/chain.ts#Level59').shape)).toBe('{ next: string }')
    } finally {
      app.cleanup()
    }
  })
})

describe('TypeHelpers.shape() on enum members and key types', () => {
  const KEYS = `
export enum Kind {
  Cat = 'cat',
  Dog = 'dog',
}
export enum Genre {
  Novel = 'novel',
  Poetry = 'poetry',
}
export enum Level {
  Low,
  High,
}
export enum Single {
  Only = 'only',
}
export namespace Zoo {
  export enum Kind {
    Bird = 'bird',
  }
}
export interface Cat {
  kind: Kind.Cat
  meows: boolean
}
export interface Dog {
  kind: Kind.Dog
  barks: boolean
}
export type Pet = Cat | Dog
export type Status = 'draft' | 'live' | 'deleted'
export type Maybe = Cat | null
export interface Base {
  a: string
  b: number
  c: boolean
}
export type AB = 'a' | 'b'
export type AliasOfAB = AB
export interface Keyed {
  byGenre: Record<Genre, number>
  byLevel: Record<Level, string>
  bySingle: Record<Single, boolean>
  byStatus: Record<Status, number>
  mixed: Record<Genre | 'other' | 'novel', number>
  mapped: { [K in Genre]?: number }
  mappedAlias: { readonly [K in AliasOfAB]: K }
  picked: Pick<Base, AB>
  omitted: Omit<Base, AB>
  indexed: Base[AB]
  live: Exclude<Status, 'deleted'>
  poetry: Exclude<Genre, Genre.Novel>
  novel: Extract<Genre, 'novel'>
  cat: Exclude<Pet, Dog>
  pet: NonNullable<Pet>
  present: NonNullable<Maybe>
  bird: Zoo.Kind.Bird
  low: Level.Low
  both: Kind.Cat | Kind.Dog
}
`
  const ROUTES_KEYS = `
import { Mark } from '@acme/mark'
import type { Keyed, Pet } from './keys.ts'
import type * as keys from './keys.ts'

@Mark()
export class Routes {
  keyed(): Keyed {
    return null!
  }
  pet(): Pet {
    return null!
  }
  qualified(): keys.Kind.Dog {
    return null!
  }
  missing(): keys.Kind.Fish {
    return null!
  }
}
`
  let app: TempDir
  let seen: Seen
  let routes: ClassInfo

  beforeAll(async () => {
    app = tempApp({ ...MARK_PACKAGE, 'src/keys.ts': KEYS, 'src/routes.ts': ROUTES_KEYS })
    seen = (await analyzeMarked(app.root)).seen
    routes = seen.classes.get('Routes') as ClassInfo
  })
  afterAll(() => app.cleanup())

  const shapeOfMethod = (name: string): ShapeResult => {
    const found = routes.methods.find(candidate => candidate.name === name)
    if (!found || !seen.types) {
      throw new Error(`no method ${name}`)
    }
    return seen.types.shape({ returnOf: found })
  }

  it('resolves enum member types to their literal value (discriminated unions keep their tag)', () => {
    const pet = shapeOfMethod('pet')
    expect(printShape(namedOf(pet, 'src/keys.ts#Cat').shape)).toBe('{ kind: "cat"; meows: boolean }')
    expect(printShape(namedOf(pet, 'src/keys.ts#Dog').shape)).toBe('{ kind: "dog"; barks: boolean }')
    expect(pet.issues).toEqual([])
    // through a namespace import, and inside a namespace
    expect(printShape(shapeOfMethod('qualified').root)).toBe('"dog"')
  })

  it('reports an unknown enum member as unresolved', () => {
    const missing = shapeOfMethod('missing')
    expect(printShape(missing.root)).toBe('opaque(unresolved: keys.Kind.Fish)')
    expect(missing.issues.map(issue => issue.reason)).toEqual(['unresolved'])
  })

  it('iterates enums and aliases used as keys, and distributes utility types over them', () => {
    const keyed = shapeOfMethod('keyed')
    expect(keyed.issues).toEqual([])
    const shape = namedOf(keyed, 'src/keys.ts#Keyed').shape
    const properties = shape.kind === 'object' ? shape.properties : []
    expect(Object.fromEntries(properties.map(property => [property.name, printShape(property.shape)]))).toEqual({
      byGenre: '{ novel: number; poetry: number }',
      byLevel: '{ 0: string; 1: string }',
      bySingle: '{ only: boolean }',
      byStatus: '{ deleted: number; draft: number; live: number }',
      mixed: '{ novel: number; other: number; poetry: number }',
      mapped: '{ novel?: number; poetry?: number }',
      mappedAlias: '{ readonly a: "a"; readonly b: "b" }',
      picked: '{ a: string; b: number }',
      omitted: '{ c: boolean }',
      indexed: 'number | string',
      live: '"draft" | "live"',
      poetry: '"poetry"',
      novel: '"novel"',
      cat: '@src/keys.ts#Cat',
      // nothing removed: the alias keeps its name
      pet: '@src/keys.ts#Pet',
      present: '@src/keys.ts#Cat',
      bird: '"bird"',
      low: '0',
      both: '"cat" | "dog"',
    })
    // enums consumed as keys are not listed among the named shapes
    expect([...keyed.named.keys()]).toEqual([
      'src/keys.ts#Cat',
      'src/keys.ts#Dog',
      'src/keys.ts#Keyed',
      'src/keys.ts#Pet',
    ])
  })
})
