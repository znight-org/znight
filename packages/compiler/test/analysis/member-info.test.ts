/**
 * Additions of the extension API for RFC 0002 (still `apiVersion: 1`): JSDoc comments
 * (`ClassInfo.doc`, `MethodInfo.doc`, `PropertyInfo.doc`, `ParameterInfo.doc`), decorator type
 * arguments (`DecoratorInfo.typeArgs`) and parameter default values (`ParameterInfo.initializer`).
 */
import type { ClassInfo, DocComment } from '../../src/index.ts'
import type { TempDir } from '../project/helpers.ts'
import type { Seen } from '../shapes/helpers.ts'

import { docAt } from '../../src/analysis/jsdoc.ts'
import { SourceFile } from '../../src/project/index.ts'
import { analyzeMarked, MARK_PACKAGE } from '../shapes/helpers.ts'
import { tempApp } from './helpers.ts'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

/** The JSDoc of the first node starting with `marker` in `text`. */
function docBefore(text: string, marker: string): DocComment | undefined {
  const file = SourceFile.parse('/virtual/doc.ts', text) as SourceFile
  return docAt(file, text.indexOf(marker))
}

describe('JSDoc comments', () => {
  it('splits the text into summary and description, and reads block tags', () => {
    const doc = docBefore(
      `/**
 * List books
 *
 * Sorted and paginated, filtered by text,
 * author and tags.
 * @param search Case-insensitive search
 *   in titles and authors.
 * @param limit Page size.
 * @deprecated
 * @returns The page.
 */
export function list() {}
`,
      'export',
    )
    expect(doc).toMatchObject({
      text: 'List books\n\nSorted and paginated, filtered by text,\nauthor and tags.',
      summary: 'List books',
      description: 'Sorted and paginated, filtered by text,\nauthor and tags.',
    })
    expect(doc?.tags.map(tag => [tag.name, tag.text, tag.location.line, tag.location.column])).toEqual([
      ['param', 'search Case-insensitive search\n  in titles and authors.', 6, 4],
      ['param', 'limit Page size.', 8, 4],
      ['deprecated', '', 9, 4],
      ['returns', 'The page.', 10, 4],
    ])
    expect(doc?.location).toMatchObject({ line: 1, column: 1, endLine: 11 })
  })

  it('joins a wrapped first paragraph into the summary and keeps single-line comments', () => {
    expect(docBefore('/** Get a book */\nexport const get = 1\n', 'get')).toMatchObject({
      text: 'Get a book',
      summary: 'Get a book',
      description: undefined,
      tags: [],
    })
    expect(
      docBefore('/**\n * Lists the books of the shelf,\n * sorted by title.\n */\nclass A {}\n', 'class')?.summary,
    ).toBe('Lists the books of the shelf, sorted by title.')
    expect(docBefore('/** @internal */\ntype X = 1\n', 'type')).toMatchObject({
      text: '',
      summary: undefined,
      tags: [{ name: 'internal', text: '' }],
    })
  })

  it('keeps @example code (line breaks, indentation, @ inside fences)', () => {
    const doc = docBefore(
      `/**
 * Text.
 * @example
 * \`\`\`ts
 * @Get()
 *   list() {}
 * \`\`\`
 * @default 20
 */
export const x = 1
`,
      'export',
    )
    expect(doc?.tags.map(tag => [tag.name, tag.text])).toEqual([
      ['example', '```ts\n@Get()\n  list() {}\n```'],
      ['default', '20'],
    ])
  })

  it('attaches the nearest JSDoc block through modifiers, decorators and other comments only', () => {
    expect(docBefore('/** A */\n// lint\n/* other */\nexport default class X {}\n', 'export')?.text).toBe('A')
    expect(docBefore('/** A */\nexport declare const enum E { A }\n', 'export')?.text).toBe('A')
    expect(docBefore('/** A */\nconst a = 1\nconst b = 2\n', 'const b')).toBeUndefined()
    expect(docBefore('/* not a doc */\nclass A {}\n', 'class')).toBeUndefined()
    expect(docBefore('/*** banner ***/\nclass A {}\n', 'class')).toBeUndefined()
    expect(docBefore('class A {}\n', 'class')).toBeUndefined()
  })
})

