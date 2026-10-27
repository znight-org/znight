/**
 * Route decorator groups at build time (RFC 0001 §5.1): evaluation of the options of
 * `createRouteDecorator`, consistency of the definitions, one decision per group and target, the
 * nearest decision, ZNIGHT023 and the `groups` metadata.
 */
import type { Diagnostic } from '@znight/compiler'
import type { HttpAnalysis } from './helpers.ts'

import path from 'node:path'

import { analyzeApp, cleanupApps, generateSection, httpDiagnostics, tempApp } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

const ACCESS = `
import { createRouteDecorator } from '@znight/http'

export type Role = 'admin' | 'reader'

const ACCESS = 'access'
const OPTIONS = { group: ACCESS, required: true } as const

export const Public = createRouteDecorator('public', { group: 'access', required: true })
export const Authenticated = createRouteDecorator('authenticated', OPTIONS)
export const Roles = createRouteDecorator<readonly Role[]>('roles', { group: ACCESS, required: !false })
export const RateLimit = createRouteDecorator<number>('rateLimit')
`

/** Analyses an application made of the access decorators and `files`. */
function analyzeWith(files: Record<string, string>): Promise<HttpAnalysis> {
  const app = tempApp({ 'src/auth/access.ts': ACCESS, ...files })
  return analyzeApp(app.root)
}

/** Analyses an application made of `files` only (no required group). */
function analyzeWithout(files: Record<string, string>): Promise<HttpAnalysis> {
  return analyzeApp(tempApp(files).root)
}

/** One diagnostic with its related locations and hints, paths relative to the root. */
function detailed(result: HttpAnalysis, code: string): object[] {
  const relative = (location: Diagnostic['location']): string =>
    location === undefined ? '-' : `${path.relative(result.root, location.file)}:${location.line}:${location.column}`
  return result.diagnostics
    .filter(diagnostic => diagnostic.code === code)
    .map(diagnostic => ({
      at: relative(diagnostic.location),
      message: diagnostic.message,
      hints: diagnostic.hints ?? [],
      related: (diagnostic.related ?? []).map(entry => `${entry.message} @ ${relative(entry.location)}`),
    }))
}

