/**
 * End to end: the `invoke` generated for routes validating arguments stays synchronous while every
 * `validate()` returns a value, and behaves like an `async` invoke `await`ing every validation
 * otherwise (asynchronous schemas, outputs that are promises): same order of evaluation, same error
 * when several arguments are invalid, same value received by the handler.
 */
import type { ZnightMetadata } from '@znight/core'
import type { HttpMetadata, HttpRouteDefinition, InjectRequest, InjectResponse } from '../../src/index.ts'
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

const SCHEMAS = `
import type { StandardSchemaV1, StandardSchemaV1Result } from '@znight/http'

/** Validations run, in order (read and reset by GET /checks/calls). */
export const calls: string[] = []

/** A Standard Schema recording its runs; \`async\`: the result is delivered on a later tick. */
function schema<T>(name: string, check: (value: unknown) => T | undefined, async = false): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate(value: unknown) {
        calls.push(name)
        const output = check(value)
        const result: StandardSchemaV1Result<T> =
          output === undefined ? { issues: [{ message: \`invalid \${name}\` }] } : { value: output }
        return async ? new Promise<StandardSchemaV1Result<T>>(resolve => setTimeout(() => resolve(result), 1)) : result
      },
    },
  }
}

const id = (value: unknown): number | undefined =>
  typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : undefined
const named = (value: unknown): { name: string } | undefined => {
  const name = (value as { name?: unknown } | undefined)?.name
  return typeof name === 'string' && name !== 'bad' ? { name: name.toUpperCase() } : undefined
}

export const SyncId = schema('sync id', id)
export const AsyncId = schema('async id', id, true)
export const SyncName = schema('sync name', named)
export const AsyncName = schema('async name', named, true)
/** Validates synchronously, but its output is a promise: the handler receives the settled value. */
export const Deferred = schema('deferred', value =>
  typeof value === 'string' ? Promise.resolve(\`deferred \${value}\`) : undefined,
)
/** Loose outputs: the generated invoke must still type-check (the thenable guard keeps the output type). */
export const Loose = schema<Record<string, any>>('loose', value =>
  typeof value === 'object' && value !== null ? (value as Record<string, any>) : undefined,
)
export const Plain = schema<object>('plain', value => (typeof value === 'object' && value !== null ? value : undefined))
`

const CONTROLLER = `
import type { CallHandler, HttpContext, HttpInterceptor } from '@znight/http'
import { Injectable } from '@znight/core'
import { Body, Controller, Ctx, Get, Headers, Param, Patch, Post, Put, Query, UseInterceptor } from '@znight/http'
import { AsyncId, AsyncName, calls, Deferred, Loose, Plain, SyncId, SyncName } from './schemas.ts'

@Injectable()
export class TagInterceptor implements HttpInterceptor {
  async intercept(ctx: HttpContext, next: CallHandler): Promise<unknown> {
    ctx.setHeader('x-tag', 'seen')
    return await next()
  }
}

@Controller('/checks')
export class ChecksController {
  @Get('/calls')
  calls() {
    return calls.splice(0)
  }

  @Post('/sync')
  sync(@Body(SyncName) body: { name: string }) {
    calls.push('handler')
    return body
  }

  @Post('/async')
  async(@Body(AsyncName) body: { name: string }) {
    calls.push('handler')
    return body
  }

  @Post('/intercepted')
  @UseInterceptor(TagInterceptor)
  intercepted(@Body(SyncName) body: { name: string }) {
    return body
  }

  @Put('/:id')
  put(@Param('id', AsyncId) id: number, @Query('page') page: number, @Body(SyncName) body: { name: string }) {
    calls.push('handler')
    return { id, page, ...body }
  }

  @Patch('/:id')
  patch(@Param('id', SyncId) id: number, @Body(AsyncName) body: { name: string }) {
    calls.push('handler')
    return { id, ...body }
  }

  @Get('/deferred')
  deferred(@Query('v', Deferred) v: string) {
    return { v }
  }

  @Post('/loose')
  loose(@Body(Loose) body: Record<string, any>, @Query('p', Plain) p?: object) {
    return { keys: Object.keys(body).length, p: p === undefined ? null : typeof p }
  }

  /** Whole records cast to the declared types, @Ctx() inlined, an optional coercion after the validation. */
  @Post('/mixed/:id')
  mixed(
    @Headers() headers: Record<string, string | undefined>,
    @Ctx() ctx: HttpContext,
    @Param('id', SyncId) id: number,
    @Query('flag') flag?: boolean,
  ) {
    return { agent: headers['x-agent'] ?? null, method: ctx.method, id, flag: flag ?? null }
  }
}
`

