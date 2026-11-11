/**
 * End to end: custom parameter decorators (RFC 0010) on HTTP routes. Function and class resolvers,
 * synchronous and asynchronous, data arguments, mixed with validated arguments; the generated module
 * type-checks under strict options, and routes without custom parameters are unchanged.
 */
import type { ZnightMetadata } from '@znight/core'
import type { HttpMetadata, InjectRequest, InjectResponse } from '../../src/index.ts'
import type { TempApp } from './helpers.ts'

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as compiler from '@znight/compiler'
import { Application, silentLogger } from '@znight/core'

import { HttpPlugin } from '../../src/index.ts'
import { cleanupApps, render, TSC, tempApp } from './helpers.ts'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

type Compile = (options: Record<string, unknown>) => Promise<{
  readonly code: string
  readonly outFile: string
  readonly diagnostics: readonly compiler.Diagnostic[]
}>

const compile = (compiler as unknown as { readonly compile?: Compile }).compile

const USER = `
export interface User {
  readonly id: string
  readonly roles: readonly string[]
}

/** Calls of resolvers and handlers, in order (read and reset by GET /custom/calls). */
export const calls: string[] = []
`

const RESOLVERS = `
import type { ParamResolver } from '@znight/core'
import type { HttpContext } from '@znight/http'
import { Injectable } from '@znight/core'
import { UnauthorizedException } from '@znight/http'
import { calls, type User } from './user.ts'

let created = 0

/** Request-scoped: one instance per request, memoizing the user it loads. */
@Injectable({ scope: 'request' })
export class LoadedUserResolver implements ParamResolver<HttpContext, User> {
  readonly #instance = ++created
  #user: Promise<User> | undefined

  async resolve(ctx: HttpContext): Promise<User> {
    calls.push(\`loaded \${this.#instance}\`)
    this.#user ??= Promise.resolve(userOf(ctx))
    return this.#user
  }
}

/** A singleton with a dependency-free synchronous resolve(). */
export class LocaleResolver {
  resolve(ctx: HttpContext, fallback: string): string {
    calls.push('locale')
    return ctx.header('accept-language') ?? fallback
  }
}

/** \`resolve\` inherited from a base class. */
class BaseRoleResolver {
  resolve(ctx: HttpContext): string {
    return ctx.header('x-role') ?? 'guest'
  }
}
export class RoleResolver extends BaseRoleResolver {}

/** \`resolve\` declared as an arrow function property. */
export class TokenResolver {
  readonly resolve = (ctx: HttpContext): string => ctx.header('x-token') ?? 'none'
}

/** \`resolve\` from a base the compiler cannot analyse (a mixin): its arity is unknown. */
// biome-ignore lint/suspicious/noExplicitAny: the constructor type TypeScript requires of a mixin
function withResolve<T extends new (...args: any[]) => object>(base: T) {
  return class extends base {
    resolve(ctx: HttpContext): string {
      return ctx.header('x-mixed') ?? 'mixed'
    }
  }
}
const Mixed = withResolve(class {})
export class MixedResolver extends Mixed {
  // biome-ignore lint/complexity/noUselessConstructor: a constructor the compiler can read
  constructor() {
    super()
  }
}

/** \`resolve()\` reads nothing from the context. */
export class ConstantResolver {
  resolve(): string {
    return 'constant'
  }
}

export function userOf(ctx: HttpContext): User {
  const user = ctx.state.get('user') as User | undefined
  if (user === undefined) throw new UnauthorizedException()
  return user
}
`

