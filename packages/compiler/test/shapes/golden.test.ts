/**
 * Golden test of `TypeHelpers.shape()` (RFC 0002 §13.3): the same library gives identical shapes
 * (structure, keys, JSDoc) whether it is resolved to its TypeScript sources or to the declaration
 * files a build publishes.
 */
import type { NamedShape, ShapeResult } from '../../src/index.ts'
import type { TempDir } from '../project/helpers.ts'

import fs from 'node:fs'

import { tempApp } from '../analysis/helpers.ts'
import { analyzeMarked, MARK_PACKAGE, printShape } from './helpers.ts'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

const SOURCES = {
  'src/index.ts': "export * from './book.ts'\nexport * from './shelf.ts'\n",
  'src/book.ts': `/** A book of the shelf. */
export interface Book {
  /**
   * Identifier.
   * @minimum 1
   */
  readonly id: number
  title: string
  tags?: string[]
  status: Status
}

/** A page of results. */
export interface Page<T> {
  items: T[]
  total: number
}

export type BookPage = Page<Book>

/** Publication status. */
export enum Status {
  Draft = 'draft',
  Live = 'live',
}

export type Patch = Partial<Pick<Book, 'title' | 'tags'>>
`,
  'src/shelf.ts': `import type { Book } from './book.ts'

export class Base {
  /** Creation date. */
  readonly createdAt: Date = new Date()
}

export class Shelf extends Base {
  /** Name of the shelf. */
  readonly name: string = 'main'
  private count = 0
  books: Book[] = []

  constructor(
    /** Shelf id. */
    readonly id: number,
    public owner?: string,
  ) {
    super()
  }

  get size(): number {
    return this.count
  }
}

export class Money {
  constructor(private readonly cents: number) {}

  toJSON(): string {
    return String(this.cents)
  }
}
`,
}

/** What `tsc --declaration` (isolated declarations) emits for {@link SOURCES}. */
const DECLARATIONS = {
  'dist/index.d.ts': "export * from './book.js';\nexport * from './shelf.js';\n",
  'dist/book.d.ts': `/** A book of the shelf. */
export interface Book {
    /**
     * Identifier.
     * @minimum 1
     */
    readonly id: number;
    title: string;
    tags?: string[];
    status: Status;
}
/** A page of results. */
export interface Page<T> {
    items: T[];
    total: number;
}
export type BookPage = Page<Book>;
/** Publication status. */
export declare enum Status {
    Draft = "draft",
    Live = "live"
}
export type Patch = Partial<Pick<Book, 'title' | 'tags'>>;
`,
  'dist/shelf.d.ts': `import type { Book } from './book.js';
export declare class Base {
    /** Creation date. */
    readonly createdAt: Date;
}
export declare class Shelf extends Base {
    /** Shelf id. */
    readonly id: number;
    owner?: string | undefined;
    /** Name of the shelf. */
    readonly name: string;
    private count;
    books: Book[];
    constructor(
    /** Shelf id. */
    id: number, owner?: string);
    get size(): number;
}
export declare class Money {
    private readonly cents;
    constructor(cents: number);
    toJSON(): string;
}
`,
  'dist/index.js': 'export {}\n',
}

const ROUTES = `import { Mark } from '@acme/mark'
import type { BookPage, Money, Patch, Shelf } from '@acme/models'

@Mark()
export class Routes {
  page(): BookPage {
    return null!
  }
  patch(): Patch {
    return null!
  }
  shelf(): Promise<Shelf> {
    return null!
  }
  money(): Money[] {
    return null!
  }
}
`

/** Shapes without locations (they point to the sources or to the declarations). */
function comparable(result: ShapeResult): unknown {
  const named = [...result.named.values()].map((entry: NamedShape) => ({
    key: entry.key,
    declaration: entry.declaration,
    shape: printShape(entry.shape),
    doc: entry.doc?.text,
    properties:
      entry.shape.kind === 'object'
        ? entry.shape.properties.map(property => [
            property.name,
            property.doc?.text,
            property.doc?.tags.map(tag => tag.name),
          ])
        : [],
  }))
  return { root: printShape(result.root), named, issues: result.issues.map(issue => [issue.reason, issue.path]) }
}

describe('shapes from sources and from declaration files', () => {
  let library: TempDir
  const apps: TempDir[] = []

  beforeAll(() => {
    library = tempApp({ ...SOURCES, ...DECLARATIONS })
    library.write(
      'package.json',
      JSON.stringify({
        name: '@acme/models',
        version: '1.0.0',
        type: 'module',
        exports: { '.': { 'acme-source': './src/index.ts', types: './dist/index.d.ts', default: './dist/index.js' } },
      }),
    )
  })
  afterAll(() => {
    for (const app of apps) {
      app.cleanup()
    }
    library.cleanup()
  })

  async function shapesOf(conditions: string[]): Promise<Record<string, unknown>> {
    const app = tempApp({ ...MARK_PACKAGE, 'src/routes.ts': ROUTES })
    apps.push(app)
    fs.mkdirSync(`${app.root}/node_modules/@acme`, { recursive: true })
    fs.symlinkSync(library.root, `${app.root}/node_modules/@acme/models`, 'dir')
    const { seen, result } = await analyzeMarkedWith(app.root, conditions)
    expect(result).toEqual([])
    const routes = seen.classes.get('Routes')
    const shapes: Record<string, unknown> = {}
    for (const method of routes?.methods ?? []) {
      shapes[method.name] = comparable(seen.types?.shape({ returnOf: method }) as ShapeResult)
    }
    return shapes
  }

  it('gives byte-identical shapes, keys and JSDoc', async () => {
    const fromSources = await shapesOf(['acme-source'])
    const fromDeclarations = await shapesOf([])
    expect(fromSources).toEqual(fromDeclarations)
    expect(fromSources).toMatchSnapshot()
  })
})

async function analyzeMarkedWith(
  root: string,
  conditions: string[],
): Promise<{ readonly seen: Awaited<ReturnType<typeof analyzeMarked>>['seen']; readonly result: unknown[] }> {
  const { seen, result } = await analyzeMarked(root, undefined, { conditions: ['@znight/source', ...conditions] })
  return { seen, result: [...result.diagnostics] }
}
