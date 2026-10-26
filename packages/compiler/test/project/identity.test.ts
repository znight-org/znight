import type { Declaration } from '../../src/project/index.ts'

import { displayNameOf, splitIdentity } from '../../src/project/index.ts'
import { APP, appProject, caseInsensitiveFileSystem, declarationOf, fileOf } from './helpers.ts'
import { describe, expect, test as it } from 'bun:test'

const project = appProject({ conditions: ['@znight/source'] })

function identity(file: string, name: string): string | undefined {
  return project.resolveIdentifier(fileOf(project, file), name).identity?.identity
}

describe('application identities', () => {
  it('non-ASCII sources: identities, UTF-16 locations and values', () => {
    const file = fileOf(project, 'src/unicode.ts')
    const declaration = declarationOf(file, 'Ünicode')
    expect(project.identityOf(declaration)?.identity).toBe('src/unicode.ts#Ünicode')
    // Line 1 holds an emoji (2 UTF-16 code units) and accented letters before the declarations.
    expect(file.location(declaration.span)).toMatchObject({ line: 3, column: 14, endLine: 3, endColumn: 21 })
    const greeting = declarationOf(file, 'GREETING')
    const init = greeting.node.type === 'VariableDeclarator' ? greeting.node.init : null
    expect(init && project.evaluate(file, init)).toMatchObject({ kind: 'value', value: 'héllo wörld 😀' })
  })

  it('<path relative to the root>#<local name>', () => {
    expect(identity('src/main.ts', 'UserService')).toBe('src/users/user.service.ts#UserService')
    expect(identity('src/main.ts', 'DefaultUserRepository')).toBe('src/users/user.repository.ts#PgUserRepository')
    expect(identity('src/main.ts', 'formatName')).toBe('shared/format.ts#formatName')
  })

  it('namespace members, anonymous and expression default exports', () => {
    expect(identity('src/ns.ts', 'Models.Deep.Leaf')).toBe('src/ns.ts#Models.Deep.Leaf')
    expect(project.identityOf(project.resolveExport('src/defaults/anon.ts', 'default'))?.identity).toBe(
      'src/defaults/anon.ts#default',
    )
    expect(project.identityOf(project.resolveExport('src/defaults/expr.ts', 'default'))?.identity).toBe(
      'src/defaults/expr.ts#default',
    )
  })

  it('identity info for application declarations', () => {
    const info = project.identityOf(declarationOf(fileOf(project, 'src/users/user.service.ts'), 'UserService'))
    expect(info).toEqual({
      identity: 'src/users/user.service.ts#UserService',
      displayName: 'UserService',
      owner: 'application',
      specifier: undefined,
      exportPath: [],
      public: true,
      relativePath: 'src/users/user.service.ts',
    })
  })

  it.if(caseInsensitiveFileSystem())('uses the on-disk casing even when imported with another casing', () => {
    expect(identity('src/casing/importer.ts', 'UserProfile')).toBe('src/casing/UserProfile.ts#UserProfile')
    const warnings = project.diagnostics().filter(diagnostic => diagnostic.code === 'ZNIGHT010')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({
      severity: 'warning',
      message: "Import './userprofile.ts' does not match the casing of the file on disk (src/casing/UserProfile.ts)",
      location: { file: `${APP}/src/casing/importer.ts`, line: 1, column: 29 },
    })
  })
})

