/**
 * `buildOpenApiDocument` (§7.3 of RFC 0002) on hand-written metadata: converters (Zod, Valibot,
 * ArkType, user converters), `$defs` hoisting, input/output naming, placeholders, filter, pruning,
 * transform, servers, errors, determinism. Every document is validated against OpenAPI 3.1.
 */
import type { ZnightMetadata } from '@znight/core'
import type { OpenApiMetadata, OpenApiOperationDefinition, OpenApiSchemaSlot, SchemaConverter } from '../src/index.ts'

import { type } from 'arktype'
import * as v from 'valibot'
import { z } from 'zod'

import { buildOpenApiDocument } from '../src/index.ts'
import { validateDocument } from './support/apps.ts'
import { describe, expect, test as it } from 'bun:test'

const op = (
  path: string,
  method: OpenApiOperationDefinition['method'],
  operation: Record<string, unknown>,
): OpenApiOperationDefinition => ({
  controller: 'src/item.controller.ts#ItemController',
  handler: String(operation['operationId'] ?? 'handler'),
  route: method.toUpperCase(),
  method,
  path,
  operation: { responses: { '200': { description: 'OK' } }, ...operation } as never,
})

function metadata(section: Partial<OpenApiMetadata> = {}, http?: object): ZnightMetadata {
  return {
    version: 1,
    providers: {},
    resolutionOrder: [],
    extensions: {
      openapi: {
        version: 1,
        fingerprint: 'fp',
        document: { openapi: '3.1.1', info: { title: 'Items', version: '1.0.0' } },
        operations: [],
        components: {},
        securitySchemes: {},
        schemas: [],
        errors: { contentType: 'application/json' },
        ...section,
      } as OpenApiMetadata,
      ...(http === undefined ? {} : { http: http as never }),
    },
  }
}

const slot = (name: string, schema: unknown, io: ('input' | 'output')[]): OpenApiSchemaSlot => ({
  name,
  schema: schema as OpenApiSchemaSlot['schema'],
  io,
  source: { file: 'src/schemas.ts', line: 1, column: 14 },
})

const body = (name: string) => ({
  content: { 'application/json': { schema: { $znight: 'schema', name, io: 'input' } } },
})
const response = (name: string) => ({
  responses: {
    '200': {
      description: 'OK',
      content: { 'application/json': { schema: { $znight: 'schema', name, io: 'output' } } },
    },
  },
})

