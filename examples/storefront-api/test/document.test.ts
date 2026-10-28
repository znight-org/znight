import type { OpenApiObject } from '@znight/openapi'
import type { TestApp } from '@znight/testing'

import { readFileSync } from 'node:fs'
import { buildOpenApiDocument, OpenApi } from '@znight/openapi'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import converters from '../src/openapi.converters.js'
import { createTestApp } from './support/app.js'
import { committedOpenApi, validateOpenApi } from './support/openapi.js'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'] as const

/**
 * The OpenAPI document is a contract: the committed `openapi.json` is what clients are generated
 * from (`src/client/schema.d.ts`), so the served document must be exactly that file, and the file
 * must be a valid OpenAPI 3.1 document.
 */
describe('the OpenAPI document', () => {
  let app: TestApp
  let document: OpenApiObject

  beforeAll(async () => {
    app = await createTestApp()
    document = await app.get(OpenApi).document()
  })

  afterAll(async () => {
    await app.close()
  })

  it('is served byte for byte as committed in openapi.json', async () => {
    const served = await app.inject({ url: '/openapi.json' })

    expect(served.status).toBe(200)
    expect(served.headers['content-type']).toBe('application/json; charset=utf-8')
    // a stale file fails here: run `bun run openapi` and review the diff
    expect(served.body).toBe(committedOpenApi())
  })

  it('is assembled from the generated metadata without warnings', async () => {
    // the same pure function runs at boot, in `znight openapi` and here
    const { json, warnings, stats } = await buildOpenApiDocument(metadata, { converters })

    expect(warnings).toEqual([])
    expect(json).toBe(committedOpenApi())
    expect(stats.operations).toBe(13)
  })

  it('is a valid OpenAPI 3.1 document', async () => {
    const committed = await validateOpenApi(JSON.parse(committedOpenApi()))
    const served = await validateOpenApi(document)

    expect(committed).toMatchObject({ valid: true, version: '3.1' })
    expect(served).toMatchObject({ valid: true, version: '3.1' })
  })

  /** The security schemes an operation documents (`[]`: public), the document default included. */
  const securityOf = (method: (typeof METHODS)[number], path: string): string => {
    const requirements = document.paths?.[path]?.[method]?.security ?? document.security ?? []
    return requirements.length === 0 ? 'public' : requirements.map(entry => Object.keys(entry).join(' + ')).join(' | ')
  }

  /** The access decision `AuthGuard` enforces, from the effective route metadata. */
  const accessOf = (meta: Readonly<Record<string, unknown>>): string => {
    if (meta.public === true) return 'public'
    return Array.isArray(meta.roles) ? `roles ${meta.roles.join(' | ')}` : 'NO DECISION'
  }

  /**
   * The operations as the documentation shows them: id, tags and security, next to the access
   * decision the guard enforces. This is what a reviewer reads when an operation changes (`bun test
   * -u` updates the snapshot once the change is reviewed).
   */
  it('documents every operation with an id, a tag and its security', () => {
    const lines = app
      .get(OpenApi)
      .operations.map(
        view =>
          `${view.method.toUpperCase()} ${view.path} → ${view.operationId} [${view.tags.join(', ')}] security: ${securityOf(view.method, view.path)}, access: ${accessOf(view.meta)}`,
      )

    expect(lines).toMatchSnapshot()
  })

  it('documents the credentials that the guard actually checks', () => {
    // what AuthGuard accepts for each decision: nothing, a customer token, or a back-office key
    const expected: Record<string, string> = {
      public: 'public',
      'roles customer': 'bearer',
      'roles catalog': 'apiKey',
      'roles admin': 'apiKey',
    }

    for (const view of app.get(OpenApi).operations) {
      expect(`${view.operationId}: ${securityOf(view.method, view.path)}`).toBe(
        `${view.operationId}: ${expected[accessOf(view.meta)]}`,
      )
    }
  })

  it('leaves the operational endpoints out (@ApiExclude)', () => {
    expect(Object.keys(document.paths ?? {})).not.toContain('/health')
    expect(Object.keys(document.paths ?? {})).not.toContain('/openapi.json')
  })

  it('references components that exist, discriminator mappings included', () => {
    const schemas = new Set(Object.keys(document.components?.schemas ?? {}))
    const responses = new Set(Object.keys(document.components?.responses ?? {}))
    const dangling: string[] = []
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) for (const item of value) visit(item)
      else if (typeof value === 'object' && value !== null) {
        for (const [key, item] of Object.entries(value)) {
          if (key === '$ref' || (key === 'mapping' && typeof item === 'object')) {
            for (const ref of key === '$ref' ? [item] : Object.values(item as object)) {
              const [, kind, name] = /^#\/components\/(schemas|responses)\/(.+)$/.exec(String(ref)) ?? []
              if (!(kind === 'schemas' ? schemas : responses).has(name ?? '')) dangling.push(String(ref))
            }
          } else visit(item)
        }
      }
    }
    visit(document)

    expect(dangling).toEqual([])
  })

  it('documents the discriminated unions of requests (Valibot) and responses (TypeScript)', () => {
    const schemas = document.components?.schemas ?? {}

    expect(schemas.Payment).toMatchObject({
      oneOf: [{ $ref: '#/components/schemas/CardPayment' }, { $ref: '#/components/schemas/TransferPayment' }],
      discriminator: { propertyName: 'method' },
    })
    expect(schemas.PlaceOrder).toMatchObject({
      properties: {
        payment: {
          oneOf: [
            { $ref: '#/components/schemas/CardPaymentInput' },
            { $ref: '#/components/schemas/TransferPaymentInput' },
          ],
          discriminator: { propertyName: 'method' },
        },
      },
    })
    // one Zod schema, two components: what clients send and what the server answers
    expect(schemas.CreateProductInput).toMatchObject({ properties: { price: { type: 'string' } } })
    expect(schemas.CreateProduct).toMatchObject({ properties: { price: { type: 'integer' } } })
  })

  /**
   * `src/client/schema.d.ts` is generated from `openapi.json` by openapi-typescript (`bun run
   * client:generate`, checked by `bun run client:check`). This repository uses TypeScript 7, whose
   * package has no JavaScript API, so openapi-typescript cannot run here: this test keeps the
   * committed file honest on what matters to callers (every path, operation and schema).
   */
  it('was turned into the client types of src/client/schema.d.ts', () => {
    const types = readFileSync(new URL('../src/client/schema.d.ts', import.meta.url), 'utf8')
    const operations = Object.values(document.paths ?? {}).flatMap(item =>
      METHODS.flatMap(method => item[method]?.operationId ?? []),
    )
    const declaredPaths = [...types.matchAll(/^ {4}"(\/[^"]*)": \{$/gm)].map(match => match[1])

    expect(declaredPaths).toEqual(Object.keys(document.paths ?? {}))
    for (const id of operations) expect(types).toContain(`\n    "${id}": {\n`)
    const declaredSchemas = [...types.matchAll(/^ {8}([\w.-]+): /gm)].map(match => match[1])
    for (const name of Object.keys(document.components?.schemas ?? {})) expect(declaredSchemas).toContain(name)
  })
})