describe('package identities', () => {
  it('<package>#<public export name>, following re-exports inside the package', () => {
    expect(identity('src/users/user.service.ts', 'AppLogger')).toBe('@fixture/lib#Logger')
    expect(identity('src/lib-usage.ts', 'Client')).toBe('@fixture/lib#Client')
    expect(identity('src/lib-usage.ts', 'EmailSender')).toBe('@fixture/lib#EmailSender')
    expect(identity('src/lib-usage.ts', 'DefaultClient')).toBe('@fixture/lib#default')
  })

  it('the root entry wins over subpath entries; subpath-only exports use the subpath', () => {
    expect(identity('src/lib-usage.ts', 'SubPool')).toBe('@fixture/lib#Pool')
    expect(identity('src/lib-usage.ts', 'OnlyInSub')).toBe('@fixture/lib/sub#OnlyInSub')
  })

  it('members of exported namespaces get a dotted export path', () => {
    expect(identity('src/lib-usage.ts', 'tokens.TokenHolder')).toBe('@fixture/lib#tokens.TokenHolder')
    expect(identity('src/lib-usage.ts', 'lib.tokens.TOKEN_A')).toBe('@fixture/lib#tokens.TOKEN_A')
    expect(identity('src/lib-usage.ts', 'lib.Logger')).toBe('@fixture/lib#Logger')
  })

  it('identity info for package declarations', () => {
    const info = project.resolveIdentifier(fileOf(project, 'src/lib-usage.ts'), 'tokens.TokenHolder').identity
    expect(info).toEqual({
      identity: '@fixture/lib#tokens.TokenHolder',
      displayName: 'tokens.TokenHolder',
      owner: 'package',
      specifier: '@fixture/lib',
      exportPath: ['tokens', 'TokenHolder'],
      public: true,
      relativePath: undefined,
    })
  })

  it('DefinitelyTyped declarations are identified by the typed package', () => {
    expect(identity('src/main.ts', 'Pool')).toBe('pg#Pool')
    expect(identity('src/main.ts', 'pg.Pool')).toBe('pg#Pool')
  })

  it('`export =` namespace members', () => {
    expect(identity('src/legacy.ts', 'legacy.Client')).toBe('legacy-ns#Client')
    expect(identity('src/legacy.ts', 'legacy')).toBe('legacy-ns#default')
  })

  it('declarations not reachable from a public entry get an internal identity', () => {
    const logger = project.resolveIdentifier(fileOf(project, 'src/lib-usage.ts'), 'Logger').symbol
    const declaration = logger.kind === 'declaration' ? logger.declaration : undefined
    const [base] = project.heritageOf(declaration as Declaration)
    expect(project.identityOf(base?.symbol ?? { kind: 'global', name: 'x' })).toMatchObject({
      identity: '@fixture/lib/src/internal.ts#BaseService',
      owner: 'package',
      public: false,
    })
  })

  it('the public index of a package lists every public declaration (and namespace object) once', () => {
    const info = project.packageOf(`${APP}/node_modules/@fixture/lib/src/index.ts`)
    expect(info).toBeDefined()
    const exports = [...project.identities.publicIndex(info as never).values()].map(
      entry => `${entry.entry.specifier}#${entry.path.join('.')}`,
    )
    expect(exports.sort()).toEqual([
      '@fixture/lib#Client',
      '@fixture/lib#DEFAULT_PORT',
      '@fixture/lib#EmailSender',
      '@fixture/lib#Logger',
      '@fixture/lib#LoggerOptions',
      '@fixture/lib#PREFIX',
      '@fixture/lib#Pool',
      '@fixture/lib#ROLES',
      '@fixture/lib#Repository',
      '@fixture/lib#UserRepository',
      '@fixture/lib#V1Client',
      '@fixture/lib#default',
      '@fixture/lib#tokens',
      '@fixture/lib#tokens.TOKEN_A',
      '@fixture/lib#tokens.TokenHolder',
      '@fixture/lib/sub#OnlyInSub',
    ])
  })
})

describe('external and global identities', () => {
  it('builtins and untyped packages use their specifier', () => {
    expect(identity('src/main.ts', 'EventEmitter')).toBe('node:events#EventEmitter')
    expect(identity('src/main.ts', 'cjs.Thing')).toBe('cjs-only#Thing')
    expect(identity('src/main.ts', 'fs')).toBe('node:fs#default')
  })

  it('globals use globalThis, application namespace objects have no identity', () => {
    expect(identity('src/main.ts', 'Date')).toBe('globalThis#Date')
    expect(identity('src/main.ts', 'models')).toBeUndefined()
    expect(identity('src/lib-usage.ts', 'lib')).toBeUndefined()
  })

  it('namespace objects exported by a package (`export * as ns`) have an identity', () => {
    expect(identity('src/lib-usage.ts', 'tokens')).toBe('@fixture/lib#tokens')
  })
})

describe('lookupIdentity', () => {
  it.each([
    'src/users/user.service.ts#UserService',
    'src/ns.ts#Models.Inner',
    'src/ns.ts#Models.Deep.Leaf',
    'src/defaults/anon.ts#default',
    'src/defaults/expr.ts#default',
    'shared/format.ts#formatName',
    '@fixture/lib#Logger',
    '@fixture/lib#default',
    '@fixture/lib#tokens.TokenHolder',
    '@fixture/lib/sub#OnlyInSub',
    '@fixture/lib/src/internal.ts#BaseService',
    '@fixture/manifest-lib#MailService',
    'pg#Pool',
    'legacy-ns#Client',
    'node:events#EventEmitter',
    'cjs-only#Thing',
    'globalThis#Date',
  ])('round-trips %s', identity => {
    expect(project.identityOf(project.lookupIdentity(identity))?.identity).toBe(identity)
  })

  it('finds non-exported namespace members of application files', () => {
    expect(project.lookupIdentity('src/ns.ts#Models.Hidden')).toMatchObject({
      kind: 'declaration',
      declaration: { name: 'Models.Hidden' },
    })
  })

  it('reports invalid and unknown identities', () => {
    expect(project.lookupIdentity('NoSeparator')).toMatchObject({ kind: 'unresolved' })
    expect(project.lookupIdentity('not-installed#X')).toMatchObject({ kind: 'unresolved', reason: 'module-not-found' })
    expect(project.lookupIdentity('@fixture/lib#Nope')).toMatchObject({
      kind: 'unresolved',
      reason: 'export-not-found',
    })
  })
})

describe('identity helpers', () => {
  it('splitIdentity splits at the last #', () => {
    expect(splitIdentity('src/a.ts#Foo.bar')).toEqual({ owner: 'src/a.ts', name: 'Foo.bar' })
    expect(splitIdentity('@acme/lib#Logger')).toEqual({ owner: '@acme/lib', name: 'Logger' })
    expect(splitIdentity('#Foo')).toBeUndefined()
    expect(splitIdentity('Foo#')).toBeUndefined()
  })

  it('displayNameOf', () => {
    expect(displayNameOf('src/db.factory.ts#DbFactory.createPool')).toBe('DbFactory.createPool')
  })
})