describe('options of createRouteDecorator', () => {
  it('evaluates literals and const references, and stores the group of every entry', async () => {
    const result = await analyzeWith({
      'src/books.controller.ts': `
import { Controller, Delete, Get } from '@znight/http'
import { Authenticated, Public, RateLimit, Roles } from './auth/access.ts'

@Controller('/books')
@Authenticated()
export class BookController {
  @Get()
  @RateLimit(10)
  list() { return [] }

  @Get('/cover')
  @Public()
  cover() { return '' }

  @Delete('/:id')
  @Roles(['admin'])
  remove(@Param('id') id: string) { return id }
}
import { Param } from '@znight/http'
`,
    })
    expect(httpDiagnostics(result)).toEqual([])
    const [controller] = result.controllers
    expect(controller?.meta.map(entry => [entry.key, entry.group, entry.required, entry.decorator])).toEqual([
      ['authenticated', 'access', true, 'Authenticated'],
    ])
    expect(controller?.meta[0]?.identity).toBe('src/auth/access.ts#Authenticated')
    expect(path.relative(result.root, controller?.meta[0]?.definition.file ?? '')).toBe('src/auth/access.ts')
    expect(controller?.meta[0]?.definition.line).toBe(10)
    expect(
      controller?.routes.map(route => route.meta.map(entry => `${entry.key}:${entry.group}:${String(entry.required)}`)),
    ).toEqual([['rateLimit:rateLimit:false'], ['public:access:true'], ['roles:access:true']])
  })

  it.each([
    ["createRouteDecorator('a', 'access')", 'must be an object { group?, required? }'],
    ["createRouteDecorator('a', { group: 'access', scope: 'x' })", 'have an unknown property "scope"'],
    ["createRouteDecorator('a', { group: '9lives' })", 'have an invalid group "9lives"'],
    ["createRouteDecorator('a', { group: 1 })", 'have an invalid group 1'],
    ["createRouteDecorator('a', { required: 'yes' })", 'have a non-boolean "required"'],
    ["createRouteDecorator('a', { group: String(1) })", 'must be statically evaluable'],
    ["createRouteDecorator('a', {}, {})", 'takes a key and an optional { group?, required? } object (Bad)'],
  ])('reports invalid options at the usage, related to the definition: %s', async (definition, message) => {
    const result = await analyzeWith({
      'src/bad.ts': `
import { createRouteDecorator } from '@znight/http'
export const Bad = ${definition}
`,
      'src/app.controller.ts': `
import { Controller, Get } from '@znight/http'
import { Bad } from './bad.ts'

@Controller('/app')
export class AppController {
  @Get()
  @Bad()
  index() { return 'ok' }
}
`,
    })
    const [diagnostic] = detailed(result, 'ZNIGHT005') as { at: string; message: string; related: string[] }[]
    expect(diagnostic?.at).toBe('src/app.controller.ts:8:3')
    expect(diagnostic?.message).toContain('Invalid route decorator @Bad: ')
    expect(diagnostic?.message).toContain(message)
    expect(diagnostic?.related).toEqual(['The route decorator is defined here @ src/bad.ts:3:14'])
    expect(result.controllers[0]?.routes[0]?.meta).toEqual([])
  })

  it('accepts createRouteDecorator(key, undefined) and an explicit group equal to the key', async () => {
    const result = await analyzeWithout({
      'src/flags.ts': `
import { createRouteDecorator } from '@znight/http'
export const A = createRouteDecorator('a', undefined)
export const B = createRouteDecorator('b', { group: 'b' })
`,
      'src/app.controller.ts': `
import { Controller, Get } from '@znight/http'
import { A, B } from './flags.ts'

@Controller('/app')
@A()
export class AppController {
  @Get()
  @B()
  index() { return 'ok' }
}
`,
    })
    expect(httpDiagnostics(result)).toEqual([])
    // own groups, not required: nothing for the runtime
    expect(generateSection(result).code).not.toContain('groups')
  })

  it('accepts any key without explicit group, like the runtime (its own group)', async () => {
    const result = await analyzeWithout({
      'src/flags.ts': `
import { createRouteDecorator } from '@znight/http'
export const Legacy = createRouteDecorator('auth:public')
export const Tagged = createRouteDecorator('app/tag', { required: true })
export const Internal = createRouteDecorator('_internal', { group: '_internal' })
`,
      'src/app.controller.ts': `
import { Controller, Get } from '@znight/http'
import { Internal, Legacy, Tagged } from './flags.ts'

@Controller('/app')
@Tagged()
export class AppController {
  @Get()
  @Legacy()
  @Internal()
  index() { return 'ok' }
}
`,
    })
    expect(httpDiagnostics(result)).toEqual([])
    const [controller] = result.controllers
    expect(controller?.meta.map(entry => [entry.key, entry.group, entry.required])).toEqual([
      ['app/tag', 'app/tag', true],
    ])
    expect(controller?.routes[0]?.meta.map(entry => [entry.key, entry.group, entry.required])).toEqual([
      ['auth:public', 'auth:public', false],
      ['_internal', '_internal', false],
    ])
    const code = generateSection(result).code.replace(/\s+/g, '')
    expect(code).toContain("groups:{'app/tag':{keys:['app/tag'],required:true,},}")
  })

  it('applies the group grammar to an explicit group only', async () => {
    const result = await analyzeWithout({
      'src/flags.ts': `
import { createRouteDecorator } from '@znight/http'
export const Bad = createRouteDecorator('auth:public', { group: 'auth:access' })
`,
      'src/app.controller.ts': `
import { Controller, Get } from '@znight/http'
import { Bad } from './flags.ts'

@Controller('/app')
export class AppController {
  @Get()
  @Bad()
  index() { return 'ok' }
}
`,
    })
    const [diagnostic] = detailed(result, 'ZNIGHT005') as { message: string }[]
    expect(diagnostic?.message).toContain('have an invalid group "auth:access"')
  })
})

describe('one decision per group and target', () => {
  it('reports two decisions of a group on a route or a controller (ZNIGHT005)', async () => {
    const result = await analyzeWith({
      'src/books.controller.ts': `
import { Controller, Delete, Get } from '@znight/http'
import { Authenticated, Public, Roles } from './auth/access.ts'

@Controller('/books')
@Public()
@Authenticated()
export class BookController {
  @Delete('/:id')
  @Public()
  @Roles(['admin'])
  remove(@Param('id') id: string) { return id }

  @Get()
  @Roles(['reader'])
  @Roles(['admin'])
  list() { return [] }
}
import { Param } from '@znight/http'
`,
    })
    expect(detailed(result, 'ZNIGHT005')).toEqual([
      {
        at: 'src/books.controller.ts:7:1',
        message:
          '@Authenticated sets the "access" decision of BookController, already set by @Public on the same target',
        hints: ['Keep one of @Public, @Authenticated: the decorators of the "access" group are alternatives'],
        related: ['First applied here @ src/books.controller.ts:6:1'],
      },
      {
        at: 'src/books.controller.ts:11:3',
        message:
          '@Roles sets the "access" decision of BookController.remove, already set by @Public on the same target',
        hints: ['Keep one of @Public, @Roles: the decorators of the "access" group are alternatives'],
        related: ['First applied here @ src/books.controller.ts:10:3'],
      },
      {
        at: 'src/books.controller.ts:16:3',
        message: '@Roles sets the "access" decision of BookController.list, already set by @Roles on the same target',
        hints: ['Keep @Roles once: the decorators of the "access" group are alternatives'],
        related: ['First applied here @ src/books.controller.ts:15:3'],
      },
    ])
  })
})