const DECORATORS = `
import { createParamDecorator } from '@znight/core'
import { validate } from '@znight/http'
import {
  ConstantResolver,
  LoadedUserResolver,
  LocaleResolver,
  MixedResolver,
  RoleResolver,
  TokenResolver,
  userOf,
} from './resolvers.ts'
import { calls, type User } from './user.ts'
import type { StandardSchemaV1 } from '@znight/http'

export const CurrentUser = createParamDecorator<User>({
  http: ctx => {
    calls.push('current user')
    return userOf(ctx)
  },
})
export const OptionalUser = createParamDecorator<User | undefined>({
  http: ctx => ctx.state.get('user') as User | undefined,
})
export const AsyncUser = createParamDecorator<User>({
  http: async ctx => {
    calls.push('async user')
    await new Promise(resolve => setTimeout(resolve, 1))
    return userOf(ctx)
  },
})
export const Claim = createParamDecorator<string, keyof User>({ http: (ctx, key) => String(userOf(ctx)[key]) })
export const LoadedUser = createParamDecorator<User>({ http: LoadedUserResolver })
export const Locale = createParamDecorator<string, string>({ http: LocaleResolver })
export const Role = createParamDecorator<string>({ http: RoleResolver })
export const Token = createParamDecorator<string>({ http: TokenResolver })
export const Mixin = createParamDecorator<string>({ http: MixedResolver })
export const Constant = createParamDecorator<string>({ http: ConstantResolver })
export const Header = createParamDecorator<unknown, { readonly name: string; readonly schema: StandardSchemaV1 }>({
  http: (ctx, { name, schema }) => validate(schema, ctx.header(name), \`header "\${name}"\`),
})
`

const SCHEMAS = `
import type { StandardSchemaV1 } from '@znight/http'
import { calls } from './user.ts'

function schema<T>(name: string, check: (value: unknown) => T | undefined): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate(value: unknown) {
        calls.push(name)
        const output = check(value)
        return output === undefined ? { issues: [{ message: \`invalid \${name}\` }] } : { value: output }
      },
    },
  }
}

export const Named = schema('name', value => {
  const name = (value as { name?: unknown } | undefined)?.name
  return typeof name === 'string' && name !== 'bad' ? { name } : undefined
})
export const TenantId = schema('tenant', value => (typeof value === 'string' && /^t-/.test(value) ? value : undefined))
export const TenantHeader = { name: 'x-tenant', schema: TenantId } as const
`

const CONTROLLER = `
import type { CanActivate, HttpContext } from '@znight/http'
import { Injectable } from '@znight/core'
import { Body, Controller, Get, Post, Query, UseGuard } from '@znight/http'
import {
  AsyncUser,
  Claim,
  Constant,
  CurrentUser,
  Header,
  LoadedUser,
  Locale,
  Mixin,
  OptionalUser,
  Role,
  Token,
} from './decorators.ts'
import { Named, TenantHeader } from './schemas.ts'
import { calls, type User } from './user.ts'

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(ctx: HttpContext): boolean {
    const id = ctx.header('x-user')
    if (id !== undefined) ctx.state.set('user', { id, roles: ['reader'] } satisfies User)
    return true
  }
}

@Controller('/custom')
@UseGuard(AuthGuard)
export class CustomController {
  @Get('/calls')
  calls() {
    return calls.splice(0)
  }

  @Get('/plain')
  plain(@Query('page') page = 1) {
    return { page }
  }

  @Get('/me')
  me(@CurrentUser() user: User, @Query('page') page = 1) {
    calls.push('handler')
    return { id: user.id, page }
  }

  @Get('/optional')
  optional(@OptionalUser() user?: User) {
    return { id: user?.id ?? null }
  }

  @Get('/claim')
  claim(@Claim('id') id: string, @Claim('roles') roles: string) {
    return { id, roles }
  }

  @Post('/async')
  async(@AsyncUser() user: User, @Body(Named) body: { name: string }) {
    calls.push('handler')
    return { id: user.id, ...body }
  }

  @Post('/validated-first')
  validatedFirst(@Body(Named) body: { name: string }, @CurrentUser() user: User) {
    calls.push('handler')
    return { id: user.id, ...body }
  }

  @Get('/loaded')
  loaded(@LoadedUser() first: User, @Locale('en') locale: string, @LoadedUser() second: User) {
    calls.push('handler')
    return { same: first === second, id: first.id, locale }
  }

  @Get('/tenant')
  tenant(@Header(TenantHeader) tenant: unknown) {
    return { tenant }
  }

  @Get('/constant')
  constant(@Constant() value: string) {
    return { value }
  }

  @Get('/inherited')
  inherited(@Role() role: string, @Token() token: string, @Mixin() mixed: string) {
    return { role, token, mixed }
  }
}
`

