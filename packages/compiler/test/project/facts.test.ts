import type { Declaration, FileFacts } from '../../src/project/index.ts'

import { namespaceFacts, SourceFile } from '../../src/project/index.ts'
import { describe, expect, test as it } from 'bun:test'

function factsOf(text: string, path = '/virtual/file.ts'): FileFacts {
  const file = SourceFile.parse(path, text)
  if (!file) {
    throw new Error('not parseable')
  }
  expect(file.parseErrors).toEqual([])
  return file.facts
}

function only(facts: FileFacts, name: string): Declaration {
  const declarations = facts.declarations.get(name)
  expect(declarations).toHaveLength(1)
  return declarations?.[0] as Declaration
}

describe('imports', () => {
  const facts = factsOf(`
    import Default, { named, other as renamed, type TypeOnly, "string name" as fromString } from './a.ts'
    import * as ns from 'pkg'
    import type { Whole } from './types.ts'
    import type DefaultType from './dt.ts'
    import './side-effect.ts'
    import legacy = require('legacy')
  `)

  it('records one binding per local name', () => {
    expect([...facts.imports.keys()].sort()).toEqual(
      ['Default', 'DefaultType', 'TypeOnly', 'Whole', 'fromString', 'legacy', 'named', 'ns', 'renamed'].sort(),
    )
  })

  it('distinguishes named, default, namespace and require imports', () => {
    expect(facts.imports.get('Default')).toMatchObject({
      kind: 'default',
      imported: 'default',
      specifier: './a.ts',
      typeOnly: false,
    })
    expect(facts.imports.get('renamed')).toMatchObject({ kind: 'named', imported: 'other', local: 'renamed' })
    expect(facts.imports.get('fromString')).toMatchObject({ kind: 'named', imported: 'string name' })
    expect(facts.imports.get('ns')).toMatchObject({ kind: 'namespace', imported: '*', specifier: 'pkg' })
    expect(facts.imports.get('legacy')).toMatchObject({ kind: 'require', imported: '*', specifier: 'legacy' })
  })

  it('flags type-only imports (statement and specifier level)', () => {
    expect(facts.imports.get('TypeOnly')?.typeOnly).toBe(true)
    expect(facts.imports.get('named')?.typeOnly).toBe(false)
    expect(facts.imports.get('Whole')?.typeOnly).toBe(true)
    expect(facts.imports.get('DefaultType')).toMatchObject({ kind: 'default', typeOnly: true })
  })

  it('records spans of the local name and of the specifier literal', () => {
    const file = SourceFile.parse('/virtual/a.ts', "import { a as b } from './x.ts'") as SourceFile
    const binding = file.facts.imports.get('b')
    expect(file.textOf(binding?.span ?? { start: 0, end: 0 })).toBe('b')
    expect(file.textOf(binding?.specifierSpan ?? { start: 0, end: 0 })).toBe("'./x.ts'")
  })

  it('lists every module request in source order, side-effect imports included', () => {
    expect(facts.moduleRequests.map(request => request.specifier)).toEqual([
      './a.ts',
      'pkg',
      './types.ts',
      './dt.ts',
      './side-effect.ts',
      'legacy',
    ])
    expect(facts.hasModuleSyntax).toBe(true)
  })
})

