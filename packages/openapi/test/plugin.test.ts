/**
 * `OpenApiPlugin` (§5.6, §8 of RFC 0002): lifecycle, build modes, serving (ETag, 304, HEAD, YAML,
 * cache-control), route metadata and guards, the `OpenApi` external, options, the UI page.
 */
import type { ZnightMetadata } from '@znight/core'
import type { CanActivate, HttpContext } from '@znight/http'
import type { SchemaConverter } from '../src/index.ts'

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Application, type CoreLogger, silentLogger } from '@znight/core'
import { createRouteDecorator, HttpPlugin } from '@znight/http'
import { TestApp } from '@znight/testing'

import { buildOpenApiDocument, OpenApi, OpenApiPlugin } from '../src/index.ts'
import { bookshelfMetadata, cleanupApps } from './support/apps.ts'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

const Public = createRouteDecorator('public')

let metadata: ZnightMetadata

beforeAll(async () => {
  metadata = await bookshelfMetadata()
})

afterAll(cleanupApps)

function recordingLogger(): CoreLogger & { readonly lines: string[] } {
  const lines: string[] = []
  const log = (level: string) => (message: string) => {
    lines.push(`${level} ${message}`)
  }
  return { lines, debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') } as never
}

const create = (plugin: OpenApiPlugin, http: Record<string, unknown> = {}, logger: CoreLogger = silentLogger) =>
  TestApp.create({ metadata, plugins: [HttpPlugin.configure({ port: 0, ...http }), plugin], logger })

describe('serving', () => {
  it('serves the document with a strong ETag, cache-control, 304 and HEAD', async () => {
    await using app = await create(OpenApiPlugin.configure())
    const response = await app.inject({ method: 'GET', url: '/openapi.json' })
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(response.headers['cache-control']).toBe('no-cache')
    expect(String(response.headers['etag'])).toMatch(/^"[\w-]{27}"$/)
    expect(response.body).toBe((await buildOpenApiDocument(metadata)).json)
    const cached = await app.inject({
      method: 'GET',
      url: '/openapi.json',
      headers: { 'if-none-match': String(response.headers['etag']) },
    })
    expect(cached.status).toBe(304)
    expect(cached.body).toBe('')
    const weak = await app.inject({
      method: 'GET',
      url: '/openapi.json',
      headers: { 'if-none-match': `"x", W/${String(response.headers['etag'])}` },
    })
    expect(weak.status).toBe(304)
    const head = await app.inject({ method: 'HEAD', url: '/openapi.json' })
    expect(head.status).toBe(200)
    expect(head.body).toBe('')
    expect(head.headers['etag']).toBe(response.headers['etag'])
  })

  it('serves YAML, honours the prefix (servers) and custom paths and cache-control', async () => {
    await using app = await create(
      OpenApiPlugin.configure({ path: '/spec.json', yaml: '/spec.yaml', cacheControl: 'public, max-age=60' }),
      { prefix: '/api' },
    )
    const json = await app.inject({ method: 'GET', url: '/api/spec.json' })
    expect(json.json<{ servers: unknown }>().servers).toEqual([{ url: '/api' }])
    expect(json.headers['cache-control']).toBe('public, max-age=60')
    const yaml = await app.inject({ method: 'GET', url: '/api/spec.yaml' })
    expect(yaml.status).toBe(200)
    expect(yaml.headers['content-type']).toBe('application/yaml')
    expect(yaml.body).toStartWith('openapi: 3.1.1\ninfo:\n  title: Bookshelf API\n')
    expect((await app.inject({ method: 'GET', url: '/openapi.json' })).status).toBe(404)
  })

  it('lists the docs routes in HttpPlugin.routes with source "openapi"', async () => {
    await using app = await create(OpenApiPlugin.configure({ ui: 'swagger' }))
    const http = app.app.getPlugin<HttpPlugin>('http')
    expect(
      http?.routes
        .filter(route => route.source === 'openapi')
        .map(route => `${route.method} ${route.path} ${route.handler}`),
    ).toEqual(['HEAD /docs ui', 'HEAD /openapi.json document', 'GET /docs ui', 'GET /openapi.json document'])
  })

  it('serves the UI page with a CSP allowing its inline script by hash', async () => {
    await using app = await create(OpenApiPlugin.configure({ ui: { scalar: { theme: 'purple' } }, assets: 'cdn' }))
    const page = await app.inject({ method: 'GET', url: '/docs' })
    expect(page.status).toBe(200)
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8')
    const csp = String(page.headers['content-security-policy'])
    const inline = /<script>(.*)<\/script>/.exec(page.body)?.[1] ?? ''
    expect(inline).toBe(
      'Scalar.createApiReference(\'#app\', {"url":"/openapi.json","withDefaultFonts":false,"telemetry":false,"theme":"purple"})',
    )
    expect(csp).toContain(`'sha256-${createHash('sha256').update(inline).digest('base64')}'`)
    expect(csp).toContain("script-src 'self' https://cdn.jsdelivr.net")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(page.body).toContain('integrity="sha384-')
    expect(page.body).toContain('<title>Bookshelf API — API reference</title>')
  })

  it('allows the declared servers in the CSP of the UI whatever the build mode', async () => {
    const section = metadata.extensions?.openapi as NonNullable<NonNullable<ZnightMetadata['extensions']>['openapi']>
    const declared: ZnightMetadata = {
      ...metadata,
      extensions: {
        ...metadata.extensions,
        openapi: { ...section, document: { ...section.document, servers: [{ url: 'https://api.example.com/v1' }] } },
      },
    }
    for (const build of ['boot', 'first-request'] as const) {
      await using app = await TestApp.create({
        metadata: declared,
        plugins: [HttpPlugin.configure({ port: 0 }), OpenApiPlugin.configure({ build, assets: 'cdn' })],
        logger: silentLogger,
      })
      const page = await app.inject({ method: 'GET', url: '/docs' })
      expect(String(page.headers['content-security-policy'])).toContain("connect-src 'self' https://api.example.com;")
      expect(page.body).toContain('<title>Bookshelf API — API reference</title>')
    }
  })

  it('does not serve anything with enabled: false, and the OpenApi external still works', async () => {
    await using app = await create(OpenApiPlugin.configure({ enabled: false }))
    expect((await app.inject({ method: 'GET', url: '/openapi.json' })).status).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/docs' })).status).toBe(404)
    const openapi = app.get(OpenApi)
    expect((await openapi.document()).info.title).toBe('Bookshelf API')
    expect(openapi.operations.length).toBeGreaterThan(5)
  })
})

describe('the OpenApi external', () => {
  it('gives the document, the served JSON, YAML and the operation views', async () => {
    await using app = await create(OpenApiPlugin.configure({ ui: false }))
    const openapi = app.get(OpenApi)
    const document = await openapi.document()
    expect(Object.isFrozen(document)).toBe(true)
    expect(await openapi.json()).toBe((await app.inject({ method: 'GET', url: '/openapi.json' })).body)
    expect(await openapi.yaml()).toStartWith('openapi: 3.1.1\n')
    expect(openapi.operations.find(operation => operation.operationId === 'removeBook')).toEqual({
      method: 'delete',
      path: '/books/{id}',
      operationId: 'removeBook',
      tags: ['Books'],
      controller: 'BookController',
      handler: 'remove',
      meta: { roles: ['admin'] },
    })
  })
})

describe('route metadata and guards', () => {
  class ApiKeyGuard implements CanActivate {
    canActivate(ctx: HttpContext): boolean {
      return Public.get(ctx) === true || ctx.header('x-api-key') === 'secret'
    }
  }
  const deny: CanActivate = { canActivate: (_ctx: HttpContext) => false }

  it('runs the global guards, which read the meta of the docs routes', async () => {
    {
      await using app = await create(OpenApiPlugin.configure(), { guards: [new ApiKeyGuard()] })
      expect((await app.inject({ method: 'GET', url: '/openapi.json' })).status).toBe(403)
      expect(
        (await app.inject({ method: 'GET', url: '/openapi.json', headers: { 'x-api-key': 'secret' } })).status,
      ).toBe(200)
    }
    await using app = await create(OpenApiPlugin.configure({ meta: [Public.meta()] }), { guards: [new ApiKeyGuard()] })
    expect((await app.inject({ method: 'GET', url: '/openapi.json' })).status).toBe(200)
  })

  it('runs the guards of the guards option after the global ones', async () => {
    await using app = await create(OpenApiPlugin.configure({ guards: [deny] }))
    expect((await app.inject({ method: 'GET', url: '/openapi.json' })).status).toBe(403)
  })

  it('returns the guard classes from initRoots()', () => {
    const plugin = OpenApiPlugin.configure({ guards: [ApiKeyGuard, deny] })
    expect(plugin.initRoots({ metadata })).toEqual([ApiKeyGuard])
    expect(OpenApiPlugin.configure(() => ({})).initRoots({ metadata })).toEqual([])
  })
})

describe('build modes', () => {
  const failingOnce = (): { converter: SchemaConverter; calls: () => number } => {
    let calls = 0
    return {
      calls: () => calls,
      converter: {
        name: 'flaky',
        convert: () => {
          calls++
          if (calls === 1) throw new Error('not yet')
          return undefined
        },
      },
    }
  }

  it("'boot' fails Application.create with ZNIGHT037", async () => {
    const { converter } = failingOnce()
    await expect(create(OpenApiPlugin.configure({ converters: [converter] }))).rejects.toMatchObject({
      code: 'ZNIGHT037',
    })
  })

  it("'first-request' builds once for concurrent requests, answers 500 on failure and retries", async () => {
    const flaky = failingOnce()
    await using app = await create(OpenApiPlugin.configure({ build: 'first-request', converters: [flaky.converter] }))
    expect(flaky.calls()).toBe(0)
    expect((await app.inject({ method: 'GET', url: '/openapi.json' })).status).toBe(500)
    const responses = await Promise.all([1, 2, 3].map(() => app.inject({ method: 'GET', url: '/openapi.json' })))
    expect(responses.map(response => response.status)).toEqual([200, 200, 200])
    const after = flaky.calls()
    await app.inject({ method: 'GET', url: '/openapi.json' })
    expect(flaky.calls()).toBe(after)
  })

  it('{ file } serves a prebuilt document and warns when it is stale', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'znight-openapi-file-'))
    try {
      const built = await buildOpenApiDocument(metadata)
      const fresh = path.join(directory, 'openapi.json')
      fs.writeFileSync(fresh, built.json)
      const logger = recordingLogger()
      {
        await using app = await create(OpenApiPlugin.configure({ document: { file: fresh } }), {}, logger)
        expect((await app.inject({ method: 'GET', url: '/openapi.json' })).body).toBe(built.json)
      }
      expect(logger.lines.filter(line => line.includes('stale'))).toEqual([])
      const stale = path.join(directory, 'stale.json')
      fs.writeFileSync(stale, built.json.replace(String(built.document['x-znight-fingerprint']), 'old'))
      await using app = await create(
        OpenApiPlugin.configure({ document: { file: new URL(`file://${stale}`) } }),
        {},
        logger,
      )
      expect((await app.inject({ method: 'GET', url: '/openapi.json' })).status).toBe(200)
      expect(logger.lines.filter(line => line.includes('stale'))).toHaveLength(1)
      const invalid = path.join(directory, 'v3.json')
      fs.writeFileSync(invalid, '{"openapi":"3.0.3"}')
      await expect(create(OpenApiPlugin.configure({ document: { file: invalid } }))).rejects.toMatchObject({
        code: 'ZNIGHT030',
      })
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('a prebuilt document file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'znight-openapi-file-'))
  afterAll(() => fs.rmSync(directory, { recursive: true, force: true }))

  it('applies filter, info, servers and transform as a build does', async () => {
    const file = path.join(directory, 'openapi.json')
    fs.writeFileSync(file, (await buildOpenApiDocument(metadata)).json)
    const runtime = {
      filter: (operation: { path: string }) => !operation.path.startsWith('/orders'),
      info: { title: 'Public API' },
      servers: [{ url: 'https://public.example.com' }],
      transform: (document: object) => ({ ...document, 'x-transformed': true }) as never,
    }
    await using app = await create(OpenApiPlugin.configure({ document: { file }, ...runtime }))
    const served = await app.inject({ method: 'GET', url: '/openapi.json' })
    expect(served.body).toBe((await buildOpenApiDocument(metadata, runtime)).json)
    const document = served.json<{ paths: Record<string, unknown>; info: { title: string } }>()
    expect(Object.keys(document.paths).some(key => key.startsWith('/orders'))).toBe(false)
    expect(document.info.title).toBe('Public API')
  })

  it('applies the prefix rule to a file emitted without servers, with a ZNIGHT030 warning', async () => {
    const file = path.join(directory, 'unprefixed.json')
    fs.writeFileSync(file, (await buildOpenApiDocument(metadata)).json)
    const logger = recordingLogger()
    await using app = await create(OpenApiPlugin.configure({ document: { file } }), { prefix: '/api' }, logger)
    const served = await app.inject({ method: 'GET', url: '/api/openapi.json' })
    expect(served.body).toBe((await buildOpenApiDocument(metadata, { prefix: '/api' })).json)
    expect(served.json<{ servers: unknown }>().servers).toEqual([{ url: '/api' }])
    expect(logger.lines.filter(line => line.startsWith('warn ZNIGHT030'))).toEqual([
      `warn ZNIGHT030: ${file} declares no servers, but the HTTP prefix is "/api": it is served with the server "/api", and clients generated from the file would call the wrong paths`,
    ])
    // emitted with the prefix: served as is, no warning
    const prefixed = path.join(directory, 'prefixed.json')
    const built = await buildOpenApiDocument(metadata, { prefix: '/api' })
    fs.writeFileSync(prefixed, built.json)
    const quiet = recordingLogger()
    await using again = await create(
      OpenApiPlugin.configure({ document: { file: prefixed } }),
      { prefix: '/api' },
      quiet,
    )
    expect((await again.inject({ method: 'GET', url: '/api/openapi.json' })).body).toBe(built.json)
    expect(quiet.lines.filter(line => line.startsWith('warn'))).toEqual([])
  })
})

describe('lifecycle and options', () => {
  it('evaluates options given as a function of the container once', async () => {
    let calls = 0
    await using app = await create(
      OpenApiPlugin.configure(container => {
        calls++
        expect(container).toBeDefined()
        return { path: '/fn.json' }
      }),
    )
    expect((await app.inject({ method: 'GET', url: '/fn.json' })).status).toBe(200)
    expect(calls).toBe(1)
  })

  it('serves another application after dispose, and refuses two at once', async () => {
    const plugin = OpenApiPlugin.configure()
    {
      await using app = await create(plugin)
      expect((await app.inject({ method: 'GET', url: '/openapi.json' })).status).toBe(200)
      await expect(create(plugin)).rejects.toMatchObject({ code: 'ZNIGHT004' })
    }
    await using again = await create(plugin)
    expect((await again.inject({ method: 'GET', url: '/openapi.json' })).status).toBe(200)
  })

  it('requires HttpPlugin and the OpenAPI section (ZNIGHT030)', async () => {
    await expect(
      Application.create({
        metadata,
        plugins: [OpenApiPlugin.configure()],
        logger: silentLogger,
        shutdown: { signals: false },
      }),
    ).rejects.toMatchObject({ code: 'ZNIGHT030' })
    const { openapi: _openapi, ...extensions } = metadata.extensions ?? {}
    await expect(
      TestApp.create({
        metadata: { ...metadata, extensions },
        plugins: [HttpPlugin.configure({ port: 0 }), OpenApiPlugin.configure()],
        logger: silentLogger,
      }),
    ).rejects.toMatchObject({ code: 'ZNIGHT030' })
  })

  it('rejects invalid options (ZNIGHT030) and docs paths colliding with routes (ZNIGHT007)', async () => {
    await expect(create(OpenApiPlugin.configure({ path: 'openapi.json' }))).rejects.toMatchObject({ code: 'ZNIGHT030' })
    await expect(create(OpenApiPlugin.configure({ ui: 'redoc' as never }))).rejects.toMatchObject({ code: 'ZNIGHT030' })
    await expect(create(OpenApiPlugin.configure({ yaml: '/docs' }))).rejects.toMatchObject({ code: 'ZNIGHT030' })
    await expect(create(OpenApiPlugin.configure({ unknown: 1 } as never))).rejects.toMatchObject({ code: 'ZNIGHT030' })
    await expect(create(OpenApiPlugin.configure({ path: '/books/report' }))).rejects.toMatchObject({
      code: 'ZNIGHT007',
    })
  })

  it('warns when a declared relative server does not reflect the prefix', async () => {
    const logger = recordingLogger()
    await using app = await create(OpenApiPlugin.configure({ servers: [{ url: '/v1' }] }), { prefix: '/api' }, logger)
    expect(app).toBeDefined()
    expect(logger.lines.filter(line => line.startsWith('warn ZNIGHT030'))).toHaveLength(1)
  })
})

describe('local UI assets', () => {
  it("serves the installed package under ${uiPath}/_assets/ with immutable caching ('auto')", async () => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'znight-openapi-ui-')))
    const cwd = process.cwd()
    try {
      const pkg = path.join(directory, 'node_modules/swagger-ui-dist')
      fs.mkdirSync(pkg, { recursive: true })
      fs.writeFileSync(path.join(directory, 'package.json'), '{"name":"app"}')
      fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"swagger-ui-dist","version":"5.0.1"}')
      fs.writeFileSync(path.join(pkg, 'swagger-ui.css'), '.swagger-ui{}')
      fs.writeFileSync(path.join(pkg, 'swagger-ui-bundle.js'), 'window.SwaggerUIBundle = () => {}')
      process.chdir(directory)
      await using app = await create(OpenApiPlugin.configure({ ui: 'swagger' }), { prefix: '/api' })
      const page = await app.inject({ method: 'GET', url: '/api/docs' })
      expect(page.body).toContain('<link rel="stylesheet" href="/api/docs/_assets/swagger@5.0.1/swagger-ui.css">')
      expect(page.body).toContain('<script src="/api/docs/_assets/swagger@5.0.1/swagger-ui-bundle.js"></script>')
      expect(page.body).toContain(
        'window.ui = SwaggerUIBundle({"url":"/api/openapi.json","dom_id":"#swagger-ui","validatorUrl":null})',
      )
      expect(String(page.headers['content-security-policy'])).not.toContain('cdn.jsdelivr.net')
      const asset = await app.inject({ method: 'GET', url: '/api/docs/_assets/swagger@5.0.1/swagger-ui-bundle.js' })
      expect(asset.status).toBe(200)
      expect(asset.body).toBe('window.SwaggerUIBundle = () => {}')
      expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable')
      expect(String(asset.headers['content-type'])).toStartWith('text/javascript')
      expect((await app.inject({ method: 'GET', url: '/api/docs/_assets/swagger@5.0.1/package.json' })).status).toBe(
        404,
      )
      expect((await app.inject({ method: 'GET', url: '/api/docs/_assets/swagger@4.0.0/swagger-ui.css' })).status).toBe(
        404,
      )
    } finally {
      process.chdir(cwd)
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("fails with assets: 'local' when the package is not installed", async () => {
    await expect(create(OpenApiPlugin.configure({ assets: 'local' }))).rejects.toMatchObject({ code: 'ZNIGHT030' })
  })
})