describe('consistency of the definitions', () => {
  it('reports one key defined with different options (ZNIGHT005 at the second definition)', async () => {
    const result = await analyzeWith({
      'src/legacy.ts': `
import { createRouteDecorator } from '@znight/http'
export const LegacyRoles = createRouteDecorator<readonly string[]>('roles')
`,
      'src/app.controller.ts': `
import { Controller, Get } from '@znight/http'
import { Roles } from './auth/access.ts'
import { LegacyRoles } from './legacy.ts'

@Controller('/a')
@Roles(['admin'])
export class AController {
  @Get()
  index() { return 'a' }
}

@Controller('/b')
@LegacyRoles(['admin'])
export class BController {
  @Get()
  index() { return 'b' }
}
`,
    })
    expect(detailed(result, 'ZNIGHT005')).toEqual([
      {
        at: 'src/legacy.ts:3:14',
        message:
          'The route decorator LegacyRoles defines the key "roles" with no group, but Roles defines it with group "access", required',
        hints: ['Every definition of a key must use the same options: share one definition'],
        related: ['Roles is defined here @ src/auth/access.ts:11:14'],
      },
    ])
  })

  it('reports decorators of a group disagreeing on required (ZNIGHT005)', async () => {
    const result = await analyzeWith({
      'src/optional.ts': `
import { createRouteDecorator } from '@znight/http'
export const Anonymous = createRouteDecorator('anonymous', { group: 'access' })
`,
      'src/app.controller.ts': `
import { Controller, Get } from '@znight/http'
import { Public } from './auth/access.ts'
import { Anonymous } from './optional.ts'

@Controller('/a')
@Public()
export class AController {
  @Get()
  index() { return 'a' }

  @Get('/b')
  @Anonymous()
  other() { return 'b' }
}
`,
    })
    const diagnostics = detailed(result, 'ZNIGHT005')
    expect(diagnostics).toEqual([
      {
        at: 'src/optional.ts:3:14',
        message: 'The "access" group is not required for Anonymous but required for Authenticated',
        hints: ['All the decorators of the "access" group must agree on required'],
        related: ['Authenticated is defined here @ src/auth/access.ts:10:14'],
      },
    ])
  })
})