describe('exports', () => {
  const facts = factsOf(`
    export class A {}
    export interface I {}
    export type T = string
    export const x = 1, y = 2
    export function f(): void {}
    export enum E { A }
    const local = 1
    class Hidden {}
    export { local as aliased, Hidden }
    export { local as "string name" }
    export { a as reexported, default as Def, type Ty } from './other.ts'
    export type { Only } from './types.ts'
    export * from './star.ts'
    export type * from './types-star.ts'
    export * as ns from './ns.ts'
    export default local
  `)

  it('records local exports of declarations', () => {
    for (const name of ['A', 'I', 'T', 'x', 'y', 'f', 'E']) {
      expect(facts.exports.get(name)).toMatchObject({ kind: 'local', exported: name, local: name })
    }
    expect(facts.exports.get('I')?.typeOnly).toBe(true)
    expect(facts.exports.get('T')?.typeOnly).toBe(true)
    expect(facts.exports.get('A')?.typeOnly).toBe(false)
  })

  it('records aliased local exports and string export names', () => {
    expect(facts.exports.get('aliased')).toMatchObject({ kind: 'local', local: 'local' })
    expect(facts.exports.get('Hidden')).toMatchObject({ kind: 'local', local: 'Hidden' })
    expect(facts.exports.get('string name')).toMatchObject({ kind: 'local', local: 'local' })
    expect(facts.exports.get('default')).toMatchObject({ kind: 'local', local: 'local' })
  })

  it('records named re-exports (default and type-only included)', () => {
    expect(facts.exports.get('reexported')).toMatchObject({
      kind: 'reexport',
      imported: 'a',
      specifier: './other.ts',
      typeOnly: false,
    })
    expect(facts.exports.get('Def')).toMatchObject({ kind: 'reexport', imported: 'default' })
    expect(facts.exports.get('Ty')).toMatchObject({ kind: 'reexport', imported: 'Ty', typeOnly: true })
    expect(facts.exports.get('Only')).toMatchObject({ kind: 'reexport', typeOnly: true })
  })

  it('records export * and export * as ns', () => {
    expect(facts.starExports.map(star => [star.specifier, star.typeOnly])).toEqual([
      ['./star.ts', false],
      ['./types-star.ts', true],
    ])
    expect(facts.exports.get('ns')).toMatchObject({ kind: 'namespace', specifier: './ns.ts' })
  })

  it('module requests include re-exports', () => {
    expect(facts.moduleRequests.map(request => request.specifier)).toEqual([
      './other.ts',
      './types.ts',
      './star.ts',
      './types-star.ts',
      './ns.ts',
    ])
  })
})

describe('default exports', () => {
  it('named class / function declarations are declared and exported as default', () => {
    const facts = factsOf('export default class Service {}')
    expect(only(facts, 'Service').kind).toBe('class')
    expect(facts.exports.get('default')).toMatchObject({ kind: 'local', local: 'Service' })
    expect(factsOf('export default function make() {}').exports.get('default')).toMatchObject({ local: 'make' })
  })

  it('anonymous class / function declarations are declared under the name `default`', () => {
    const facts = factsOf('export default class {}')
    expect(only(facts, 'default')).toMatchObject({ kind: 'class', anonymous: true, name: 'default' })
    expect(facts.exports.get('default')).toMatchObject({ kind: 'local', local: 'default' })
    expect(only(factsOf('export default function () {}'), 'default')).toMatchObject({
      kind: 'function',
      anonymous: true,
    })
  })

  it('other expressions are expression exports', () => {
    const facts = factsOf('export default { port: 1 }')
    expect(facts.exports.get('default')).toMatchObject({ kind: 'expression' })
    expect(facts.exports.get('default')?.kind === 'expression' && facts.exports.get('default')).toBeTruthy()
    expect(facts.declarations.size).toBe(0)
  })
})

