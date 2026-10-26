import type { PackageInfo } from '../../src/project/index.ts'

import { PackageRegistry } from '../../src/project/index.ts'
import { APP, tempDir } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

function info(json: Record<string, unknown>): PackageInfo {
  const name = typeof json.name === 'string' ? json.name : undefined
  return {
    name,
    publicName: name,
    version: undefined,
    dir: '/pkg',
    packageJsonPath: '/pkg/package.json',
    text: JSON.stringify(json),
    json,
  }
}

describe('PackageRegistry on the fixture app', () => {
  const registry = new PackageRegistry(APP)

  it('the root package is the nearest named package.json of the root', () => {
    expect(registry.rootPackage).toMatchObject({ name: 'fixture-app', dir: APP })
  })

  it('application files are owned by the root package', () => {
    expect(registry.ownerOf(`${APP}/src/main.ts`)).toMatchObject({ kind: 'application' })
    expect(registry.ownerOf(`${APP}/shared/format.ts`)).toMatchObject({ kind: 'application' })
  })

  it('files of dependencies are owned by their package', () => {
    const owner = registry.ownerOf(`${APP}/node_modules/@fixture/lib/src/index.ts`)
    expect(owner.kind).toBe('package')
    expect(owner.package).toMatchObject({ name: '@fixture/lib', publicName: '@fixture/lib', version: '1.0.0' })
  })

  it('nameless package.json files are skipped (dist/package.json with only "type")', () => {
    expect(registry.read(`${APP}/node_modules/@fixture/lib/dist`)).toMatchObject({ name: undefined })
    expect(registry.packageOf(`${APP}/node_modules/@fixture/lib/dist/index.d.mts`)?.name).toBe('@fixture/lib')
  })

  it('DefinitelyTyped packages have the public name of the typed package', () => {
    expect(registry.packageOf(`${APP}/node_modules/@types/pg/index.d.ts`)).toMatchObject({
      name: '@types/pg',
      publicName: 'pg',
    })
  })

  it('lists dependency names of every kind, sorted', () => {
    expect(registry.dependencyNames(registry.rootPackage as PackageInfo)).toEqual([
      '@fixture/bad-manifest',
      '@fixture/lib',
      '@fixture/manifest-lib',
      '@types/pg',
      'cjs-only',
      'legacy-ns',
      'pg',
    ])
  })

  it('finds installed packages walking up node_modules, independently of exports', () => {
    expect(registry.findInstalled('@fixture/lib', `${APP}/src/users`)?.dir).toBe(`${APP}/node_modules/@fixture/lib`)
    expect(registry.findInstalled('does-not-exist', APP)).toBeUndefined()
  })

  it('caches package.json reads until clear()', () => {
    const first = registry.read(APP)
    expect(registry.read(APP)).toBe(first)
    registry.clear()
    expect(registry.read(APP)).not.toBe(first)
    expect(registry.read(APP)).toEqual(first)
  })
})

describe('PackageRegistry.entries', () => {
  const registry = new PackageRegistry('/root')

  it('a package without exports has a single root entry', () => {
    expect(registry.entries(info({ name: 'pg', main: 'index.js' }))).toEqual([{ subpath: '.', specifier: 'pg' }])
  })

  it('string, array and condition-object exports only have the root entry', () => {
    for (const exportsField of ['./index.js', ['./a.js'], { import: './a.mjs', require: './a.cjs' }]) {
      expect(registry.entries(info({ name: 'x', exports: exportsField }))).toEqual([{ subpath: '.', specifier: 'x' }])
    }
  })

  it('subpath exports: root first, then sorted; patterns, package.json and null targets skipped', () => {
    const entries = registry.entries(
      info({
        name: '@acme/lib',
        exports: {
          './testing': './testing.js',
          './adapters/fastify': './fastify.js',
          '.': './index.js',
          './package.json': './package.json',
          './features/*': './features/*.js',
          './private': null,
        },
      }),
    )
    expect(entries).toEqual([
      { subpath: '.', specifier: '@acme/lib' },
      { subpath: './adapters/fastify', specifier: '@acme/lib/adapters/fastify' },
      { subpath: './testing', specifier: '@acme/lib/testing' },
    ])
  })

  it('a nameless package has no entries', () => {
    expect(registry.entries(info({ type: 'module' }))).toEqual([])
  })
})

describe('PackageRegistry without a root package', () => {
  const dir = tempDir({ 'src/a.ts': 'export {}' })
  afterAll(() => dir.cleanup())

  it('every file outside named packages is an application file', () => {
    const registry = new PackageRegistry(dir.root)
    expect(registry.rootPackage).toBeUndefined()
    expect(registry.ownerOf(`${dir.root}/src/a.ts`)).toEqual({ kind: 'application', package: undefined })
  })

  it('invalid package.json files are ignored', () => {
    dir.write('broken/package.json', '{ not json')
    dir.write('array/package.json', '[]')
    const registry = new PackageRegistry(dir.root)
    expect(registry.read(`${dir.root}/broken`)).toBeUndefined()
    expect(registry.read(`${dir.root}/array`)).toBeUndefined()
  })
})
