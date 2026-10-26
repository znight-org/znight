import type { SymbolResolution } from '../../src/project/index.ts'

import { APP, appProject, fileOf } from './helpers.ts'
import { describe, expect, test as it } from 'bun:test'

const project = appProject({ conditions: ['@znight/source'] })

/** `<path relative to the app>#<declaration name>` of a declaration symbol, or the symbol kind. */
function where(symbol: SymbolResolution): string {
  switch (symbol.kind) {
    case 'declaration':
      return `${symbol.declaration.file.slice(APP.length + 1)}#${symbol.declaration.name}`
    case 'module':
      return `module:${symbol.file.slice(APP.length + 1)}`
    case 'external':
      return `external:${symbol.specifier}#${symbol.path.join('.')}`
    case 'global':
      return `global:${symbol.name}`
    case 'expression':
      return `expression:${symbol.file.slice(APP.length + 1)}`
    case 'unresolved':
      return `unresolved:${symbol.reason}`
  }
}

describe('SymbolResolver', () => {
  const main = fileOf(project, 'src/main.ts')
  const resolve = (name: string, file = main): string => where(project.resolveIdentifier(file, name).symbol)

  it('follows imports through barrels, renames and tsconfig paths', () => {
    expect(resolve('UserService')).toBe('src/users/user.service.ts#UserService')
    expect(resolve('DefaultUserRepository')).toBe('src/users/user.repository.ts#PgUserRepository')
    expect(resolve('Aliased')).toBe('src/users/user.service.ts#UserService')
    expect(resolve('formatName')).toBe('shared/format.ts#formatName')
  })

  it('resolves namespace imports and `export * as ns`', () => {
    expect(resolve('models')).toBe('module:src/users/user.model.ts')
    expect(resolve('models.User')).toBe('src/users/user.model.ts#User')
    expect(resolve('models.Missing')).toBe('unresolved:export-not-found')
  })

  it('maps member access on a default import to the module export (pg.Pool → Pool)', () => {
    expect(resolve('pg.Pool')).toBe('node_modules/@types/pg/index.d.ts#Pool')
    expect(resolve('Pool')).toBe('node_modules/@types/pg/index.d.ts#Pool')
  })

  it('untyped CommonJS packages and builtins are externals', () => {
    expect(resolve('cjs')).toBe('external:cjs-only#default')
    expect(resolve('cjs.Thing')).toBe('external:cjs-only#Thing')
    expect(resolve('EventEmitter')).toBe('external:node:events#EventEmitter')
    expect(resolve('fs')).toBe('external:node:fs#default')
  })

  it('undeclared names are globals', () => {
    expect(resolve('Promise')).toBe('global:Promise')
    expect(resolve('Promise.resolve')).toBe('unresolved:not-a-namespace')
  })

  it('resolves `export =` namespaces (import x = require())', () => {
    const legacy = fileOf(project, 'src/legacy.ts')
    expect(resolve('legacy', legacy)).toBe('node_modules/legacy-ns/index.d.ts#legacy')
    expect(resolve('legacy.Client', legacy)).toBe('node_modules/legacy-ns/index.d.ts#legacy.Client')
    expect(resolve('legacy.VERSION', legacy)).toBe('node_modules/legacy-ns/index.d.ts#legacy.VERSION')
  })

  it('resolves namespace declarations, nested', () => {
    const ns = fileOf(project, 'src/ns.ts')
    expect(resolve('Models.Inner', ns)).toBe('src/ns.ts#Models.Inner')
    expect(resolve('Models.Deep.Leaf', ns)).toBe('src/ns.ts#Models.Deep.Leaf')
    expect(resolve('Models.Hidden', ns)).toBe('unresolved:export-not-found')
  })

  it('picks the declaration matching the meaning among merged declarations', () => {
    const merged = fileOf(project, 'src/merged.ts')
    expect(project.resolveIdentifier(merged, 'Settings', 'type').symbol).toMatchObject({
      declaration: { kind: 'type' },
    })
    expect(project.resolveIdentifier(merged, 'Settings', 'value').symbol).toMatchObject({
      declaration: { kind: 'const' },
    })
    const clock = project.resolveIdentifier(merged, 'Clock').symbol
    expect(clock).toMatchObject({ declaration: { kind: 'class' } })
    expect(clock.kind === 'declaration' && clock.declarations.map(d => d.kind)).toEqual(['interface', 'class'])
  })

  it('accepts identifiers, member expressions and qualified type names', () => {
    const service = fileOf(project, 'src/users/user.service.ts')
    const ctor = service.program.body
      .flatMap(statement =>
        statement.type === 'ExportNamedDeclaration' && statement.declaration?.type === 'ClassDeclaration'
          ? statement.declaration.body.body
          : [],
      )
      .find(member => member.type === 'MethodDefinition' && member.kind === 'constructor')
    const params = ctor?.type === 'MethodDefinition' ? ctor.value.params : []
    const annotations = params.map(param =>
      param.type === 'TSParameterProperty' ? param.parameter.typeAnnotation?.typeAnnotation : undefined,
    )
    const names = annotations.map(annotation =>
      annotation?.type === 'TSTypeReference' ? annotation.typeName : undefined,
    )
    expect(names.map(name => (name ? where(project.resolveIdentifier(service, name).symbol) : undefined))).toEqual([
      'src/users/user.repository.ts#UserRepository',
      'node_modules/@fixture/lib/src/logging/logger.ts#Logger',
      'src/users/user.model.ts#User',
    ])
  })
})