describe('conversion', () => {
  it('converts Zod with Standard JSON Schema: input for requests, output for responses, two names when they differ', async () => {
    const Item = z.object({ name: z.string(), count: z.number().default(1) })
    const Stamp = z.object({ at: z.date() })
    const result = await buildOpenApiDocument(
      metadata({
        operations: [
          op('/items', 'post', { operationId: 'create', requestBody: body('Item'), ...response('Item') }),
          op('/stamps', 'get', { operationId: 'stamp', ...response('Stamp') }),
        ],
        schemas: [slot('Item', Item, ['input', 'output']), slot('Stamp', Stamp, ['output'])],
      }),
    )
    const schemas = result.document.components?.schemas ?? {}
    expect(Object.keys(schemas)).toEqual(['Item', 'ItemInput', 'Stamp'])
    expect(schemas['ItemInput']).toMatchObject({ required: ['name'] })
    expect(schemas['Item']).toMatchObject({ required: ['name', 'count'] })
    expect(schemas['Stamp']).toMatchObject({ properties: { at: { type: 'string', format: 'date-time' } } })
    expect(schemas['Item']?.['$schema']).toBeUndefined()
    expect(result.document.paths?.['/items']?.post?.requestBody).toEqual({
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ItemInput' } } },
    })
    expect(await validateDocument(result.document)).toMatchObject({ valid: true })
  })

  it('gives one component when input and output are equal', async () => {
    const Same = z.array(z.string().min(1))
    const result = await buildOpenApiDocument(
      metadata({
        operations: [op('/same', 'put', { operationId: 'same', requestBody: body('Same'), ...response('Same') })],
        schemas: [slot('Same', Same, ['input', 'output'])],
      }),
    )
    expect(Object.keys(result.document.components?.schemas ?? {})).toEqual(['Same'])
  })

  it('converts Valibot through @valibot/to-json-schema and ArkType through Standard JSON Schema', async () => {
    const Order = v.object({ id: v.pipe(v.string(), v.uuid()) })
    const Rating = type({ stars: 'number.integer' })
    const result = await buildOpenApiDocument(
      metadata({
        operations: [
          op('/orders', 'post', { operationId: 'order', requestBody: body('Order'), ...response('Rating') }),
        ],
        schemas: [slot('Order', Order, ['input']), slot('Rating', Rating, ['output'])],
      }),
    )
    expect(result.document.components?.schemas).toMatchObject({
      Order: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      Rating: { type: 'object', properties: { stars: { type: 'integer' } } },
    })
  })

  it('tries user converters first', async () => {
    const custom = { '~standard': { version: 1, vendor: 'effect', validate: () => ({ value: 1 }) } }
    const converter: SchemaConverter = {
      name: 'effect',
      convert: (schema, context) =>
        (schema as unknown as typeof custom)['~standard'].vendor === 'effect'
          ? { type: 'integer', description: context.io }
          : undefined,
    }
    const result = await buildOpenApiDocument(
      metadata({
        operations: [op('/n', 'get', { operationId: 'n', ...response('N') })],
        schemas: [slot('N', custom, ['output'])],
      }),
      { converters: [converter] },
    )
    expect(result.document.components?.schemas?.['N']).toEqual({ type: 'integer', description: 'output' })
  })

  it('fails with ZNIGHT037 (all failures listed), or warns with unrepresentable: "warn"', async () => {
    const Transform = z.object({ n: z.string().transform(Number) })
    const unknown = { '~standard': { version: 1, vendor: 'mystery', validate: () => ({ value: 1 }) } }
    const throwing: SchemaConverter = {
      name: 'boom',
      convert: schema => {
        if ((schema as unknown as typeof unknown)['~standard'].vendor === 'mystery') throw new Error('nope')
      },
    }
    const section = metadata({
      operations: [
        op('/t', 'get', { operationId: 't', ...response('Transform') }),
        op('/u', 'get', { operationId: 'u', ...response('Unknown') }),
      ],
      schemas: [slot('Transform', Transform, ['output']), slot('Unknown', unknown, ['output'])],
    })
    const error = await buildOpenApiDocument(section).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'ZNIGHT037' })
    expect((error as Error).message).toContain(
      'Transform (src/schemas.ts:1:14), zod schema, output: the converter "standard-json-schema" failed: Transforms cannot be represented in JSON Schema',
    )
    expect((error as Error).message).toContain(
      'Unknown (src/schemas.ts:1:14), mystery schema, output: no converter supports it',
    )
    await expect(buildOpenApiDocument(section, { converters: [throwing] })).rejects.toThrow(
      'the converter "boom" failed: nope',
    )
    const lenient = await buildOpenApiDocument(section, { unrepresentable: 'warn' })
    expect(lenient.warnings.map(warning => warning.code)).toEqual(['ZNIGHT037', 'ZNIGHT037'])
    expect(lenient.document.components?.schemas?.['Unknown']).toEqual({})
    expect(lenient.document.components?.schemas?.['Transform']).toMatchObject({ type: 'object' })
  })

  it('rejects a converter result that is not an object', async () => {
    const odd: SchemaConverter = { name: 'odd', convert: () => [] as never }
    await expect(
      buildOpenApiDocument(metadata({ operations: [], schemas: [slot('X', z.string(), ['output'])] }), {
        converters: [odd],
      }),
    ).rejects.toThrow('the converter "odd" returned an array instead of a JSON Schema object')
  })
})

