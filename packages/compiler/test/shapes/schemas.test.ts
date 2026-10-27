/**
 * Schema aliases of `TypeHelpers.shape()`: `z.output<typeof S>` and the like are matched before
 * alias expansion and become `{ kind: 'schema', ref, io }`; aliases of them are transparent.
 * Tested on a library shaped like Zod, and on the installed Zod, Valibot and ArkType declarations.
 */
import type { ClassInfo, ShapeOptions, ShapeResult } from '../../src/index.ts'
import type { TempDir } from '../project/helpers.ts'
import type { Seen } from './helpers.ts'

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { tempApp } from '../analysis/helpers.ts'
import { analyzeMarked, MARK_PACKAGE, namedOf, printResult, printShape } from './helpers.ts'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

const FAKE_ZOD = {
  'node_modules/fakezod/package.json': JSON.stringify({
    name: 'fakezod',
    version: '1.0.0',
    type: 'module',
    exports: { '.': { types: './index.d.ts', default: './index.js' } },
  }),
  'node_modules/fakezod/index.d.ts': "export * as z from './core.js'\nexport type { output, input } from './core.js'\n",
  'node_modules/fakezod/core.d.ts': `export interface ZodType<O = unknown, I = O> {
  readonly _zod: { readonly output: O; readonly input: I }
}
export type output<T> = T extends { _zod: { output: any } } ? T['_zod']['output'] : unknown
export type input<T> = T extends { _zod: { input: any } } ? T['_zod']['input'] : unknown
export type { output as infer }
export declare function object<T>(shape: T): ZodType<T>
export declare function string(): ZodType<string>
`,
  'node_modules/fakezod/index.js': 'export const z = {}\n',
}

const OPTIONS: ShapeOptions = {
  schemaAliases: { 'fakezod#output': 'output', 'fakezod#input': 'input' },
  schemaMembers: { infer: 'output', inferIn: 'input' },
}

describe('schema aliases', () => {
  let app: TempDir
  let seen: Seen
  let routes: ClassInfo

  beforeAll(async () => {
    app = tempApp({
      ...MARK_PACKAGE,
      ...FAKE_ZOD,
      'src/schemas.ts': `import { z } from 'fakezod'
export const CreateBook = z.object({ title: z.string() })
/** The validated input. */
export type CreateBook = z.output<typeof CreateBook>
export type Out<S> = z.output<S>
export type CreateBookSchema = typeof CreateBook
export namespace Schemas {
  export const Nested = z.object({})
}
export const Ark = { infer: null as unknown, inferIn: null as unknown }
export interface Created {
  book: z.output<typeof CreateBook>
  input: z.input<typeof CreateBook>
  list: CreateBook[]
}
`,
      'src/routes.ts': `import { Mark } from '@acme/mark'
import type { z } from 'fakezod'
import type { output } from 'fakezod'
import { Ark, CreateBook, type Created, type CreateBookSchema, type Out, Schemas } from './schemas.ts'

@Mark()
export class Routes {
  alias(): Promise<CreateBook> {
    return null!
  }
  generic(): Out<typeof CreateBook> {
    return null!
  }
  nested(): Created {
    return null!
  }
  namespaced(): z.output<typeof Schemas.Nested> {
    return null!
  }
  hops(): output<CreateBookSchema> {
    return null!
  }
  ark(): typeof Ark.infer {
    return null!
  }
  arkIn(): (typeof Ark.inferIn)[] {
    return null!
  }
  notASchema(): z.output<string> {
    return null!
  }
}
`,
    })
    seen = (await analyzeMarked(app.root)).seen
    routes = seen.classes.get('Routes') as ClassInfo
  })
  afterAll(() => app.cleanup())

  const shapeOf = (name: string, options: ShapeOptions = OPTIONS): ShapeResult => {
    const method = routes.methods.find(candidate => candidate.name === name)
    if (!method || !seen.types) {
      throw new Error(`no method ${name}`)
    }
    return seen.types.shape({ returnOf: method }, options)
  }

  it('matches schema aliases before expansion, through aliases, generics, namespaces and members', () => {
    const alias = shapeOf('alias')
    expect(alias.root).toMatchObject({ kind: 'schema', io: 'output', ref: { identity: 'src/schemas.ts#CreateBook' } })
    expect(alias.named.size).toBe(0)
    expect(alias.issues).toEqual([])
    const generic = shapeOf('generic')
    expect(printShape(generic.root)).toBe('schema(CreateBook, output)')
    expect(generic.issues).toEqual([])
    expect(printShape(shapeOf('namespaced').root)).toBe('schema(Schemas.Nested, output)')
    expect(shapeOf('namespaced').root).toMatchObject({ ref: { identity: 'src/schemas.ts#Schemas.Nested' } })
    expect(printShape(shapeOf('hops').root)).toBe('schema(CreateBook, output)')
    expect(printShape(shapeOf('ark').root)).toBe('schema(Ark, output)')
    expect(printShape(shapeOf('arkIn').root)).toBe('schema(Ark, input)[]')
    const nested = shapeOf('nested')
    expect(printShape(namedOf(nested, 'src/schemas.ts#Created').shape)).toBe(
      '{ book: schema(CreateBook, output); input: schema(CreateBook, input); list: schema(CreateBook, output)[] }',
    )
  })

  it('falls back to the alias structure when the argument is not a schema, or without options', () => {
    expect(printResult(shapeOf('notASchema'))).toMatchSnapshot()
    const plain = shapeOf('alias', {})
    expect(printShape(plain.root)).toBe('@src/schemas.ts#CreateBook')
    // sorted by named shape: fakezod#output<...> (the conditional), then the alias (typeof CreateBook)
    expect(plain.issues.map(issue => [issue.reason, issue.named])).toEqual([
      ['conditional', 'fakezod#output<opaque("typeof CreateBook")>'],
      ['typeof', 'src/schemas.ts#CreateBook'],
    ])
  })

  it('the schema ref can be imported by the generated module', () => {
    const root = shapeOf('alias').root
    expect(root.kind === 'schema' ? root.ref.symbol.kind : undefined).toBe('declaration')
    // located where `typeof CreateBook` is written: the alias body
    expect(root.kind === 'schema' ? root.ref.location : undefined).toMatchObject({
      file: `${app.root}/src/schemas.ts`,
      line: 4,
    })
  })
})