describe('re-export graphs', () => {
  const barrel = (name: string): string => `${APP}/src/barrels/${name}.ts`

  it('export * cycles terminate and find every name', () => {
    expect(where(project.resolveExport(barrel('a'), 'B'))).toBe('src/barrels/b.ts#B')
    expect(where(project.resolveExport(barrel('a'), 'C'))).toBe('src/barrels/c.ts#C')
    expect(where(project.resolveExport(barrel('b'), 'A'))).toBe('src/barrels/a.ts#A')
    expect(where(project.resolveExport(barrel('c'), 'A'))).toBe('unresolved:export-not-found')
    expect(where(project.resolveExport(barrel('a'), 'Nope'))).toBe('unresolved:export-not-found')
    expect(project.exportNames(barrel('a'))).toEqual(['A', 'B', 'C'])
    expect(project.exportNames(barrel('b'))).toEqual(['A', 'B', 'C'])
  })

  it('a name exported by two `export *` is ambiguous, others resolve', () => {
    expect(where(project.resolveExport(barrel('ambiguous'), 'Dup'))).toBe('unresolved:ambiguous-export')
    expect(where(project.resolveExport(barrel('ambiguous'), 'OnlyX1'))).toBe('src/barrels/x1.ts#OnlyX1')
  })

  it('`export *` does not re-export default', () => {
    expect(where(project.resolveExport(`${APP}/src/users/index.ts`, 'default'))).toBe('unresolved:export-not-found')
  })

  it('circular named re-exports are reported', () => {
    expect(where(project.resolveExport(barrel('loop1'), 'x'))).toBe('unresolved:circular')
  })

  it('default exports: named, anonymous and expressions', () => {
    expect(where(project.resolveExport(`${APP}/src/defaults/named.ts`, 'default'))).toBe(
      'src/defaults/named.ts#NamedDefault',
    )
    expect(where(project.resolveExport(`${APP}/src/defaults/anon.ts`, 'default'))).toBe('src/defaults/anon.ts#default')
    expect(where(project.resolveExport(`${APP}/src/defaults/expr.ts`, 'default'))).toBe(
      'expression:src/defaults/expr.ts',
    )
    expect(where(project.resolveExport(`${APP}/src/aliased.ts`, 'default'))).toBe('src/aliased.ts#Exported')
  })

  it('tracks the files read by a lookup', () => {
    const files = new Set<string>()
    project.symbols.resolveExport(barrel('a'), 'C', 'any', files)
    expect([...files].sort()).toEqual([barrel('a'), barrel('b'), barrel('c')])
    // Memoized lookups report the same files.
    const again = new Set<string>()
    project.symbols.resolveExport(barrel('a'), 'C', 'any', again)
    expect([...again].sort()).toEqual([...files].sort())
  })

  it('unresolvable modules are reported', () => {
    const types = fileOf(project, 'src/types-sample.ts')
    expect(project.resolveIdentifier(types, 'Missing').symbol).toMatchObject({
      kind: 'unresolved',
      reason: 'module-not-found',
    })
  })
})
