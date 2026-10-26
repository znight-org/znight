import type { ImportRouteResult } from '../../src/project/index.ts'

import { normalizeOptions } from '../../src/options.ts'
import { importSpecifier, Project } from '../../src/project/index.ts'
import { APP, appProject, declarationOf, fileOf, tempDir } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

describe('importSpecifier', () => {
  const out = '/app/src/.znight/container.generated.ts'

  it.each([
    ['/app/src/users/user.service.ts', 'js', '../users/user.service.js'],
    ['/app/src/users/user.service.ts', 'ts', '../users/user.service.ts'],
    ['/app/src/users/user.service.ts', 'none', '../users/user.service'],
    ['/app/src/view.tsx', 'js', '../view.js'],
    ['/app/src/esm.mts', 'js', '../esm.mjs'],
    ['/app/src/cjs.cts', 'js', '../cjs.cjs'],
    ['/app/src/esm.mts', 'ts', '../esm.mts'],
    ['/app/src/legacy.js', 'js', '../legacy.js'],
    ['/app/src/legacy.jsx', 'js', '../legacy.js'],
    ['/app/src/types.d.ts', 'js', '../types.js'],
    ['/app/src/types.d.mts', 'ts', '../types.mjs'],
    ['/app/src/types.d.ts', 'none', '../types'],
    ['/app/src/.znight/helpers.ts', 'js', './helpers.js'],
    ['/app/lib/shared.ts', 'js', '../../lib/shared.js'],
  ] as const)('%s (%s) → %s', (target, extension, expected) => {
    expect(importSpecifier(out, target, extension)).toBe(expected)
  })
})