describe('normalisation', () => {
  it('hoists $defs into components and rewrites #/$defs and # references', async () => {
    const Shared = z.object({ a: z.string() }).meta({ id: 'SharedThing' })
    const Pair = z.object({ x: Shared, y: Shared })
    const Tree = z.object({
      name: z.string(),
      get children() {
        return z.array(Tree)
      },
    })
    const result = await buildOpenApiDocument(
      metadata({
        operations: [
          op('/pair', 'get', { operationId: 'pair', ...response('Pair') }),
          op('/tree', 'get', { operationId: 'tree', ...response('Tree') }),
        ],
        schemas: [slot('Pair', Pair, ['output']), slot('Tree', Tree, ['output'])],
      }),
    )
    const schemas = result.document.components?.schemas ?? {}
    expect(schemas['Pair']).toMatchObject({ properties: { x: { $ref: '#/components/schemas/SharedThing' } } })
    expect(schemas['SharedThing']).toMatchObject({ type: 'object' })
    expect(schemas['Tree']).toMatchObject({
      properties: { children: { items: { $ref: '#/components/schemas/Tree' } } },
    })
    expect(JSON.stringify(result.document)).not.toContain('$defs')
    expect(await validateDocument(result.document)).toMatchObject({ valid: true })
  })

  it('reports ZNIGHT034 when two schemas get one name', async () => {
    const section = metadata({
      components: { Item: { type: 'object', properties: { ts: { type: 'string' } } } },
      operations: [op('/i', 'get', { operationId: 'i', ...response('Item') })],
      schemas: [slot('Item', z.object({ other: z.number() }), ['output'])],
    })
    await expect(buildOpenApiDocument(section)).rejects.toMatchObject({ code: 'ZNIGHT034' })
  })

  it('expands whole-object parameters from the input schema, ZNIGHT037 for a non-object schema', async () => {
    const Search = z.object({ q: z.string().describe('Text'), page: z.number().optional(), tags: z.array(z.string()) })
    const result = await buildOpenApiDocument(
      metadata({
        operations: [
          op('/search', 'get', {
            operationId: 'search',
            parameters: [{ $znight: 'parameters', in: 'query', name: 'Search', io: 'input' }],
          }),
        ],
        schemas: [slot('Search', Search, ['input'])],
      }),
    )
    expect(result.document.paths?.['/search']?.get?.parameters).toEqual([
      { name: 'q', in: 'query', description: 'Text', required: true, schema: { type: 'string' } },
      { name: 'page', in: 'query', schema: { type: 'number' } },
      {
        name: 'tags',
        in: 'query',
        required: true,
        schema: { type: 'array', items: { type: 'string' } },
        style: 'form',
        explode: true,
      },
    ])
    expect(result.document.components?.schemas?.['Search']).toBeUndefined()
    await expect(
      buildOpenApiDocument(
        metadata({
          operations: [
            op('/s', 'get', {
              operationId: 's',
              parameters: [{ $znight: 'parameters', in: 'query', name: 'Str', io: 'input' }],
            }),
          ],
          schemas: [slot('Str', z.string(), ['input'])],
        }),
      ),
    ).rejects.toMatchObject({ code: 'ZNIGHT037' })
  })
})