describe.skipIf(typeof compile !== 'function')('generated invoke with validated arguments (e2e)', () => {
  let application: Application
  let http: HttpPlugin
  let app: TempApp
  let code: string
  let outFile: string
  let metadata: ZnightMetadata

  beforeAll(async () => {
    app = tempApp({ 'src/schemas.ts': SCHEMAS, 'src/checks.controller.ts': CONTROLLER })
    const result = await (compile as Compile)({ root: app.root, conditions: ['@znight/source'], mode: 'test' })
    expect(render({ root: app.root, diagnostics: result.diagnostics })).toEqual([])
    code = result.code
    outFile = result.outFile
    fs.mkdirSync(path.dirname(result.outFile), { recursive: true })
    fs.writeFileSync(result.outFile, result.code)
    metadata = ((await import(pathToFileURL(result.outFile).href)) as { __ZNIGHT_METADATA__: ZnightMetadata })
      .__ZNIGHT_METADATA__
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
  const calls = async (): Promise<unknown> => (await send({ method: 'GET', url: '/checks/calls' })).json()

  /** The generated `invoke` of a handler. */
  function invokeOf(handler: string): HttpRouteDefinition['invoke'] {
    const section = metadata.extensions?.['http'] as HttpMetadata
    const route = section.controllers.flatMap(controller => controller.routes).find(item => item.handler === handler)
    if (route === undefined) throw new Error(`no route ${handler}`)
    return route.invoke
  }

  it('generates synchronous arrows (no async keyword at the top level)', () => {
    expect(code).not.toMatch(/\['invoke'\]: async/)
    expect(code).toContain('if (isThenable(a0)) return (async () => c.sync(await a0))()')
    expect(code).toContain(
      [
        "              ['invoke']: (c: ChecksController, ctx: HttpContext) => {",
        '                const a0 = ctx.headers as never',
        `                const a2 = validate(SyncId, ctx.params['id'], 'param "id"')`,
        '                if (isThenable(a2)) return (async () =>',
        `                  c.mixed(a0, ctx, await a2, coerce.optional(ctx.query['flag'], 'query "flag"', coerce.boolean)))()`,
        `                return c.mixed(a0, ctx, a2, coerce.optional(ctx.query['flag'], 'query "flag"', coerce.boolean))`,
        '              },',
      ].join('\n'),
    )
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
        files: [path.relative(app.root, outFile)], // `include` skips dot directories (src/.znight)
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

  it('passes whole records, the context and coerced values after a validation', async () => {
    const response = await send({
      method: 'POST',
      url: '/checks/mixed/5?flag=1',
      headers: { 'x-agent': 'probe' },
    })
    expect(response.json()).toEqual({ agent: 'probe', method: 'POST', id: 5, flag: true })
    const invalid = await send({ method: 'POST', url: '/checks/mixed/x?flag=maybe' })
    expect(invalid.json()).toMatchObject({ message: 'Invalid param "id"' })
    await calls()
  })

  it('returns the handler result synchronously when the schemas validate synchronously', async () => {
    const controller = { sync: (body: unknown) => ({ handled: body }) }
    const invoke = invokeOf('sync')
    const result = invoke(controller, { body: { name: 'ada' } } as never)
    expect(result).toEqual({ handled: { name: 'ADA' } })
    // a sync validation failure is thrown synchronously (the pipeline maps both forms)
    expect(() => invoke(controller, { body: { name: 'bad' } } as never)).toThrow('Invalid body')
    await calls()
  })

  it('returns a promise of the handler result when a schema validates asynchronously', async () => {
    const controller = { async: (body: unknown) => ({ handled: body }) }
    const result = invokeOf('async')(controller, { body: { name: 'lin' } } as never)
    expect(result).toBeInstanceOf(Promise)
    expect(await result).toEqual({ handled: { name: 'LIN' } })
    await calls()
  })

  it('serves both paths', async () => {
    const sync = await send({ method: 'POST', url: '/checks/sync', body: { name: 'ada' } })
    expect(sync.status).toBe(201)
    expect(sync.json()).toEqual({ name: 'ADA' })
    const async = await send({ method: 'POST', url: '/checks/async', body: { name: 'lin' } })
    expect(async.status).toBe(201)
    expect(async.json()).toEqual({ name: 'LIN' })
    expect(await calls()).toEqual(['sync name', 'handler', 'async name', 'handler'])

    const invalid = await send({ method: 'POST', url: '/checks/async', body: { name: 'bad' } })
    expect(invalid.status).toBe(400)
    expect(invalid.json()).toMatchObject({ message: 'Invalid body' })
    expect(await calls()).toEqual(['async name'])
  })

  it('maps a synchronous validation failure under an interceptor', async () => {
    const invalid = await send({ method: 'POST', url: '/checks/intercepted', body: { name: 'bad' } })
    expect(invalid.status).toBe(400)
    expect(invalid.headers['x-tag']).toBe('seen')
    const valid = await send({ method: 'POST', url: '/checks/intercepted', body: { name: 'ok' } })
    expect(valid.json()).toEqual({ name: 'OK' })
    await calls()
  })

  it('evaluates the arguments after an asynchronous validation once it settled, in order', async () => {
    const ok = await send({ method: 'PUT', url: '/checks/7?page=2', body: { name: 'lin' } })
    expect(ok.status).toBe(200)
    expect(ok.json()).toEqual({ id: 7, page: 2, name: 'LIN' })
    expect(await calls()).toEqual(['async id', 'sync name', 'handler'])

    // every argument invalid: the first one wins, the later ones are not evaluated
    const first = await send({ method: 'PUT', url: '/checks/x?page=y', body: { name: 'bad' } })
    expect(first.status).toBe(400)
    expect(first.json()).toMatchObject({ message: 'Invalid param "id"' })
    expect(await calls()).toEqual(['async id'])

    // the coercion (second argument) fails before the body (third) is validated
    const second = await send({ method: 'PUT', url: '/checks/7?page=y', body: { name: 'bad' } })
    expect(second.status).toBe(400)
    expect(second.json()).toMatchObject({ message: 'Invalid query "page": expected a number, received "y"' })
    expect(await calls()).toEqual(['async id'])
  })

  it('validates the arguments before an asynchronous validation synchronously, in order', async () => {
    const ok = await send({ method: 'PATCH', url: '/checks/3', body: { name: 'ada' } })
    expect(ok.status).toBe(200)
    expect(ok.json()).toEqual({ id: 3, name: 'ADA' })
    expect(await calls()).toEqual(['sync id', 'async name', 'handler'])

    const first = await send({ method: 'PATCH', url: '/checks/x', body: { name: 'bad' } })
    expect(first.json()).toMatchObject({ message: 'Invalid param "id"' })
    expect(await calls()).toEqual(['sync id'])

    const second = await send({ method: 'PATCH', url: '/checks/3', body: { name: 'bad' } })
    expect(second.json()).toMatchObject({ message: 'Invalid body' })
    expect(await calls()).toEqual(['sync id', 'async name'])
  })

  it('awaits an output that is a promise, as an awaited validation does', async () => {
    const response = await send({ method: 'GET', url: '/checks/deferred?v=x' })
    expect(response.status).toBe(200)
    expect(response.json()).toEqual({ v: 'deferred x' })
    await calls()
  })
})