describe.skipIf(typeof compile !== 'function')('custom parameter decorators on HTTP routes (e2e)', () => {
  let application: Application
  let http: HttpPlugin
  let app: TempApp
  let code: string
  let outFile: string
  let metadata: ZnightMetadata

  beforeAll(async () => {
    app = tempApp({
      'src/user.ts': USER,
      'src/resolvers.ts': RESOLVERS,
      'src/decorators.ts': DECORATORS,
      'src/schemas.ts': SCHEMAS,
      'src/custom.controller.ts': CONTROLLER,
    })
    const result = await (compile as Compile)({ root: app.root, conditions: ['@znight/source'], mode: 'test' })
    expect(render({ root: app.root, diagnostics: result.diagnostics })).toEqual([])
    code = result.code
    outFile = result.outFile
    fs.mkdirSync(path.dirname(result.outFile), { recursive: true })
    fs.writeFileSync(result.outFile, result.code)
    metadata = ((await import(pathToFileURL(result.outFile).href)) as { metadata: ZnightMetadata }).metadata
    http = HttpPlugin.configure({ port: 0, host: '127.0.0.1' })
    application = await Application.create({
      metadata,
      plugins: [http],
      logger: silentLogger,
      shutdown: { signals: false },
    })
    await application.start()
  })

  afterAll(async () => {
    await application?.stop()
    cleanupApps()
  })

  const send = (request: InjectRequest): Promise<InjectResponse> => http.inject(request)
  const calls = async (): Promise<unknown> => (await send({ method: 'GET', url: '/custom/calls' })).json()

  it('generates direct resolver calls, synchronous until a resolver returns a thenable', () => {
    expect(code).toContain(
      [
        "              ['invoke']: (c: CustomController, ctx: HttpContext) => {",
        "                const a0 = (CurrentUser.resolvers.http as ParamFunctionOf<typeof CurrentUser, 'http'>)(ctx, undefined)",
        '                if (isThenable(a0)) return (async () =>',
        `                  c.me(await a0, coerce.optional(ctx.query['page'], 'query "page"', coerce.number)))()`,
        `                return c.me(a0, coerce.optional(ctx.query['page'], 'query "page"', coerce.number))`,
        '              },',
      ].join('\n'),
    )
    // class resolvers: `x`, tokens in order of first use
    expect(code).toContain(
      "['paramResolvers']: ['src/resolvers.ts#LoadedUserResolver', 'src/resolvers.ts#LocaleResolver'],",
    )
    expect(code).toContain(
      '(c: CustomController, ctx: HttpContext, x: readonly [LoadedUserResolver, LocaleResolver]) => {',
    )
    expect(code).toContain("const a1 = x[1].resolve(ctx, 'en')")
    // resolve(ctx) declares no data parameter: none is passed
    expect(code).toContain('const a0 = x[0].resolve(ctx)')
    // a resolve() without parameter: the context is not read (\`_ctx\`, noUnusedParameters)
    expect(code).toContain(
      [
        "              ['invoke']: (c: CustomController, _ctx: HttpContext, x: readonly [ConstantResolver]) => {",
        '                const a0 = x[0].resolve()',
      ].join('\n'),
    )
    // also when it is inherited or an arrow function property; cast when it cannot be read
    expect(code).toContain(
      '(c: CustomController, ctx: HttpContext, x: readonly [RoleResolver, TokenResolver, MixedResolver]) => {',
    )
    expect(code).toContain('const a1 = x[1].resolve(ctx)')
    expect(code).toContain(
      'const a2 = (x[2] as { resolve(ctx: unknown, data: unknown): unknown }).resolve(ctx, undefined) as never',
    )
    // a route without custom parameter is unchanged
    expect(code).toContain(
      [
        "              ['invoke']: (c: CustomController, ctx: HttpContext) =>",
        `                c.plain(coerce.optional(ctx.query['page'], 'query "page"', coerce.number)),`,
      ].join('\n'),
    )
    const section = metadata.extensions?.['http'] as HttpMetadata
    const me = section.controllers[0]?.routes.find(route => route.handler === 'me')
    expect(me?.params[0]).toEqual({ index: 0, source: 'custom', name: 'CurrentUser' })
    expect(me && 'paramResolvers' in me).toBe(false)
  })

  it('generates a module that type-checks with strict compiler options', () => {
    app.write(
      'tsconfig.check.json',
      JSON.stringify({
        compilerOptions: {
          target: 'ES2024',
          lib: ['ES2024', 'ESNext.Disposable', 'DOM'],
          module: 'preserve',
          moduleResolution: 'bundler',
          customConditions: ['@znight/source'],
          strict: true,
          noUnusedLocals: true,
          noUnusedParameters: true,
          noPropertyAccessFromIndexSignature: true,
          exactOptionalPropertyTypes: true,
          verbatimModuleSyntax: true,
          experimentalDecorators: true,
          allowImportingTsExtensions: true,
          skipLibCheck: true,
          noEmit: true,
          types: ['node'],
        },
        include: ['src'],
        files: [path.relative(app.root, outFile)],
      }),
    )
    const run = spawnSync(process.execPath, [TSC, '-p', 'tsconfig.check.json', '--listFiles'], {
      cwd: app.root,
      encoding: 'utf8',
    })
    const output = `${run.stdout}${run.stderr}`
    expect(run.error).toBeUndefined()
    expect(output).toContain(outFile)
    expect(output.split('\n').filter(line => line.startsWith('src/'))).toEqual([])
  })

  it('injects the value of a function resolver; its exceptions become responses', async () => {
    const ok = await send({ method: 'GET', url: '/custom/me?page=3', headers: { 'x-user': 'ada' } })
    expect(ok.status).toBe(200)
    expect(ok.json()).toEqual({ id: 'ada', page: 3 })
    expect(await calls()).toEqual(['current user', 'handler'])
    const anonymous = await send({ method: 'GET', url: '/custom/me' })
    expect(anonymous.status).toBe(401)
    expect(await calls()).toEqual(['current user'])
    const optional = await send({ method: 'GET', url: '/custom/optional' })
    expect(optional.json()).toEqual({ id: null })
  })

  it('passes the data argument', async () => {
    const response = await send({ method: 'GET', url: '/custom/claim', headers: { 'x-user': 'lin' } })
    expect(response.json()).toEqual({ id: 'lin', roles: 'reader' })
    const tenant = await send({ method: 'GET', url: '/custom/tenant', headers: { 'x-tenant': 't-1' } })
    expect(tenant.json()).toEqual({ tenant: 't-1' })
    const invalid = await send({ method: 'GET', url: '/custom/tenant', headers: { 'x-tenant': 'nope' } })
    expect(invalid.status).toBe(400)
    expect(invalid.json()).toMatchObject({ message: 'Invalid header "x-tenant"' })
    await calls()
  })

  it('awaits an asynchronous resolver, then evaluates the next arguments in order', async () => {
    const ok = await send({ method: 'POST', url: '/custom/async', headers: { 'x-user': 'ada' }, body: { name: 'x' } })
    expect(ok.status).toBe(201)
    expect(ok.json()).toEqual({ id: 'ada', name: 'x' })
    expect(await calls()).toEqual(['async user', 'name', 'handler'])
    // the resolver fails first: the body is not validated
    const failed = await send({ method: 'POST', url: '/custom/async', body: { name: 'bad' } })
    expect(failed.status).toBe(401)
    expect(await calls()).toEqual(['async user'])
    // a validation before the resolver fails first: the resolver does not run
    const invalid = await send({ method: 'POST', url: '/custom/validated-first', body: { name: 'bad' } })
    expect(invalid.status).toBe(400)
    expect(await calls()).toEqual(['name'])
  })

  it('calls a resolve() without parameter', async () => {
    const response = await send({ method: 'GET', url: '/custom/constant' })
    expect(response.json()).toEqual({ value: 'constant' })
  })

  it('calls inherited, arrow function and unanalysable resolve methods', async () => {
    const response = await send({ method: 'GET', url: '/custom/inherited', headers: { 'x-role': 'admin' } })
    expect(response.json()).toEqual({ role: 'admin', token: 'none', mixed: 'mixed' })
  })

  it('resolves class resolvers in the request scope', async () => {
    const first = await send({ method: 'GET', url: '/custom/loaded', headers: { 'x-user': 'ada' } })
    expect(first.json()).toEqual({ same: true, id: 'ada', locale: 'en' })
    const second = await send({
      method: 'GET',
      url: '/custom/loaded',
      headers: { 'x-user': 'lin', 'accept-language': 'fr' },
    })
    expect(second.json()).toEqual({ same: true, id: 'lin', locale: 'fr' })
    // one request-scoped instance per request, used by both parameters
    expect(await calls()).toEqual([
      'loaded 1',
      'locale',
      'loaded 1',
      'handler',
      'loaded 2',
      'locale',
      'loaded 2',
      'handler',
    ])
  })
})
