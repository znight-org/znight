/**
 * Route decisions end to end: an application using required decorator groups is compiled with
 * `compile()`, its generated module is imported and served by `HttpPlugin`. The former fail-open
 * case (a public controller with an admin route) is denied; a forgotten guard fails the boot; an
 * undecided route fails the build.
 */
import type { ZnightMetadata } from '@znight/core'
import type { TempApp } from './helpers.ts'

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as compiler from '@znight/compiler'
import { Application, ErrorCode, silentLogger, ZnightError } from '@znight/core'

import { HttpPlugin } from '../../src/index.ts'
import { cleanupApps, render, tempApp } from './helpers.ts'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

type Compile = (options: Record<string, unknown>) => Promise<{
  readonly code: string
  readonly outFile: string
  readonly diagnostics: readonly compiler.Diagnostic[]
}>

const compile = (compiler as unknown as { readonly compile?: Compile }).compile

const FILES: Record<string, string> = {
  'src/auth/access.ts': `
import { createRouteDecorator } from '@znight/http'

export const Public = createRouteDecorator('public', { group: 'access', required: true })
export const Authenticated = createRouteDecorator('authenticated', { group: 'access', required: true })
export const Roles = createRouteDecorator<readonly string[]>('roles', { group: 'access', required: true })
`,
  'src/auth/auth.guard.ts': `
import { Injectable } from '@znight/core'
import { type CanActivate, type HttpContext, UnauthorizedException } from '@znight/http'
import { Authenticated, Public, Roles } from './access.ts'

const KEYS: Record<string, readonly string[]> = { admin: ['admin', 'reader'], reader: ['reader'] }

@Injectable()
export class AuthGuard implements CanActivate {
  static readonly enforces = [Public, Authenticated, Roles]

  canActivate(ctx: HttpContext): boolean {
    if (Public.get(ctx)) return true
    const roles = KEYS[ctx.header('x-api-key') ?? '']
    if (roles === undefined) throw new UnauthorizedException()
    const required = Roles.get(ctx)
    if (required !== undefined) return required.some(role => roles.includes(role))
    return Authenticated.get(ctx) === true
  }
}
`,
  'src/status.controller.ts': `
import { Controller, Get } from '@znight/http'
import { Public, Roles } from './auth/access.ts'

@Controller('/status')
@Public()
export class StatusController {
  @Get()
  health() { return 'up' }

  @Get('/details')
  @Roles(['admin'])
  details() { return 'details' }
}
`,
  'src/me.controller.ts': `
import { Controller, Get } from '@znight/http'
import { Authenticated } from './auth/access.ts'

@Controller('/me')
@Authenticated()
export class MeController {
  @Get()
  me() { return 'me' }
}
`,
}

async function compileApp(app: TempApp): Promise<{ code: string; outFile: string; errors: string[] }> {
  const result = await (compile as Compile)({ root: app.root, conditions: ['@znight/source'], mode: 'test' })
  const errors = render({
    root: app.root,
    diagnostics: result.diagnostics.filter(diagnostic => diagnostic.severity === 'error'),
  })
  return { code: result.code, outFile: result.outFile, errors }
}

describe.skipIf(typeof compile !== 'function')('route decisions (e2e)', () => {
  let metadata: ZnightMetadata
  let code: string

  beforeAll(async () => {
    const app = tempApp(FILES)
    const result = await compileApp(app)
    expect(result.errors).toEqual([])
    code = result.code
    fs.mkdirSync(path.dirname(result.outFile), { recursive: true })
    fs.writeFileSync(result.outFile, result.code)
    const generated = (await import(pathToFileURL(result.outFile).href)) as { __ZNIGHT_METADATA__: ZnightMetadata }
    metadata = generated.__ZNIGHT_METADATA__
  })

  afterAll(cleanupApps)

  async function boot(guards: boolean): Promise<{ app: Application; http: HttpPlugin }> {
    // the class imported by the generated module (the same module instance as the application's)
    const AuthGuard = metadata.providers['src/auth/auth.guard.ts#AuthGuard']?.class as never
    expect(AuthGuard).toBeDefined()
    const http = HttpPlugin.configure({ port: 0, ...(guards ? { guards: [AuthGuard] } : {}) })
    const app = await Application.create({
      metadata,
      plugins: [http],
      logger: silentLogger,
      shutdown: { signals: false },
    })
    return { app, http }
  }

  it('emits the groups', () => {
    const compact = code.replace(/\s+/g, '').replace(/,([)\]}])/g, '$1')
    expect(compact).toContain("['groups']:{['access']:{['keys']:['authenticated','public','roles'],['required']:true}}")
  })

  it('denies the admin route of a public controller (nearest decision wins)', async () => {
    const { app, http } = await boot(true)
    try {
      expect((await http.inject({ method: 'GET', url: '/status' })).status).toBe(200)
      expect((await http.inject({ method: 'GET', url: '/status/details' })).status).toBe(401)
      const reader = await http.inject({ method: 'GET', url: '/status/details', headers: { 'x-api-key': 'reader' } })
      expect(reader.status).toBe(403)
      const admin = await http.inject({ method: 'GET', url: '/status/details', headers: { 'x-api-key': 'admin' } })
      expect(admin.status).toBe(200)
      expect((await http.inject({ method: 'GET', url: '/me', headers: { 'x-api-key': 'reader' } })).body).toBe('me')
    } finally {
      await app.stop()
    }
  })

  it('refuses to boot without a guard enforcing the access group', async () => {
    let error: unknown
    try {
      await boot(false)
    } catch (thrown) {
      error = thrown
    }
    expect(error).toBeInstanceOf(ZnightError)
    expect((error as ZnightError).code).toBe(ErrorCode.MissingRouteDecision)
    expect((error as ZnightError).message).toContain('No guard enforces the required "access" group on 3 routes')
  })

  it('fails the build for an undecided route', async () => {
    const app = tempApp({
      ...FILES,
      'src/me.controller.ts': `
import { Controller, Get } from '@znight/http'

@Controller('/me')
export class MeController {
  @Get()
  me() { return 'me' }
}
`,
    })
    const result = await compileApp(app)
    expect(result.errors).toEqual([
      'error ZNIGHT023 src/me.controller.ts:6:3 Route GET /me (MeController.me) has no "access" decision',
    ])
  })
})