describe('missing decisions (ZNIGHT023)', () => {
  it('reports a route without decision of a required group, with hint and related locations', async () => {
    const result = await analyzeWith({
      'src/books.controller.ts': `
import { Controller, Delete, Get, Post } from '@znight/http'
import { Public, Roles } from './auth/access.ts'

@Controller('/books')
export class BookController {
  @Get()
  @Public()
  list() { return [] }

  @Post()
  @Roles(['admin'])
  create() { return {} }

  @Delete('/:id')
  remove(@Param('id') id: string) { return id }
}
import { Param } from '@znight/http'
`,
    })
    expect(detailed(result, 'ZNIGHT023')).toEqual([
      {
        at: 'src/books.controller.ts:15:3',
        message: 'Route DELETE /books/:id (BookController.remove) has no "access" decision',
        hints: ['Add @Public(), @Authenticated() or @Roles(...) to the route or to BookController'],
        related: [
          'The "access" group is required @ src/auth/access.ts:9:14',
          'BookController is declared here @ src/books.controller.ts:5:1',
        ],
      },
    ])
    expect(result.diagnostics.find(diagnostic => diagnostic.code === 'ZNIGHT023')?.severity).toBe('error')
  })

  it('accepts a controller decision covering every route and route decisions replacing it', async () => {
    const result = await analyzeWith({
      'src/books.controller.ts': `
import { Controller, Get, Post } from '@znight/http'
import { Authenticated, Public, Roles } from './auth/access.ts'

@Controller('/books')
@Roles(['reader'])
export class BookController {
  @Get()
  list() { return [] }

  @Get('/cover')
  @Public()
  cover() { return '' }

  @Post()
  @Roles(['admin'])
  create() { return {} }
}

@Controller('/me')
export class MeController {
  @Get()
  @Authenticated()
  me() { return {} }
}
`,
    })
    expect(httpDiagnostics(result)).toEqual([])
  })

  it('requires a decision once a required group is defined, even when none of its decorators is applied', async () => {
    const result = await analyzeWith({
      'src/app.controller.ts': `
import { Controller, Get } from '@znight/http'
import { RateLimit } from './auth/access.ts'

@Controller('/a')
export class AController {
  @Get()
  @RateLimit(5)
  index() { return 'a' }

  @Get('/free')
  free() { return 'b' }
}
`,
    })
    expect(httpDiagnostics(result)).toEqual([
      'error ZNIGHT023 src/app.controller.ts:7:3 Route GET /a (AController.index) has no "access" decision',
      'error ZNIGHT023 src/app.controller.ts:11:3 Route GET /a/free (AController.free) has no "access" decision',
    ])
  })

  it('reports nothing without required group', async () => {
    const result = await analyzeWithout({
      'src/limits.ts': `
import { createRouteDecorator } from '@znight/http'
export const RateLimit = createRouteDecorator<number>('rateLimit')
`,
      'src/app.controller.ts': `
import { Controller, Get } from '@znight/http'
import { RateLimit } from './limits.ts'

@Controller('/a')
export class AController {
  @Get()
  @RateLimit(5)
  index() { return 'a' }

  @Get('/free')
  free() { return 'b' }
}
`,
    })
    expect(httpDiagnostics(result)).toEqual([])
  })

  it('resolves decorators of a source library', async () => {
    const result = await analyzeWith({
      'node_modules/@acme/auth/package.json': JSON.stringify({
        name: '@acme/auth',
        version: '1.0.0',
        type: 'module',
        exports: { '.': './src/index.ts' },
        znight: { apiVersion: 1, library: 'source' },
      }),
      'node_modules/@acme/auth/src/index.ts': `
import { createRouteDecorator } from '@znight/http'
export const Anyone = createRouteDecorator('anyone', { group: 'access', required: true })
export const Staff = createRouteDecorator('staff', { group: 'access', required: true })
`,
      'src/app.controller.ts': `
import { Controller, Get } from '@znight/http'
import { Anyone, Staff } from '@acme/auth'

@Controller('/a')
@Staff()
export class AController {
  @Get()
  @Anyone()
  index() { return 'a' }
}

@Controller('/b')
export class BController {
  @Get()
  index() { return 'b' }
}
`,
    })
    expect(httpDiagnostics(result)).toEqual([
      'error ZNIGHT023 src/app.controller.ts:15:3 Route GET /b (BController.index) has no "access" decision',
    ])
    expect(result.controllers.find(entry => entry.displayName === 'AController')?.meta[0]?.identity).toBe(
      '@acme/auth#Staff',
    )
  })
})

describe('groups metadata', () => {
  it('lists the groups the runtime needs, sorted, with sorted keys', async () => {
    const result = await analyzeWith({
      'src/extra.ts': `
import { createRouteDecorator } from '@znight/http'
export const Tenant = createRouteDecorator<string>('tenant', { group: 'tenancy' })
export const Cache = createRouteDecorator<number>('cache', { group: 'caching' })
export const NoCache = createRouteDecorator('noCache', { group: 'caching' })
`,
      'src/app.controller.ts': `
import { Controller, Get } from '@znight/http'
import { Public, RateLimit, Roles } from './auth/access.ts'
import { Cache, NoCache, Tenant } from './extra.ts'

@Controller('/a')
@Roles(['reader'])
@Tenant('acme')
@Cache(60)
export class AController {
  @Get()
  @RateLimit(3)
  index() { return 'a' }

  @Get('/open')
  @Public()
  @NoCache()
  open() { return 'b' }
}
`,
    })
    expect(httpDiagnostics(result)).toEqual([])
    const code = generateSection(result).code
    const groups = code.slice(code.indexOf('  groups: {'))
    expect(groups).toBe(`  groups: {
    access: {
      keys: ['public', 'roles'],
      required: true,
    },
    caching: {
      keys: ['cache', 'noCache'],
      required: false,
    },
    tenancy: {
      keys: ['tenant'],
      required: false,
    },
  },
}`)
  })
})
