/**
 * Golden test (§4.1): identities, types, constants and import routes must be identical whether a
 * workspace package resolves to its TypeScript sources (`@znight/source`) or to the declarations
 * produced by tsdown (`dist/*.d.mts`, with chunks and renamed declarations such as `Client$1`).
 *
 * The fixture `@fixture/lib` ships both: `src/` and the real tsdown 0.23 output in `dist/`.
 */

import type { Project } from '../../src/project/index.ts'

import { serializeType } from '../../src/project/index.ts'
import { APP, aliasBody, appProject, fileOf, initializerOf } from './helpers.ts'
import { describe, expect, test as it } from 'bun:test'

const LIB = `${APP}/node_modules/@fixture/lib`

const NAMES = [
  'DefaultClient',
  'Client',
  'DEFAULT_PORT',
  'EmailSender',
  'Logger',
  'LoggerOptions',
  'PREFIX',
  'Pool',
  'Repository',
  'ROLES',
  'tokens',
  'tokens.TokenHolder',
  'tokens.TOKEN_A',
  'UserRepository',
  'V1Client',
  'lib.Logger',
  'lib.tokens.TokenHolder',
  'OnlyInSub',
  'SubPool',
  'MailService',
] as const

const GOLDEN: Record<(typeof NAMES)[number], string> = {
  DefaultClient: '@fixture/lib#default',
  Client: '@fixture/lib#Client',
  DEFAULT_PORT: '@fixture/lib#DEFAULT_PORT',
  EmailSender: '@fixture/lib#EmailSender',
  Logger: '@fixture/lib#Logger',
  LoggerOptions: '@fixture/lib#LoggerOptions',
  PREFIX: '@fixture/lib#PREFIX',
  Pool: '@fixture/lib#Pool',
  Repository: '@fixture/lib#Repository',
  ROLES: '@fixture/lib#ROLES',
  // `export * as tokens`: a module in the sources, a `declare namespace` in the declarations.
  tokens: '@fixture/lib#tokens',
  'tokens.TokenHolder': '@fixture/lib#tokens.TokenHolder',
  'tokens.TOKEN_A': '@fixture/lib#tokens.TOKEN_A',
  UserRepository: '@fixture/lib#UserRepository',
  V1Client: '@fixture/lib#V1Client',
  'lib.Logger': '@fixture/lib#Logger',
  'lib.tokens.TokenHolder': '@fixture/lib#tokens.TokenHolder',
  OnlyInSub: '@fixture/lib/sub#OnlyInSub',
  SubPool: '@fixture/lib#Pool',
  MailService: '@fixture/manifest-lib#MailService',
}

const source = appProject({ conditions: ['@znight/source'] })
const dist = appProject()

function where(project: Project, name: string): string {
  const symbol = project.resolveIdentifier(fileOf(project, 'src/lib-usage.ts'), name).symbol
  return symbol.kind === 'declaration' ? symbol.declaration.file.slice(LIB.length + 1) : symbol.kind
}

describe('golden: sources vs declarations', () => {
  it('the two projects really analyse different files', () => {
    expect(where(source, 'V1Client')).toBe('src/v1/client.ts')
    expect(where(dist, 'V1Client')).toBe('dist/index.d.mts')
    expect(where(source, 'Pool')).toBe('src/db/pool.ts')
    expect(where(dist, 'Pool')).toBe('dist/pool-fa4zP2qW.d.mts')
    expect(source.libraries().map(library => library.name)).toEqual(['@fixture/manifest-lib'])
    expect(dist.libraries()).toEqual([])
  })

  it.each(NAMES)('%s has the same identity', name => {
    const file = 'src/lib-usage.ts'
    const fromSource = source.resolveIdentifier(fileOf(source, file), name).identity?.identity
    const fromDist = dist.resolveIdentifier(fileOf(dist, file), name).identity?.identity
    expect(fromSource).toBe(GOLDEN[name])
    expect(fromDist).toBe(GOLDEN[name])
  })

  it('types are identical', () => {
    for (const alias of ['Repo', 'UserRepo', 'Options']) {
      const types = [source, dist].map(project => {
        const file = fileOf(project, 'src/lib-usage.ts')
        return serializeType(project.resolveType(file, aliasBody(file, alias)))
      })
      expect(types[0]).toBe(types[1] as string)
    }
    const file = fileOf(source, 'src/lib-usage.ts')
    expect(serializeType(source.resolveType(file, aliasBody(file, 'UserRepo')))).toBe(
      '@fixture/lib#Repository<@fixture/lib#Client, string>',
    )
  })

  it('constant values are identical when the declarations keep literal types', () => {
    for (const name of ['PORT', 'FIRST_ROLE', 'TOKEN']) {
      const results = [source, dist].map(project => {
        const file = fileOf(project, 'src/lib-usage.ts')
        return project.evaluate(file, initializerOf(file, name))
      })
      expect(results[0]?.kind).toBe('value')
      expect(results[1]?.kind).toBe('value')
      expect(results[0]?.kind === 'value' && results[0].value).toEqual(results[1]?.kind === 'value' && results[1].value)
    }
  })

  it('known limitation: a constant widened by the declaration emit (`PREFIX: string`) becomes a reference', () => {
    const results = [source, dist].map(project => {
      const file = fileOf(project, 'src/lib-usage.ts')
      return project.evaluate(file, initializerOf(file, 'API'))
    })
    expect(results[0]).toMatchObject({ kind: 'value', value: '/api' })
    expect(results[1]).toMatchObject({ kind: 'ref', ref: { identity: '@fixture/lib#PREFIX' } })
  })

  it('import routes are identical', () => {
    for (const name of NAMES) {
      const routes = [source, dist].map(project => {
        const symbol = project.resolveIdentifier(fileOf(project, 'src/lib-usage.ts'), name).symbol
        return project.importRoute(symbol)
      })
      expect(routes[0]).toEqual(routes[1] as never)
    }
  })

  it('public indexes describe the same public surface', () => {
    const surfaces = [source, dist].map(project => {
      const info = project.packageOf(`${LIB}/package.json`)
      expect(info?.name).toBe('@fixture/lib')
      return [...project.identities.publicIndex(info as never).values()]
        .map(entry => `${entry.entry.specifier}#${entry.path.join('.')}`)
        .sort()
    })
    expect(surfaces[0]).toEqual(surfaces[1] as string[])
  })

  it('internal declarations are not public in both modes (their identity depends on the layout)', () => {
    const bases = [source, dist].map(project => {
      const logger = project.resolveIdentifier(fileOf(project, 'src/lib-usage.ts'), 'Logger').symbol
      if (logger.kind !== 'declaration') {
        throw new Error('Logger not resolved')
      }
      const [base] = project.heritageOf(logger.declaration)
      return base ? project.identityOf(base.symbol) : undefined
    })
    expect(bases[0]).toMatchObject({ identity: '@fixture/lib/src/internal.ts#BaseService', public: false })
    expect(bases[1]).toMatchObject({ identity: '@fixture/lib/dist/index.d.mts#BaseService', public: false })
  })
})