/** The security guide's rate-limit recipe, with route decorators keyed by legacy (pre-group) keys. */
const LIMITS: Record<string, string> = {
  'src/limits.ts': `
import { createRouteDecorator } from '@znight/http'

export const RateLimit = createRouteDecorator<number>('rateLimit')
export const Legacy = createRouteDecorator('auth:public')
export const Tagged = createRouteDecorator('app/tag', { required: true })
`,
  'src/rate-limit.guard.ts': `
import { Injectable } from '@znight/core'
import { type CanActivate, type HttpContext } from '@znight/http'
import { RateLimit, Tagged } from './limits.ts'

@Injectable()
export class RateLimitGuard implements CanActivate {
  static readonly enforces = [RateLimit, Tagged]

  canActivate(ctx: HttpContext): boolean {
    return RateLimit.get(ctx) === undefined
  }
}
`,
  'src/hooks.controller.ts': `
import { Controller, Post } from '@znight/http'
import { Legacy, RateLimit, Tagged } from './limits.ts'

@Controller('/hooks')
@Tagged()
export class HooksController {
  @Post('/billing')
  @RateLimit(5)
  @Legacy()
  billing() { return 'ok' }
}
`,
}

describe.skipIf(typeof compile !== 'function')('legacy keys and forgotten guards (e2e)', () => {
  let metadata: ZnightMetadata

  beforeAll(async () => {
    const result = await compileApp(tempApp(LIMITS))
    expect(result.errors).toEqual([])
    fs.mkdirSync(path.dirname(result.outFile), { recursive: true })
    fs.writeFileSync(result.outFile, result.code)
    // importing the generated module loads the decorators keyed 'auth:public' and 'app/tag'
    const generated = (await import(pathToFileURL(result.outFile).href)) as { __ZNIGHT_METADATA__: ZnightMetadata }
    metadata = generated.__ZNIGHT_METADATA__
  })

  afterAll(cleanupApps)

  async function boot(guards: readonly unknown[]): Promise<{ app: Application; http: HttpPlugin }> {
    const http = HttpPlugin.configure({ port: 0, guards: guards as never })
    const app = await Application.create({
      metadata,
      plugins: [http],
      logger: silentLogger,
      shutdown: { signals: false },
    })
    return { app, http }
  }

  it('enforces the decisions with the guard in the chain', async () => {
    const RateLimitGuard = metadata.providers['src/rate-limit.guard.ts#RateLimitGuard']?.class
    expect(RateLimitGuard).toBeDefined()
    const { app, http } = await boot([RateLimitGuard])
    try {
      const response = await http.inject({ method: 'POST', url: '/hooks/billing' })
      expect(response.status).toBe(403)
      expect(http.routes.find(route => route.method === 'POST')?.meta).toEqual({
        'app/tag': true,
        rateLimit: 5,
        'auth:public': true,
      })
    } finally {
      await app.stop()
    }
  })

  it('refuses to boot when the guard of a non-required group is registered nowhere', async () => {
    let error: unknown
    try {
      await boot([])
    } catch (thrown) {
      error = thrown
    }
    expect(error).toBeInstanceOf(ZnightError)
    expect((error as ZnightError).code).toBe(ErrorCode.MissingRouteDecision)
    expect((error as ZnightError).message).toContain('no guard enforces the "rateLimit" group on 1 route')
    expect((error as ZnightError).hints).toContain(
      'Guards of the application enforcing the "rateLimit" group: RateLimitGuard',
    )
  })
})