const SOURCES = {
  'src/model.ts': `
import { Injectable } from '@znight/core'
export const PAGE = 20
export type Sort = 'title' | 'year'
@Injectable()
export class Clock {}
`,
  'src/routes.ts': `
import { Arg, Mark, Returns } from '@acme/mark'
import { Clock, PAGE, type Sort } from './model.ts'

/**
 * Books of the shelf.
 * @tag books
 */
@Mark()
export class BookRoutes {
  /** The default sort. */
  sort: Sort = 'title'

  constructor(
    /** Shared clock. */
    readonly clock: Clock,
  ) {}

  /**
   * List books
   * @param limit Page size.
   */
  @Returns<readonly Sort[]>(200)
  list(@Arg() limit = PAGE, @Arg() sort: Sort = 'title', @Arg() at = new Date(), @Arg() clock = Clock, q?: string): void {}

  @Returns<T>(200)
  @Returns(204)
  generic<T>(): void {}
}
`,
}

describe('ClassInfo additions', () => {
  let app: TempDir
  let seen: Seen
  let routes: ClassInfo

  beforeAll(async () => {
    app = tempApp({ ...MARK_PACKAGE, ...SOURCES })
    const analysis = await analyzeMarked(app.root)
    expect(analysis.result.diagnostics).toEqual([])
    seen = analysis.seen
    routes = seen.classes.get('BookRoutes') as ClassInfo
  })
  afterAll(() => app.cleanup())

  it('exposes the JSDoc of classes, methods, properties and parameter properties', () => {
    expect(routes.doc).toMatchObject({ summary: 'Books of the shelf.', tags: [{ name: 'tag', text: 'books' }] })
    expect(routes.methods[0]?.doc).toMatchObject({
      summary: 'List books',
      tags: [{ name: 'param', text: 'limit Page size.' }],
    })
    expect(routes.methods[1]?.doc).toBeUndefined()
    expect(routes.properties[0]?.doc?.text).toBe('The default sort.')
    expect(routes.ctor.params[0]?.doc?.text).toBe('Shared clock.')
    expect(routes.methods[0]?.params[0]?.doc).toBeUndefined()
  })

  it('evaluates parameter default values as value arguments, without diagnostics', () => {
    const params = routes.methods[0]?.params ?? []
    expect(params.map(param => [param.name, param.hasDefault, param.initializer?.evaluated])).toEqual([
      ['limit', true, true],
      ['sort', true, true],
      ['at', true, false],
      ['clock', true, false],
      ['q', false, undefined],
    ])
    expect(params[0]?.initializer).toMatchObject({ kind: 'value', value: 20, text: 'PAGE' })
    expect(params[1]?.initializer?.value).toBe('title')
    expect(params[2]?.initializer?.error).toContain('not statically evaluable')
    expect(params[3]?.initializer?.ref?.identity).toBe('src/model.ts#Clock')
    expect(params[0]?.initializer?.location.line).toBe(24)
  })

  it('resolves the type arguments of decorator calls', () => {
    const format = (types: ClassInfo['decorators'][number]['typeArgs']): string[] =>
      types.map(type => seen.types?.format(type) ?? '')
    expect(format(routes.methods[0]?.decorators[0]?.typeArgs ?? [])).toEqual(['("title" | "year")[]'])
    expect(format(routes.methods[1]?.decorators[0]?.typeArgs ?? [])).toEqual(['T'])
    expect(routes.methods[1]?.decorators[1]?.typeArgs).toEqual([])
    expect(routes.decorators[0]?.typeArgs).toEqual([])
  })
})