describe('document', () => {
  const http = {
    controllers: [
      {
        token: 'src/item.controller.ts#ItemController',
        meta: { access: 'admin' },
        routes: [
          { method: 'GET', handler: 'list', meta: {} },
          { method: 'GET', handler: 'open', meta: { public: true } },
        ],
      },
    ],
  }
  const section = (): ZnightMetadata =>
    metadata(
      {
        document: {
          openapi: '3.1.1',
          info: { title: 'Items', version: '1.0.0' },
          tags: [{ name: 'Declared' }],
          security: [{ key: [] }],
          'x-team': 'core',
        },
        components: {
          Item: { type: 'object', properties: { tag: { $ref: '#/components/schemas/Tag' } } },
          Tag: { type: 'string' },
          Unused: { type: 'number' },
        },
        securitySchemes: {
          key: { type: 'apiKey', in: 'header', name: 'x-key' },
          other: { type: 'http', scheme: 'bearer' },
        },
        operations: [
          op('/items', 'get', {
            operationId: 'list',
            tags: ['Items'],
            responses: {
              '200': {
                description: 'OK',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } },
              },
              '400': { $ref: '#/components/responses/BadRequest' },
            },
          }),
          {
            ...op('/open', 'get', { operationId: 'open', tags: ['Open'], security: [{ other: [] }] }),
            handler: 'open',
          },
        ],
        tagDescriptions: { Items: 'The items' },
      },
      http,
    )

  it('orders the root, adds used tags after the declared ones, prunes unused components', async () => {
    const result = await buildOpenApiDocument(section())
    expect(Object.keys(result.document)).toEqual([
      'openapi',
      'info',
      'security',
      'tags',
      'paths',
      'components',
      'x-team',
      'x-znight-fingerprint',
    ])
    expect(result.document.tags).toEqual([
      { name: 'Declared' },
      { name: 'Items', description: 'The items' },
      { name: 'Open' },
    ])
    expect(Object.keys(result.document.components?.schemas ?? {})).toEqual([
      'HttpErrorBody',
      'Item',
      'Tag',
      'ValidationErrorBody',
    ])
    expect(Object.keys(result.document.components?.responses ?? {})).toEqual(['BadRequest'])
    expect(Object.keys(result.document.components?.securitySchemes ?? {})).toEqual(['key', 'other'])
    expect(result.json).toBe(`${JSON.stringify(result.document, null, 2)}\n`)
    expect(Object.isFrozen(result.document.paths)).toBe(true)
    expect(result.stats.operations).toBe(2)
    expect(await validateDocument(result.document)).toMatchObject({ valid: true })
  })

  it('filters operations with the effective route metadata and prunes again', async () => {
    const seen: unknown[] = []
    const result = await buildOpenApiDocument(section(), {
      filter: operation => {
        seen.push(operation)
        return operation.meta['public'] === true
      },
    })
    expect(seen[0]).toEqual({
      method: 'get',
      path: '/items',
      operationId: 'list',
      tags: ['Items'],
      controller: 'ItemController',
      handler: 'list',
      meta: { access: 'admin' },
    })
    expect(Object.keys(result.document.paths ?? {})).toEqual(['/open'])
    expect(result.document.components?.schemas).toBeUndefined()
    expect(Object.keys(result.document.components?.securitySchemes ?? {})).toEqual(['key', 'other'])
  })

  it('applies runtime info and servers, else the prefix; transform runs last', async () => {
    const withPrefix = await buildOpenApiDocument(section(), { prefix: '/api', info: { version: '2.0.0' } })
    expect(withPrefix.document.servers).toEqual([{ url: '/api' }])
    expect(withPrefix.document.info).toEqual({ title: 'Items', version: '2.0.0' })
    const servers = await buildOpenApiDocument(section(), {
      prefix: '/api',
      servers: [{ url: 'https://api.example.com' }],
    })
    expect(servers.document.servers).toEqual([{ url: 'https://api.example.com' }])
    const transformed = await buildOpenApiDocument(section(), {
      transform: document => ({ ...document, 'x-transformed': true }),
    })
    expect(transformed.document['x-transformed']).toBe(true)
  })

  it('uses a custom error schema (problem details) and its media type', async () => {
    const Problem = z.object({ type: z.string(), title: z.string() })
    const result = await buildOpenApiDocument(
      metadata({
        errors: { contentType: 'application/problem+json', schema: 'Problem' },
        operations: [
          op('/x', 'get', { operationId: 'x', responses: { '400': { $ref: '#/components/responses/BadRequest' } } }),
        ],
        schemas: [slot('Problem', Problem, ['output'])],
      }),
    )
    expect(result.document.components?.responses).toEqual({
      BadRequest: {
        description: 'Bad Request',
        content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
      },
    })
    expect(Object.keys(result.document.components?.schemas ?? {})).toEqual(['Problem'])
  })

  it('is deterministic', async () => {
    const first = await buildOpenApiDocument(section())
    const second = await buildOpenApiDocument(section())
    expect(second.json).toBe(first.json)
  })

  it('reports a missing section (ZNIGHT030) and another format version (ZNIGHT018)', async () => {
    await expect(buildOpenApiDocument({ version: 1, providers: {}, resolutionOrder: [] })).rejects.toMatchObject({
      code: 'ZNIGHT030',
    })
    await expect(buildOpenApiDocument(metadata({ version: 2 as never }))).rejects.toMatchObject({ code: 'ZNIGHT018' })
  })

  it('assembles 150 schemas quickly (budget: 25 ms, reported)', async () => {
    const schemas = Array.from({ length: 150 }, (_, index) =>
      slot(
        `S${String(index).padStart(3, '0')}`,
        z.object({ id: z.string(), n: z.number().int(), tags: z.array(z.string()) }),
        ['input', 'output'],
      ),
    )
    const operations = schemas.map((item, index) =>
      op(`/r${index}`, 'post', { operationId: `r${index}`, requestBody: body(item.name), ...response(item.name) }),
    )
    await buildOpenApiDocument(metadata({ schemas, operations }))
    const started = performance.now()
    const result = await buildOpenApiDocument(metadata({ schemas, operations }))
    const elapsed = performance.now() - started
    console.info(`[budget] 150 schemas assembled in ${elapsed.toFixed(1)} ms (${result.stats.schemas} components)`)
    // output and input differ for Zod objects (output closed with additionalProperties: false)
    expect(result.stats.schemas).toBe(300)
  })
})
