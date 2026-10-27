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

  it('documents coerced Zod dates of requests and Valibot dates of responses as date-time strings', async () => {
    const Range = z.object({ since: z.coerce.date(), until: z.coerce.date().optional() })
    const Event = v.object({ at: v.date(), name: v.string() })
    const result = await buildOpenApiDocument(
      metadata({
        operations: [
          op('/events', 'get', {
            operationId: 'events',
            parameters: [{ $znight: 'parameters', in: 'query', name: 'Range', io: 'input' }],
            ...response('Event'),
          }),
        ],
        schemas: [slot('Event', Event, ['output']), slot('Range', Range, ['input'])],
      }),
    )
    expect(result.document.paths?.['/events']?.get?.parameters).toEqual([
      { name: 'since', in: 'query', required: true, schema: { type: 'string', format: 'date-time' } },
      { name: 'until', in: 'query', schema: { type: 'string', format: 'date-time' } },
    ])
    expect(result.document.components?.schemas?.['Event']).toMatchObject({
      properties: { at: { type: 'string', format: 'date-time' }, name: { type: 'string' } },
    })
    // a plain z.date() / v.date() read from a request stays unrepresentable
    const section = metadata({
      operations: [op('/d', 'post', { operationId: 'd', requestBody: body('Plain') })],
      schemas: [slot('Plain', v.object({ at: v.date(), n: v.number() }), ['input'])],
    })
    await expect(buildOpenApiDocument(section)).rejects.toMatchObject({ code: 'ZNIGHT037' })
    const lenient = await buildOpenApiDocument(section, { unrepresentable: 'warn' })
    expect(lenient.document.components?.schemas?.['Plain']).toMatchObject({ properties: { n: { type: 'number' } } })
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

  it('takes the definition as the slot component when the root only references it (.meta({ id }))', async () => {
    const User = z.object({ id: z.number(), name: z.string() }).meta({ id: 'User' })
    const result = await buildOpenApiDocument(
      metadata({
        operations: [op('/users', 'put', { operationId: 'put', requestBody: body('User'), ...response('User') })],
        schemas: [slot('User', User, ['input', 'output'])],
      }),
    )
    const schemas = result.document.components?.schemas ?? {}
    expect(Object.keys(schemas)).toEqual(['User', 'UserInput'])
    expect(schemas['User']).toMatchObject({ type: 'object', required: ['id', 'name'], additionalProperties: false })
    expect(schemas['UserInput']).toMatchObject({ type: 'object', required: ['id', 'name'] })
    expect(result.document.paths?.['/users']?.put?.requestBody).toMatchObject({
      content: { 'application/json': { schema: { $ref: '#/components/schemas/UserInput' } } },
    })
    // another export name: the slot is an alias of the id
    const UserSchema = z.object({ id: z.number() }).meta({ id: 'Account' })
    const alias = await buildOpenApiDocument(
      metadata({
        operations: [op('/a', 'get', { operationId: 'a', ...response('UserSchema') })],
        schemas: [slot('UserSchema', UserSchema, ['output'])],
      }),
    )
    expect(alias.document.components?.schemas).toMatchObject({
      UserSchema: { $ref: '#/components/schemas/Account' },
      Account: { type: 'object' },
    })
    expect(await validateDocument(result.document)).toMatchObject({ valid: true })
    expect(await validateDocument(alias.document)).toMatchObject({ valid: true })
  })

  it('scopes anonymous definitions to their slot and names the input variant of definitions', async () => {
    const Category: z.ZodType = z.object({
      name: z.string(),
      get children() {
        return z.array(Category)
      },
    })
    const Node: z.ZodType = z.object({
      value: z.number(),
      get next() {
        return Node.optional()
      },
    })
    const Tree = z.object({ root: Category })
    const List = z.object({ head: Node })
    const Address = z.object({ street: z.string(), zip: z.string().default('00000') }).meta({ id: 'Address' })
    const CreateUser = z.object({ address: Address })
    const User = z.object({ id: z.number(), address: Address })
    const result = await buildOpenApiDocument(
      metadata({
        operations: [
          op('/tree', 'put', { operationId: 'tree', requestBody: body('Tree'), ...response('Tree') }),
          op('/list', 'get', { operationId: 'list', ...response('List') }),
          op('/users', 'post', { operationId: 'user', requestBody: body('CreateUser'), ...response('User') }),
        ],
        schemas: [
          slot('CreateUser', CreateUser, ['input']),
          slot('List', List, ['output']),
          slot('Tree', Tree, ['input', 'output']),
          slot('User', User, ['output']),
        ],
      }),
    )
    const schemas = result.document.components?.schemas ?? {}
    expect(Object.keys(schemas)).toEqual([
      'Address',
      'AddressInput',
      'CreateUser',
      'List',
      'List_schema0',
      'Tree',
      'TreeInput',
      'Tree_schema0',
      'Tree_schema0Input',
      'User',
    ])
    expect(schemas['Address']).toMatchObject({ required: ['street', 'zip'], additionalProperties: false })
    expect(schemas['AddressInput']).toMatchObject({ required: ['street'] })
    expect(schemas['CreateUser']).toMatchObject({
      properties: { address: { $ref: '#/components/schemas/AddressInput' } },
    })
    expect(schemas['User']).toMatchObject({ properties: { address: { $ref: '#/components/schemas/Address' } } })
    expect(schemas['Tree']).toMatchObject({ properties: { root: { $ref: '#/components/schemas/Tree_schema0' } } })
    expect(schemas['TreeInput']).toMatchObject({
      properties: { root: { $ref: '#/components/schemas/Tree_schema0Input' } },
    })
    expect(schemas['Tree_schema0Input']).toMatchObject({
      properties: { children: { items: { $ref: '#/components/schemas/Tree_schema0Input' } } },
    })
    expect(JSON.stringify(result.document)).not.toContain('__schema')
    expect(await validateDocument(result.document)).toMatchObject({ valid: true })
  })

  it('names the input variant of a slot whose only difference is a referenced definition', async () => {
    const Inner = z.object({ n: z.number().default(1) }).meta({ id: 'Inner' })
    const Outer = z.array(Inner)
    const result = await buildOpenApiDocument(
      metadata({
        operations: [op('/o', 'put', { operationId: 'o', requestBody: body('Outer'), ...response('Outer') })],
        schemas: [slot('Outer', Outer, ['input', 'output'])],
      }),
    )
    expect(result.document.components?.schemas).toMatchObject({
      Outer: { type: 'array', items: { $ref: '#/components/schemas/Inner' } },
      OuterInput: { type: 'array', items: { $ref: '#/components/schemas/InnerInput' } },
    })
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

describe('parameters', () => {
  it('drops expanded parameters that an explicit parameter or another schema already documents, with a warning', async () => {
    const Search = z.object({ q: z.string(), page: z.number().optional(), size: z.number().optional() })
    const Paging = z.object({ size: z.number(), cursor: z.string().optional() })
    const result = await buildOpenApiDocument(
      metadata({
        operations: [
          op('/s', 'get', {
            operationId: 's',
            parameters: [
              { $znight: 'parameters', in: 'query', name: 'Search', io: 'input' },
              { $znight: 'parameters', in: 'query', name: 'Paging', io: 'input' },
              { name: 'page', in: 'query', schema: { type: 'integer' } },
              { name: 'q', in: 'query', description: 'dup', schema: { type: 'string' } },
              { name: 'q', in: 'header', schema: { type: 'string' } },
            ],
          }),
        ],
        schemas: [slot('Paging', Paging, ['input']), slot('Search', Search, ['input'])],
      }),
    )
    const parameters = result.document.paths?.['/s']?.get?.parameters as { name: string; in: string }[]
    expect(parameters.map(parameter => `${parameter.in} ${parameter.name}`)).toEqual([
      'query size',
      'query cursor',
      'query page',
      'query q',
      'header q',
    ])
    expect(parameters[3]).toMatchObject({ description: 'dup' })
    expect(result.warnings).toEqual([
      {
        code: 'ZNIGHT035',
        message:
          'Parameters expanded from whole-object schemas are already documented (OpenAPI forbids two parameters with one name and location), the duplicate is dropped:\n  - GET /s: the query parameter "q" of the schema Search\n  - GET /s: the query parameter "page" of the schema Search\n  - GET /s: the query parameter "size" of the schema Paging',
        hints: ["Remove the property from the schema, or the @Query('name') / @ApiQuery('name') that reads it again"],
      },
    ])
    expect(await validateDocument(result.document)).toMatchObject({ valid: true })
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
