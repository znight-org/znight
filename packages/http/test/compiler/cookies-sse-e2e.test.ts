/**
 * End to end for cookies and Server-Sent Events: the `cookies-sse` fixture is compiled with
 * `@znight/compiler`'s `compile()`, the generated module is type-checked with strict options,
 * imported and served by `HttpPlugin` (default adapter); a route reading a signed cookie fails the
 * boot without `cookies.secrets` (ZNIGHT006).
 */
import type { ZnightMetadata } from '@znight/core'
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

type Compile = (options: Record<string, unknown>) => Promise<{
  readonly code: string
  readonly outFile: string
  readonly diagnostics: readonly compiler.Diagnostic[]
}>

const compile = (compiler as unknown as { readonly compile?: Compile }).compile
const SECRET = 'fixture-secret-fixture-secret-0001'

describe.skipIf(typeof compile !== 'function')('compiled cookies and SSE application (e2e)', () => {
  let app: TempApp
  let metadata: ZnightMetadata
  let application: Application
  let http: HttpPlugin
  let code: string
  let outFile: string

  beforeAll(async () => {
    app = fixtureApp('cookies-sse')
    const result = await (compile as Compile)({ root: app.root, conditions: ['@znight/source'], mode: 'test' })
    expect(render({ root: app.root, diagnostics: result.diagnostics })).toEqual([])
    code = result.code
    outFile = result.outFile
    fs.mkdirSync(path.dirname(outFile), { recursive: true })
    fs.writeFileSync(outFile, code)
    metadata = ((await import(pathToFileURL(outFile).href)) as { __ZNIGHT_METADATA__: ZnightMetadata })
      .__ZNIGHT_METADATA__
    http = HttpPlugin.configure({ port: 0, host: '127.0.0.1', cookies: { secrets: SECRET } })
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

  it('generates the cookie arguments and the sse metadata', () => {
    const compact = (text: string): string => text.replace(/\s+/g, '').replace(/,([)\]}])/g, '$1')
    const generated = compact(code)
    expect(generated).toContain(
      compact(`(c: PrefsController, ctx: HttpContext) => {
        const a0 = validate(ThemeCookie, ctx.cookies['theme'], 'cookie "theme"')
        if (isThenable(a0)) return (async () => c.read(await a0, coerce.optional(ctx.cookies['visits'], 'cookie "visits"', coerce.number)))()
        return c.read(a0, coerce.optional(ctx.cookies['visits'], 'cookie "visits"', coerce.number))
      }`),
    )
    expect(generated).toContain(
      compact(
        `(c: PrefsController, ctx: HttpContext) => c.me(coerce.string(ctx.signedCookie('__Host-uid'), 'cookie "__Host-uid"'))`,
      ),
    )
    expect(generated).toContain(compact("['sse']: { ['retry']: 5000, ['maxDuration']: 1800000 }"))
    expect(generated).toContain(compact("['sse']: { ['heartbeat']: 0 }"))
  })

  it('the generated module type-checks with strict compiler options', () => {
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
          lib: ['ES2024', 'ESNext.Disposable', 'ESNext.AsyncIterable', 'DOM', 'DOM.AsyncIterable'],
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
    // the application and the generated module (the sources of @znight/http are checked by the package)
    expect(output.split('\n').filter(line => line.startsWith('src/') || line.startsWith('.znight/'))).toEqual([])
  })

  it('reads, sets and signs cookies', async () => {
    const read = await http.inject({ method: 'GET', url: '/prefs', cookies: { theme: 'dark', visits: '2' } })
    expect(read.json()).toEqual({ theme: 'dark', visits: 2 })
    expect((await http.inject({ method: 'GET', url: '/prefs', cookies: { theme: 'x' } })).json()).toEqual({
      theme: 'light',
      visits: 0,
    })
    const set = await http.inject({ method: 'POST', url: '/prefs/theme', body: { theme: 'dark' } })
    expect(set.status).toBe(204)
    expect(set.cookies['theme']).toMatchObject({ value: 'dark', httpOnly: false, secure: true })
    const login = await http.inject({ method: 'POST', url: '/prefs/login' })
    const uid = login.cookies['__Host-uid']?.value as string
    expect((await http.inject({ method: 'GET', url: '/prefs/me', cookies: { '__Host-uid': uid } })).json()).toEqual({
      uid: 'u-1',
    })
    const tampered = await http.inject({ method: 'GET', url: '/prefs/me', cookies: { '__Host-uid': 'u-1.x' } })
    expect(tampered.status).toBe(400)
  })

  it('serves event streams', async () => {
    await using stream = await http.injectSse({ url: '/orders/o-1/events' })
    expect(stream.retry).toBe(5_000)
    const first = await stream.next()
    expect([first.event, first.id, first.json()]).toEqual(['status', '1', { status: 'created' }])
    const clock = await http.injectSse({ url: '/orders/clock' })
    expect((await clock.take(3)).map(event => event.json())).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
    await clock.done
    expect((await http.injectSse({ url: '/orders/missing/events' })).status).toBe(404)
    expect((await http.injectSse({ url: '/orders/closed/events' })).status).toBe(204)
    const assistant = await http.injectSse({ method: 'POST', url: '/orders/assistant', body: { text: 'a b' } })
    expect(assistant.status).toBe(200)
    expect((await assistant.take(2)).map(event => event.data)).toEqual(['a', 'b'])
  })

  it('fails the boot without cookies.secrets (ZNIGHT006)', async () => {
    const error = await Application.create({
      metadata,
      plugins: [HttpPlugin.configure({ port: 0 })],
      logger: silentLogger,
      shutdown: { signals: false },
    }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'ZNIGHT006' })
    expect(String((error as Error).message)).toContain(
      "PrefsController.me reads a signed cookie (@SignedCookie('__Host-uid')) but cookies.secrets is not set",
    )
  })
})