describe('declarations', () => {
  it('records every top-level declaration kind', () => {
    const facts = factsOf(`
      class C {}
      abstract class Abstract {}
      interface I {}
      type T = number
      enum E { A }
      function f() {}
      const c = 1
      let l = 1
      var v = 1
      namespace N { export const a = 1 }
      declare const ambient: string
    `)
    expect(
      [...facts.declarations.entries()].map(([name, declarations]) => [name, declarations.map(d => d.kind).join()]),
    ).toEqual([
      ['C', 'class'],
      ['Abstract', 'class'],
      ['I', 'interface'],
      ['T', 'type'],
      ['E', 'enum'],
      ['f', 'function'],
      ['c', 'const'],
      ['l', 'let'],
      ['v', 'var'],
      ['N', 'namespace'],
      ['ambient', 'const'],
    ])
    expect(only(facts, 'ambient').ambient).toBe(true)
    expect(only(facts, 'C').ambient).toBe(false)
  })

  it('keeps merged declarations together, in source order', () => {
    const facts = factsOf(`
      export function overload(a: string): void
      export function overload(a: number): void
      export function overload(a: unknown): void {}
      interface Merged { a: string }
      interface Merged { b: string }
      export class Merged {}
    `)
    expect(facts.declarations.get('overload')?.map(d => d.kind)).toEqual(['function', 'function', 'function'])
    expect(facts.declarations.get('Merged')?.map(d => d.kind)).toEqual(['interface', 'interface', 'class'])
  })

  it('records variables bound by destructuring patterns', () => {
    const facts = factsOf('export const { a, b: renamed, c = 1, ...rest } = obj, [first, , third] = list')
    for (const name of ['a', 'renamed', 'c', 'rest', 'first', 'third']) {
      expect(only(facts, name)).toMatchObject({ kind: 'const', destructured: true })
      expect(facts.exports.get(name)).toMatchObject({ kind: 'local', local: name })
    }
  })

  it('marks every declaration of a declaration file as ambient', () => {
    const facts = factsOf('export class A {}\nexport interface B {}', '/virtual/types.d.ts')
    expect(only(facts, 'A').ambient).toBe(true)
  })

  it('ignores ambient module and global augmentations', () => {
    const facts = factsOf("declare module 'x' { export class A {} }\ndeclare global { interface Window {} }\nexport {}")
    expect(facts.declarations.size).toBe(0)
  })

  it('records `export =`', () => {
    const facts = factsOf('declare namespace lib { class A {} }\nexport = lib', '/virtual/index.d.ts')
    expect(facts.exportAssignment?.expression).toMatchObject({ type: 'Identifier', name: 'lib' })
    expect(facts.hasModuleSyntax).toBe(true)
  })

  it('files without import/export statements have no module syntax', () => {
    expect(factsOf('const a = 1').hasModuleSyntax).toBe(false)
  })
})

describe('namespaceFacts', () => {
  it('collects explicitly exported members with dotted names', () => {
    const facts = factsOf(`
      export namespace Outer {
        export class A {}
        class Hidden {}
        export namespace Inner { export interface Leaf {} }
      }
    `)
    const outer = only(facts, 'Outer')
    const members = namespaceFacts(outer)
    expect([...members.exports.keys()]).toEqual(['A', 'Inner'])
    expect(members.declarations.get('Hidden')?.[0]).toMatchObject({ name: 'Outer.Hidden', localName: 'Hidden' })
    const inner = members.declarations.get('Inner')?.[0] as Declaration
    expect(inner).toMatchObject({ name: 'Outer.Inner', kind: 'namespace', namespace: outer })
    expect(namespaceFacts(inner).declarations.get('Leaf')?.[0]?.name).toBe('Outer.Inner.Leaf')
  })

  it('exports every member of an ambient namespace without explicit exports', () => {
    const facts = factsOf(
      'declare namespace pg { class Pool {} interface Config {} const VERSION: string }',
      '/virtual/pg.d.ts',
    )
    expect([...namespaceFacts(only(facts, 'pg')).exports.keys()]).toEqual(['Pool', 'Config', 'VERSION'])
  })

  it('honours an explicit export list in an ambient namespace (tsdown `export * as ns` output)', () => {
    const facts = factsOf(
      'declare namespace tokens_d_exports { export { TOKEN, Holder } }\ndeclare const TOKEN = "a"\ndeclare class Holder {}\ndeclare class Other {}',
      '/virtual/index.d.mts',
    )
    const members = namespaceFacts(only(facts, 'tokens_d_exports'))
    expect([...members.exports.keys()]).toEqual(['TOKEN', 'Holder'])
    expect(members.declarations.size).toBe(0)
  })

  it('caches results per node and returns empty facts for non-namespaces', () => {
    const facts = factsOf('export namespace N { export const a = 1 }\nexport class C {}')
    expect(namespaceFacts(only(facts, 'N'))).toBe(namespaceFacts(only(facts, 'N')))
    expect(namespaceFacts(only(facts, 'C')).exports.size).toBe(0)
  })
})
