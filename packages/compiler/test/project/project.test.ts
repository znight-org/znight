import type { ZnightOptions } from '../../src/options.ts'
import type { TempDir } from './helpers.ts'

import { normalizeOptions } from '../../src/options.ts'
import { Project } from '../../src/project/index.ts'
import { APP, appProject, declarationOf, fileOf, tempDir } from './helpers.ts'
import { afterEach, describe, expect, test as it } from 'bun:test'

let dir: TempDir | undefined
afterEach(() => {
  dir?.cleanup()
  dir = undefined
})

function project(files: Record<string, string>, options: ZnightOptions = {}): { project: Project; dir: TempDir } {
  dir = tempDir({ 'package.json': JSON.stringify({ name: 'temp-app' }), ...files })
  const created = new Project(normalizeOptions({ root: dir.root, ...options }))
  return { project: created, dir }
}

function relativeFiles(created: Project, root: string): string[] {
  return created.scannedFiles().map(file => file.slice(root.length + 1))
}

describe('Project.refresh', () => {
  it('scans include/exclude globs and parses every file', () => {
    const { project: created, dir } = project({
      'src/a.ts': 'export class A {}',
      'src/b.ts': "import { A } from './a.ts'\nexport class B extends A {}",
      'src/a.test.ts': 'test',
      'src/types.d.ts': 'declare const x: 1',
      'src/.znight/container.generated.ts': 'export {}',
      'scripts/tool.ts': 'export {}',
    })
    const result = created.refresh()
    expect(result).toMatchObject({ files: 2, parsed: 2, reused: 0, rescanned: true, resolutionCacheCleared: false })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(relativeFiles(created, dir.root)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(created.files().map(file => file.path)).toEqual(created.scannedFiles() as string[])
  })

  it('a full refresh re-reads files but only re-parses changed contents', () => {
    const { project: created, dir } = project({ 'src/a.ts': 'export class A {}', 'src/b.ts': 'export class B {}' })
    created.refresh()
    const before = created.getFile('src/a.ts')
    dir.write('src/b.ts', 'export class B2 {}')
    expect(created.refresh()).toMatchObject({ parsed: 1, reused: 1, rescanned: true, resolutionCacheCleared: true })
    expect(created.getFile('src/a.ts')).toBe(before)
    expect(fileOf(created, 'src/b.ts').facts.declarations.has('B2')).toBe(true)
  })

  it('incremental refresh: changed files are re-read, unchanged contents keep their parse', () => {
    const { project: created, dir } = project({ 'src/a.ts': 'export class A {}' })
    created.refresh()
    const before = created.getFile('src/a.ts')
    expect(created.refresh({ changed: ['src/a.ts'] })).toMatchObject({
      parsed: 0,
      reused: 1,
      rescanned: false,
      resolutionCacheCleared: false,
    })
    expect(created.getFile('src/a.ts')).toBe(before)
    dir.write('src/a.ts', 'export class A2 {}')
    expect(created.refresh({ changed: [`${dir.root}/src/a.ts`] })).toMatchObject({ parsed: 1, rescanned: false })
    expect(fileOf(created, 'src/a.ts').facts.declarations.has('A2')).toBe(true)
  })

  it('incremental refresh: added and removed files re-run the scan and clear resolution caches', () => {
    const { project: created, dir } = project({ 'src/a.ts': "export { B } from './b.ts'" })
    created.refresh()
    expect(created.resolveExport('src/a.ts', 'B')).toMatchObject({ kind: 'unresolved', reason: 'module-not-found' })
    dir.write('src/b.ts', 'export class B {}')
    expect(created.refresh({ added: ['src/b.ts'] })).toMatchObject({
      files: 2,
      rescanned: true,
      resolutionCacheCleared: true,
    })
    expect(created.resolveExport('src/a.ts', 'B')).toMatchObject({ kind: 'declaration' })
    dir.remove('src/b.ts')
    expect(created.refresh({ removed: ['src/b.ts'] })).toMatchObject({ files: 1, rescanned: true })
    expect(created.resolveExport('src/a.ts', 'B')).toMatchObject({ kind: 'unresolved' })
  })

  it('incremental refresh: a config file change clears the resolution caches', () => {
    const { project: created, dir } = project({
      'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '~/*': ['./src/*'] } } }),
      'src/a.ts': "export { B } from '~/b.ts'",
      'src/b.ts': 'export class B {}',
      'lib/b.ts': 'export class B {}',
    })
    created.refresh()
    expect(created.resolveExport('src/a.ts', 'B')).toMatchObject({ declaration: { file: `${dir.root}/src/b.ts` } })
    dir.write('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '~/*': ['./lib/*'] } } }))
    expect(created.refresh({ changed: ['tsconfig.json'] })).toMatchObject({
      rescanned: true,
      resolutionCacheCleared: true,
    })
    expect(created.resolveExport('src/a.ts', 'B')).toMatchObject({ declaration: { file: `${dir.root}/lib/b.ts` } })
  })

  it('per-compile services are rebuilt by every refresh', () => {
    const { project: created } = project({ 'src/a.ts': 'export class A {}' })
    created.refresh()
    const symbols = created.symbols
    created.refresh({ changed: [] })
    expect(created.symbols).not.toBe(symbols)
  })

  it('the outFile is never scanned', () => {
    const { project: created, dir } = project(
      { 'src/a.ts': '', 'src/generated.ts': '' },
      { outFile: 'src/generated.ts' },
    )
    created.refresh()
    expect(relativeFiles(created, dir.root)).toEqual(['src/a.ts'])
  })

  it('files outside the scan are loaded on demand', () => {
    const { project: created, dir } = project({
      'src/a.ts': "import { x } from '../lib/x.ts'",
      'lib/x.ts': 'export const x = 1',
    })
    created.refresh()
    expect(created.isScanned(`${dir.root}/lib/x.ts`)).toBe(false)
    expect(created.resolveIdentifier(fileOf(created, 'src/a.ts'), 'x').identity?.identity).toBe('lib/x.ts#x')
    expect(created.getFile('lib/x.ts')).toBeDefined()
    expect(created.isScanned('src/a.ts')).toBe(true)
  })

  it('reports syntax errors of scanned files', () => {
    const { project: created, dir } = project({ 'src/a.ts': 'export class {', 'src/b.ts': 'export {}' })
    created.refresh()
    const errors = created.syntaxErrors()
    expect(errors).toHaveLength(1)
    expect(errors[0]?.file.path).toBe(`${dir.root}/src/a.ts`)
    expect(errors[0]?.location).toMatchObject({ file: `${dir.root}/src/a.ts`, line: 1 })
  })

  it('throws a clear error for unknown files passed by path', () => {
    const { project: created } = project({ 'src/a.ts': '' })
    created.refresh()
    expect(() => created.resolveIdentifier('src/missing.ts', 'X')).toThrow(
      '[znight] cannot read or parse src/missing.ts',
    )
  })
})

describe('Project on the fixture application', () => {
  it('source libraries are scanned only when they resolve to sources', () => {
    const withSource = appProject({ conditions: ['@znight/source'], libraries: ['@fixture/lib'] })
    expect(withSource.libraries().map(library => [library.name, library.origin, library.entries.length])).toEqual([
      ['@fixture/lib', 'option', 2],
      ['@fixture/manifest-lib', 'manifest', 1],
    ])
    expect(withSource.isScanned(`${APP}/node_modules/@fixture/lib/src/db/pool.ts`)).toBe(true)
    expect(withSource.diagnostics().filter(diagnostic => diagnostic.code === 'ZNIGHT010')).toEqual([])

    const withoutSource = appProject({ libraries: ['@fixture/lib', 'not-installed'] })
    expect(withoutSource.libraries()).toEqual([])
    expect(withoutSource.isScanned(`${APP}/node_modules/@fixture/lib/src/db/pool.ts`)).toBe(false)
    expect(
      withoutSource
        .diagnostics()
        .filter(diagnostic => diagnostic.code === 'ZNIGHT010')
        .map(diagnostic => diagnostic.message),
    ).toEqual([
      "Provider library '@fixture/lib' does not resolve to TypeScript sources with the scan conditions (types, import, node, default); it is not analysed from source",
      `Provider library 'not-installed' cannot be resolved from ${APP}`,
    ])
  })

  it('declarations of source libraries keep package identities', () => {
    const created = appProject({ conditions: ['@znight/source'] })
    const mail = fileOf(created, 'node_modules/@fixture/manifest-lib/src/mail.service.ts')
    expect(created.isScanned(mail.path)).toBe(true)
    expect(created.identityOf(declarationOf(mail, 'MailService'))?.identity).toBe('@fixture/manifest-lib#MailService')
  })

  it('reports invalid manifests of dependencies', () => {
    const errors = appProject()
      .diagnostics()
      .filter(diagnostic => diagnostic.code === 'ZNIGHT018')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({
      severity: 'error',
      message: '@fixture/bad-manifest: manifest apiVersion 2 is not supported by this compiler (supported: 1)',
      location: { file: `${APP}/node_modules/@fixture/bad-manifest/package.json` },
    })
  })

  it('exposes packages and manifests', () => {
    const created = appProject()
    expect(created.rootPackage?.name).toBe('fixture-app')
    expect(created.ownerOf('src/main.ts').kind).toBe('application')
    const lib = created.packageOf('node_modules/@fixture/manifest-lib/src/index.ts')
    expect(lib?.name).toBe('@fixture/manifest-lib')
    expect(created.manifestOf(lib as never)).toMatchObject({
      packageName: '@fixture/manifest-lib',
      library: 'source',
      compiler: ['@fixture/manifest-lib/compiler'],
      provides: [
        { export: 'Clock', identity: '@fixture/manifest-lib#Clock', plugin: 'ClockPlugin', scope: 'singleton' },
      ],
      interceptors: [
        {
          decorator: 'Timed',
          interceptor: 'TimedInterceptor',
          interceptorIdentity: '@fixture/manifest-lib#TimedInterceptor',
        },
      ],
    })
    expect(created.manifestOf(created.rootPackage as never)).toBeUndefined()
  })

  it('diagnostics are sorted and de-duplicated', () => {
    const created = appProject({ conditions: ['@znight/source'] })
    const importer = fileOf(created, 'src/casing/importer.ts')
    created.resolveIdentifier(importer, 'UserProfile')
    created.resolveIdentifier(importer, 'UserProfile')
    const diagnostics = created.diagnostics()
    const files = diagnostics.map(diagnostic => diagnostic.location?.file ?? '')
    expect(files).toEqual([...files].sort())
    expect(new Set(diagnostics.map(diagnostic => diagnostic.message)).size).toBe(diagnostics.length)
  })
})
