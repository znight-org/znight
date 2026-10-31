/**
 * End to end: the fixture application is compiled with `@znight/compiler`'s `compile()` (when the
 * compiler exports it), the generated module is imported and served by `HttpPlugin` (port 0), and
 * real HTTP behaviour is asserted through `inject()` and over the network.
 */
import type { ZnightMetadata } from '@znight/core'
import type { InjectRequest, InjectResponse } from '../../src/index.ts'
import type { TempApp } from './helpers.ts'

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as compiler from '@znight/compiler'
import { Application, silentLogger } from '@znight/core'

import { HttpPlugin } from '../../src/index.ts'
import { cleanupApps, fixtureApp, render, TSC } from './helpers.ts'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

/** Shape of `compile()` used here (the compiler may not export it yet). */
type Compile = (options: Record<string, unknown>) => Promise<{
  readonly code: string
  readonly outFile: string
  readonly diagnostics: readonly compiler.Diagnostic[]
}>

const compile = (compiler as unknown as { readonly compile?: Compile }).compile

describe.skipIf(typeof compile !== 'function')('compiled application (e2e)', () => {
  let app: TempApp
  let application: Application
  let http: HttpPlugin
  let code: string
  let outFile: string

  beforeAll(async () => {
    app = fixtureApp('app')
    const result = await (compile as Compile)({ root: app.root, conditions: ['@znight/source'], mode: 'test' })
    const errors = result.diagnostics.filter(diagnostic => diagnostic.severity === 'error')
    expect(render({ root: app.root, diagnostics: errors })).toEqual([])
    code = result.code
    outFile = result.outFile
    fs.mkdirSync(path.dirname(result.outFile), { recursive: true })
    fs.writeFileSync(result.outFile, result.code)
    const generated = (await import(pathToFileURL(result.outFile).href)) as { __ZNIGHT_METADATA__: ZnightMetadata }
    http = HttpPlugin.configure({ port: 0, host: '127.0.0.1' })
    application = await Application.create({
      metadata: generated.__ZNIGHT_METADATA__,
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

  it('the generated module contains the http section', () => {
    // compared without whitespace and trailing commas (independent of the printer's line breaks)
    const compact = (text: string): string => text.replace(/\s+/g, '').replace(/,([)\]}])/g, '$1')
    const generated = compact(code)
    expect(generated).toContain(compact("import { coerce, isThenable, validate } from '@znight/http'"))
    expect(generated).toContain(
      compact(`(c: UserController, ctx: HttpContext) => {
        const a0 = validate(CreateUser, ctx.body, 'body')
        if (isThenable(a0)) return (async () => c.create(await a0))()
        return c.create(a0)
      }`),
    )
    expect(generated).toContain(compact("import type { HttpContext } from '@znight/http'"))
    expect(generated).toContain(
      compact(`(c: UserController, ctx: HttpContext) => c.find(coerce.number(ctx.params['id'], 'param "id"'))`),
    )
    expect(generated).toContain(compact('(c: RootController) => c.index()'))
    expect(generated).toContain(
      compact(
        "async (c: UserController, ctx: HttpContext) => { await validate(Ping, await ctx.parseBody(), 'body'); return c.ping() }",
      ),
    )
  })

  it('the generated module type-checks with strict compiler options', () => {
    // fixture sources are excluded from the repository type-check (`// @ts-nocheck`): check them here
    for (const file of fs.readdirSync(path.join(app.root, 'src'), { recursive: true, encoding: 'utf8' })) {
      const absolute = path.join(app.root, 'src', file)
      if (file.endsWith('.ts') && fs.statSync(absolute).isFile()) {
        fs.writeFileSync(absolute, fs.readFileSync(absolute, 'utf8').replace(/^\/\/ @ts-nocheck.*\n/, ''))
      }
    }
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
    expect(output).toContain(outFile) // the generated module was checked
    // errors of the application (generated module included); workspace package sources are not checked here
    expect(output.split('\n').filter(line => line.startsWith('src/'))).toEqual([])
  })

  it('registers every route', () => {
    expect(http.routes.map(route => `${route.method} ${route.path}`)).toContain('GET /users/:id')
  })

  it('coerces route parameters and query values from the declared types', async () => {
    const found = await send({ method: 'GET', url: '/users/1', headers: { authorization: 'Bearer reader' } })
    expect(found.status).toBe(200)
    expect(found.json()).toEqual({ id: 1, name: 'Ada', email: 'ada@example.com' })
    expect(found.headers['x-intercepted']).toBe('timing') // route interceptor

    const invalid = await send({ method: 'GET', url: '/users/abc', headers: { authorization: 'Bearer reader' } })
    expect(invalid.status).toBe(400)
    expect(invalid.json()).toMatchObject({ message: 'Invalid param "id": expected a number, received "abc"' })

    const list = await send({ method: 'GET', url: '/users?page=2&tag=a&tag=b&sort=desc' })
    expect(list.json()).toEqual({ page: 2, tags: ['a', 'b'], sort: 'desc', count: 1 })
    const defaults = await send({ method: 'GET', url: '/users' })
    expect(defaults.json()).toEqual({ page: 1, tags: [], sort: null, count: 1 })
    const badSort = await send({ method: 'GET', url: '/users?sort=up' })
    expect(badSort.status).toBe(400)
    expect(badSort.json()).toMatchObject({
      message: 'Invalid query "sort": expected one of "asc", "desc", received "up"',
    })
  })

  it('coerces dates, booleans, bigints, branded strings, enums and arrays', async () => {
    const response = await send({
      method: 'GET',
      url: '/users/typed/2024-01-02?flag=true&big=9007199254740993&ids=a&ids=b&color=blue',
      headers: { 'x-id': 'user-1' },
    })
    expect(response.status).toBe(200)
    expect(response.json()).toEqual({
      day: '2024-01-02T00:00:00.000Z',
      flag: true,
      big: '9007199254740993',
      ids: ['a', 'b'],
      color: 'blue',
      xid: 'user-1',
    })
    const empty = await send({ method: 'GET', url: '/users/typed/0' })
    expect(empty.json()).toEqual({
      day: '1970-01-01T00:00:00.000Z',
      flag: null,
      big: null,
      ids: [],
      color: null,
      xid: null,
    })
    const badColor = await send({ method: 'GET', url: '/users/typed/0?color=green' })
    expect(badColor.status).toBe(400)
  })

  it('validates bodies, params and queries with Standard Schemas (Zod and Valibot)', async () => {
    const created = await send({
      method: 'POST',
      url: '/users',
      headers: { authorization: 'Bearer admin' },
      body: { name: 'Grace', email: 'grace@example.com' },
    })
    expect(created.status).toBe(201)
    expect(created.json()).toEqual({ id: 2, name: 'Grace', email: 'grace@example.com' })

    const invalid = await send({
      method: 'POST',
      url: '/users',
      headers: { authorization: 'Bearer admin' },
      body: { name: '' },
    })
    expect(invalid.status).toBe(400)
    expect(invalid.json()).toMatchObject({ message: 'Invalid body' })

    const search = await send({ method: 'GET', url: '/users/search?q=ada' })
    expect(search.json()).toEqual({ q: 'ada', limit: 10 })

    // @Validate(UpdateUser) + @Body() and @Param('id', IdParam)
    const updated = await send({
      method: 'PUT',
      url: '/users/7',
      headers: { authorization: 'Bearer admin' },
      body: { name: 'Lin', extra: true },
    })
    expect(updated.status).toBe(200)
    expect(updated.json()).toEqual({ id: 7, name: 'Lin' })
    const badId = await send({
      method: 'PUT',
      url: '/users/0',
      headers: { authorization: 'Bearer admin' },
      body: { name: 'Lin' },
    })
    expect(badId.status).toBe(400)
    expect(badId.json()).toMatchObject({ message: 'Invalid param "id"' })

    // @Validate(Ping) without @Body(): validated and discarded
    expect((await send({ method: 'POST', url: '/users/ping', body: { ping: true } })).body).toBe('pong')
    expect((await send({ method: 'POST', url: '/users/ping', body: { ping: false } })).status).toBe(400)
  })

  it('applies guards and route metadata (createRouteDecorator)', async () => {
    expect((await send({ method: 'GET', url: '/users/1' })).status).toBe(401)
    // controller @Roles(['admin']) is overridden by the route @Roles(['admin', 'reader'])
    expect((await send({ method: 'GET', url: '/users/1', headers: { authorization: 'Bearer guest' } })).status).toBe(
      403,
    )
    // @Public() routes skip the guard
    expect((await send({ method: 'GET', url: '/users/legacy/a/b' })).json()).toEqual({ method: 'GET', rest: 'a/b' })
    expect((await send({ method: 'DELETE', url: '/users/legacy/x' })).json()).toEqual({ method: 'DELETE', rest: 'x' })
  })

  it('applies @HttpCode, @Header, @Head, @Options and headers', async () => {
    const removed = await send({ method: 'DELETE', url: '/users/2', headers: { authorization: 'Bearer admin' } })
    expect(removed.status).toBe(202)
    expect(removed.headers['x-deleted']).toBe('yes')

    const flags = await send({
      method: 'PATCH',
      url: '/users/5/flags',
      headers: { authorization: 'Bearer admin', 'x-flag': '1', 'user-agent': 'tests' },
    })
    expect(flags.json()).toEqual({ params: { id: '5' }, flag: true, agent: 'tests' })

    expect((await send({ method: 'HEAD', url: '/users/1', headers: { authorization: 'Bearer admin' } })).status).toBe(
      204,
    )
    expect((await send({ method: 'HEAD', url: '/users/9', headers: { authorization: 'Bearer admin' } })).status).toBe(
      404,
    )
    const options = await send({ method: 'OPTIONS', url: '/users' })
    expect(options.headers.allow).toBe('GET, POST')
  })

  it('request-scoped controllers, raw request and response', async () => {
    const health = await send({ method: 'GET', url: '/health', headers: { 'x-request-id': 'req-1' } })
    expect(health.json()).toEqual({ status: 'ok', path: '/health', requestId: 'req-1' })
    expect((await send({ method: 'GET', url: '/' })).body).toBe('hello')
    const raw = await send({ method: 'GET', url: '/raw' })
    expect(raw.body).toBe('raw GET')
  })

  it('serves over the network', async () => {
    const response = await fetch(`${String(http.address)}/users/1`, { headers: { authorization: 'Bearer admin' } })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: 1 })
  })
})
