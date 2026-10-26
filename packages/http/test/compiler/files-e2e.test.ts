/**
 * End to end for files: the `files` fixture (uploads, downloads, streams, @BodyLimit) is compiled
 * with `@znight/compiler`'s `compile()`, the generated module is type-checked with strict options,
 * imported and served by `HttpPlugin`.
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

type Compile = (options: Record<string, unknown>) => Promise<{
  readonly code: string
  readonly outFile: string
  readonly diagnostics: readonly compiler.Diagnostic[]
}>

const compile = (compiler as unknown as { readonly compile?: Compile }).compile

function form(entries: readonly [string, string | File][]): FormData {
  const data = new FormData()
  for (const [name, value] of entries) data.append(name, value)
  return data
}

describe.skipIf(typeof compile !== 'function')('compiled files application (e2e)', () => {
  let app: TempApp
  let application: Application
  let http: HttpPlugin
  let code: string
  let outFile: string

  beforeAll(async () => {
    app = fixtureApp('files')
    const result = await (compile as Compile)({ root: app.root, conditions: ['@znight/source'], mode: 'test' })
    expect(render({ root: app.root, diagnostics: result.diagnostics })).toEqual([])
    code = result.code
    outFile = result.outFile
    fs.mkdirSync(path.dirname(outFile), { recursive: true })
    fs.writeFileSync(outFile, code)
    const generated = (await import(pathToFileURL(outFile).href)) as { __ZNIGHT_METADATA__: ZnightMetadata }
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

  it('generates the upload rules, body limits and invoke code', () => {
    const compact = (text: string): string => text.replace(/\s+/g, '').replace(/,([)\]}])/g, '$1')
    const generated = compact(code)
    expect(generated).toContain(compact("import { coerce, uploads, validate } from '@znight/http'"))
    expect(generated).toContain(
      compact(
        "async (c: FilesController, ctx: HttpContext) => c.avatar(uploads.file(ctx, 'avatar'), await validate(AvatarMeta, ctx.body, 'body'))",
      ),
    )
    expect(generated).toContain(
      compact(
        "(c: FilesController, ctx: HttpContext) => c.documents(uploads.files(ctx, 'documents'), uploads.optionalFile(ctx, 'cover'))",
      ),
    )
    expect(generated).toContain(
      compact(
        "['uploads']: [{ ['field']: 'avatar', ['required']: true, ['maxSize']: 1024, ['mimeTypes']: ['image/*'] }]",
      ),
    )
    expect(generated).toContain(compact("['bodyLimit']: 65536"))
    expect(generated).toContain(compact("['bodyLimit']: 1048576"))
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

  it('receives uploaded files and validated text fields', async () => {
    const avatar = new File([new Uint8Array(10)], 'me.png', { type: 'image/png' })
    const ok = await send({
      method: 'POST',
      url: '/files/avatar',
      body: form([
        ['title', 'Me'],
        ['avatar', avatar],
      ]),
    })
    expect(ok.status).toBe(201)
    expect(ok.json()).toEqual({ name: 'me.png', type: 'image/png', size: 10, title: 'Me' })

    const big = new File([new Uint8Array(1025)], 'big.png', { type: 'image/png' })
    expect(
      (
        await send({
          method: 'POST',
          url: '/files/avatar',
          body: form([
            ['title', 'x'],
            ['avatar', big],
          ]),
        })
      ).status,
    ).toBe(413)
    const text = new File(['x'], 'x.txt', { type: 'text/plain' })
    expect(
      (
        await send({
          method: 'POST',
          url: '/files/avatar',
          body: form([
            ['title', 'x'],
            ['avatar', text],
          ]),
        })
      ).status,
    ).toBe(415)
    const missing = await send({ method: 'POST', url: '/files/avatar', body: form([['title', 'x']]) })
    expect(missing.status).toBe(400)
    expect(missing.json<{ message: string }>().message).toBe('Missing file "avatar"')
    expect((await send({ method: 'POST', url: '/files/avatar', body: { title: 'x' } })).status).toBe(415)
  })

  it('receives several files and optional files', async () => {
    const res = await send({
      method: 'POST',
      url: '/files/documents',
      body: form([
        ['documents', new File(['one'], '1.txt', { type: 'text/plain' })],
        ['documents', new File(['two'], '2.txt', { type: 'text/markdown' })],
      ]),
    })
    expect(res.json()).toEqual({ documents: ['one', 'two'], cover: null })
    const tooMany = await send({
      method: 'POST',
      url: '/files/documents',
      body: form(['a', 'b', 'c'].map(name => ['documents', new File([name], `${name}.txt`, { type: 'text/plain' })])),
    })
    expect(tooMany.status).toBe(413)
    // the @BodyLimit('64kb') of the route
    const huge = await send({
      method: 'POST',
      url: '/files/documents',
      body: form([['documents', new File([new Uint8Array(70_000)], 'big.txt', { type: 'text/plain' })]]),
    })
    expect(huge.status).toBe(413)
    expect(huge.json<{ message: string }>().message).toBe('Request body exceeds the limit of 65536 bytes')
  })

  it('serves files confined to their directory, with ranges', async () => {
    const report = await send({ method: 'GET', url: '/files/download/report.txt' })
    expect(report.status).toBe(200)
    expect(report.body).toBe('report content\n')
    expect(report.headers['content-type']).toBe('text/plain; charset=utf-8')
    const range = await send({ method: 'GET', url: '/files/download/guides/start.md', headers: { range: 'bytes=2-' } })
    expect(range.status).toBe(206)
    expect(range.body).toBe('guide\n')
    expect((await send({ method: 'GET', url: '/files/download/..%2Fsecret.txt' })).status).toBe(404)
  })

  it('streams responses and request bodies', async () => {
    const csv = await send({ method: 'GET', url: '/files/export.csv' })
    expect(csv.body).toBe('a,b\n1,2\n')
    expect(csv.headers['content-disposition']).toBe('attachment; filename="export.csv"')
    const raw = await send({ method: 'PUT', url: '/files/raw/data.bin', body: new Uint8Array(100_000) })
    expect(raw.json()).toEqual({ name: 'data.bin', size: 100_000 })
  })
})