describe('import routes', () => {
  const project = appProject({ conditions: ['@znight/source'] })
  const route = (identity: string, fromFile?: string): ImportRouteResult => project.importRoute(identity, fromFile)

  it('application declarations: relative to outFile, alias-aware', () => {
    expect(route('src/users/user.service.ts#UserService')).toEqual({
      ok: true,
      route: { specifier: '../users/user.service.js', exportName: 'UserService', members: [], typeOnly: false },
    })
    expect(route('src/aliased.ts#Internal')).toMatchObject({ ok: true, route: { exportName: 'Public' } })
    expect(route('src/defaults/named.ts#NamedDefault')).toMatchObject({ ok: true, route: { exportName: 'default' } })
    expect(route('src/defaults/expr.ts#default')).toMatchObject({
      ok: true,
      route: { specifier: '../defaults/expr.js', exportName: 'default' },
    })
  })

  it('the local name is preferred when a declaration is exported several times', () => {
    // `export class Exported` + `export default Exported`
    expect(route('src/aliased.ts#Exported')).toMatchObject({ ok: true, route: { exportName: 'Exported' } })
  })

  it('`export =` declarations are imported as the default export', () => {
    expect(route('src/commonjs.cts#Engine')).toEqual({
      ok: true,
      route: { specifier: '../commonjs.cjs', exportName: 'default', members: [], typeOnly: false },
    })
    expect(route('src/commonjs.cts#Engine.Part')).toMatchObject({
      ok: true,
      route: { exportName: 'default', members: ['Part'] },
    })
  })

  it('namespace objects exported by packages are routed', () => {
    const tokens = project.resolveIdentifier(fileOf(project, 'src/lib-usage.ts'), 'tokens').symbol
    expect(tokens.kind).toBe('module')
    expect(project.importRoute(tokens)).toMatchObject({
      ok: true,
      route: { specifier: '@fixture/lib', exportName: 'tokens', members: [] },
    })
    expect(
      project.importRoute(project.resolveIdentifier(fileOf(project, 'src/main.ts'), 'models').symbol),
    ).toMatchObject({
      ok: false,
      error: { reason: 'unresolved' },
    })
  })

  it('interfaces and type aliases are type-only', () => {
    expect(route('src/aliased.ts#Shape')).toMatchObject({ ok: true, route: { exportName: 'Shape', typeOnly: true } })
    expect(route('src/generics.ts#UserRepo')).toMatchObject({ ok: true, route: { typeOnly: true } })
  })

  it('namespace members are reached through the exported namespace', () => {
    expect(route('src/ns.ts#Models.Deep.Leaf')).toEqual({
      ok: true,
      route: { specifier: '../ns.js', exportName: 'Models', members: ['Deep', 'Leaf'], typeOnly: true },
    })
  })

  it('routes are relative to the requested file and use importExtension', () => {
    expect(route('src/users/user.service.ts#UserService', `${APP}/src/main.ts`)).toMatchObject({
      route: { specifier: './users/user.service.js' },
    })
    const tsProject = appProject({ conditions: ['@znight/source'], importExtension: 'ts', outFile: 'generated.ts' })
    expect(tsProject.importRoute('src/users/user.service.ts#UserService')).toMatchObject({
      route: { specifier: './src/users/user.service.ts' },
    })
  })

  it('non-exported and anonymous declarations have no route (ZNIGHT005 "export it")', () => {
    expect(route('src/aliased.ts#NotExported')).toEqual({
      ok: false,
      error: {
        reason: 'not-exported',
        message: "'NotExported' is not exported by src/aliased.ts",
        hints: ['Export it: `export class NotExported ...`'],
      },
    })
    expect(route('src/defaults/anon.ts#default')).toMatchObject({ ok: false, error: { reason: 'anonymous-default' } })
    expect(route('src/ns.ts#Models.Hidden')).toMatchObject({
      ok: false,
      error: { reason: 'not-exported', message: "'Models.Hidden' is not exported by namespace 'Models'" },
    })
  })

  it('package declarations use the public entry, never a path into the package', () => {
    expect(route('@fixture/lib#Logger')).toEqual({
      ok: true,
      route: { specifier: '@fixture/lib', exportName: 'Logger', members: [], typeOnly: false },
    })
    expect(route('@fixture/lib#EmailSender')).toMatchObject({
      route: { specifier: '@fixture/lib', exportName: 'EmailSender' },
    })
    expect(route('@fixture/lib/sub#OnlyInSub')).toMatchObject({
      route: { specifier: '@fixture/lib/sub', exportName: 'OnlyInSub' },
    })
    expect(route('@fixture/lib#tokens.TokenHolder')).toMatchObject({
      route: { exportName: 'tokens', members: ['TokenHolder'] },
    })
    expect(route('@fixture/lib#LoggerOptions')).toMatchObject({ route: { typeOnly: true } })
    expect(route('pg#Pool')).toMatchObject({ route: { specifier: 'pg', exportName: 'Pool' } })
  })

  it('package-internal declarations have no route', () => {
    expect(route('@fixture/lib/src/internal.ts#BaseService')).toMatchObject({
      ok: false,
      error: { reason: 'internal' },
    })
  })

  it('CommonJS modules are imported through their default export', () => {
    expect(route('legacy-ns#Client')).toEqual({
      ok: true,
      route: { specifier: 'legacy-ns', exportName: 'default', members: ['Client'], typeOnly: false },
    })
    expect(route('cjs-only#Thing')).toEqual({
      ok: true,
      route: { specifier: 'cjs-only', exportName: 'default', members: ['Thing'], typeOnly: false },
    })
  })

  it('builtins keep named imports', () => {
    expect(route('node:events#EventEmitter')).toMatchObject({
      route: { specifier: 'node:events', exportName: 'EventEmitter' },
    })
  })

  it('globals, modules and unresolved symbols have no route', () => {
    expect(route('globalThis#Date')).toMatchObject({ ok: false, error: { reason: 'global' } })
    expect(project.importRoute({ kind: 'module', file: `${APP}/src/users/user.model.ts` })).toMatchObject({ ok: false })
    expect(route('not-installed#X')).toMatchObject({ ok: false, error: { reason: 'unresolved' } })
  })

  it('accepts declarations and symbols', () => {
    const service = declarationOf(fileOf(project, 'src/users/user.service.ts'), 'UserService')
    expect(project.importRoute(service)).toMatchObject({ ok: true, route: { exportName: 'UserService' } })
    const symbol = project.resolveIdentifier(fileOf(project, 'src/main.ts'), 'DefaultUserRepository').symbol
    expect(project.importRoute(symbol)).toMatchObject({
      route: { specifier: '../users/user.repository.js', exportName: 'PgUserRepository' },
    })
  })
})

describe('import routes need runtime resolution', () => {
  const dir = tempDir({
    'package.json': '{ "name": "routes-app" }',
    'src/main.ts': "export { Thing } from 'types-only'",
    'node_modules/types-only/package.json': JSON.stringify({
      name: 'types-only',
      exports: { '.': { types: './index.d.ts' } },
    }),
    'node_modules/types-only/index.d.ts': 'export declare class Thing {}',
  })
  afterAll(() => dir.cleanup())

  it('a package that cannot be resolved with the runtime conditions has no route', () => {
    const project = new Project(normalizeOptions({ root: dir.root }))
    project.refresh()
    expect(project.identityOf(project.resolveExport('src/main.ts', 'Thing'))?.identity).toBe('types-only#Thing')
    expect(project.importRoute('types-only#Thing')).toEqual({
      ok: false,
      error: {
        reason: 'runtime-unresolvable',
        message: `'types-only' cannot be resolved from ${dir.root}/src/.znight/container.generated.ts with the runtime conditions`,
        hints: ["Add 'types-only' to the dependencies of the application"],
      },
    })
  })
})