/** `packages/openapi/node_modules/<name>` (its devDependencies), when installed. */
function installed(name: string): string | undefined {
  const path = fileURLToPath(new URL(`../../../openapi/node_modules/${name}`, import.meta.url))
  return fs.existsSync(path) ? fs.realpathSync(path) : undefined
}

const ZOD = installed('zod')
const VALIBOT = installed('valibot')
const ARKTYPE = installed('arktype')

describe.skipIf(!ZOD || !VALIBOT || !ARKTYPE)('schema aliases of the installed libraries', () => {
  it('resolves Zod, Valibot and ArkType from their declarations', async () => {
    const app = tempApp({
      ...MARK_PACKAGE,
      'src/app.ts': `import { Mark } from '@acme/mark'
import { type } from 'arktype'
import * as v from 'valibot'
import { z } from 'zod'

export const CreateBook = z.object({ title: z.string() })
export const NewOrder = v.object({ id: v.string() })
export const Ark = type({ name: 'string' })

@Mark()
export class Routes {
  zodOutput(): z.output<typeof CreateBook> { return null! }
  zodInfer(): z.infer<typeof CreateBook> { return null! }
  zodInput(): z.input<typeof CreateBook> { return null! }
  valibotOutput(): v.InferOutput<typeof NewOrder> { return null! }
  valibotInput(): v.InferInput<typeof NewOrder> { return null! }
  arkOutput(): typeof Ark.infer { return null! }
  arkInput(): typeof Ark.inferIn { return null! }
}
`,
    })
    fs.symlinkSync(ZOD as string, `${app.root}/node_modules/zod`, 'dir')
    fs.symlinkSync(VALIBOT as string, `${app.root}/node_modules/valibot`, 'dir')
    fs.symlinkSync(ARKTYPE as string, `${app.root}/node_modules/arktype`, 'dir')
    try {
      const { seen } = await analyzeMarked(app.root)
      const routes = seen.classes.get('Routes') as ClassInfo
      const options: ShapeOptions = {
        schemaAliases: {
          'zod#output': 'output',
          'zod#infer': 'output',
          'zod#input': 'input',
          'valibot#InferOutput': 'output',
          'valibot#InferInput': 'input',
        },
        schemaMembers: { infer: 'output', inferIn: 'input' },
      }
      expect(
        routes.methods.map(method => printShape(seen.types?.shape({ returnOf: method }, options).root as never)),
      ).toEqual([
        'schema(CreateBook, output)',
        'schema(CreateBook, output)',
        'schema(CreateBook, input)',
        'schema(NewOrder, output)',
        'schema(NewOrder, input)',
        'schema(Ark, output)',
        'schema(Ark, input)',
      ])
    } finally {
      app.cleanup()
    }
  })
})
