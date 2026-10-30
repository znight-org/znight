/**
 * The bookshelf fixture compiled with `compile()`: the generated section, the assembled document
 * (snapshot, valid OpenAPI 3.1), determinism and the inference rules of §5.4 of RFC 0002.
 */
import type { ZnightMetadata } from '@znight/core'
import type { OpenApiMetadata, OpenApiObject, OperationObject } from '../../src/index.ts'
import type { TempApp } from '../support/apps.ts'

import { buildOpenApiDocument } from '../../src/index.ts'
import { cleanupApps, compileApp, fixtureApp, loadApp, render, validateDocument } from '../support/apps.ts'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

describe('bookshelf fixture', () => {
  let app: TempApp
  let metadata: ZnightMetadata
  let document: OpenApiObject
  let json: string

  beforeAll(async () => {
    app = fixtureApp('bookshelf', { license: 'MIT', description: 'Fallback description' })
    metadata = await loadApp(app)
    const built = await buildOpenApiDocument(metadata)
    document = built.document
    json = built.json
  })

  afterAll(cleanupApps)

  const operation = (path: string, method: string): OperationObject =>
    (document.paths?.[path] as unknown as Record<string, OperationObject> | undefined)?.[method] as OperationObject

  it('compiles without diagnostics', async () => {
    const result = await compileApp(app)
    expect(render(app, result.diagnostics)).toEqual([])
  })

  it('assembles a valid OpenAPI 3.1 document', async () => {
    expect(await validateDocument(document)).toEqual({ valid: true, errors: undefined })
    expect(document.openapi).toBe('3.1.1')
  })

  it('matches the snapshot', () => {
    expect(json).toMatchSnapshot()
  })

  it('is deterministic (two compiles, two assemblies)', async () => {
    const other = fixtureApp('bookshelf', { license: 'MIT', description: 'Fallback description' })
    const second = await buildOpenApiDocument(await loadApp(other))
    expect(second.json).toBe(json)
    const again = await buildOpenApiDocument(metadata)
    expect(again.json).toBe(json)
  })

  it('takes the title and description from the JSDoc, the version and license from package.json', () => {
    expect(document.info).toEqual({
      title: 'Bookshelf API',
      version: '1.2.3',
      contact: { email: 'api@example.com' },
      description: 'A shelf of books with a cover each.',
      license: { name: 'MIT', identifier: 'MIT' },
    })
    expect(document['x-audience']).toBe('public')
    expect(typeof document['x-znight-fingerprint']).toBe('string')
  })

  it('documents parameters from signatures, coercion plans and defaults', () => {
    expect(operation('/books', 'get').parameters).toEqual([
      { name: 'q', in: 'query', description: 'Case-insensitive search in titles.', schema: { type: 'string' } },
      {
        name: 'tag',
        in: 'query',
        schema: { type: 'array', items: { type: 'string' }, default: [] },
        style: 'form',
        explode: true,
      },
      { name: 'sort', in: 'query', schema: { type: 'string', enum: ['author', 'title', 'year'], default: 'title' } },
      { name: 'limit', in: 'query', description: 'Page size.', schema: { type: 'number', default: 20 } },
      { name: 'x-tenant', in: 'header', description: 'Tenant of the shelf', schema: { type: 'string' } },
    ])
  })

  it('explodes a whole-query schema into parameters', () => {
    expect(operation('/books/search', 'get').parameters?.slice(0, 2)).toEqual([
      { name: 'q', in: 'query', schema: { type: 'string' } },
      { name: 'tags', in: 'query', schema: { type: 'array', items: { type: 'string' } }, style: 'form', explode: true },
    ])
  })

  it('documents the wildcard and @ApiQuery', () => {
    const files = operation('/books/{id}/files/{wildcard}', 'get')
    expect(files.parameters).toContainEqual({
      name: 'wildcard',
      in: 'path',
      description: 'The rest of the path, `/` included',
      required: true,
      schema: { type: 'string' },
      'x-znight-wildcard': true,
    })
    expect(files.parameters).toContainEqual({
      name: 'version',
      in: 'query',
      description: 'Version of the file',
      schema: { type: 'number' },
    })
    expect(files['x-znight-wildcard']).toBe(true)
  })

  it('uses the input JSON Schema for requests and names output and input variants', () => {
    expect(operation('/books', 'post').requestBody).toEqual({
      content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateBook' } } },
      required: true,
    })
    const schema = document.components?.schemas?.['CreateBook'] as {
      properties: Record<string, unknown>
      required: string[]
    }
    expect(schema.properties['year']).toEqual({ type: 'string' })
    expect(schema.required).not.toContain('tags')
  })

  it('documents responses: status, headers, @returns, @ApiResponse merges and standard errors', () => {
    expect(operation('/books', 'post').responses).toEqual({
      '201': {
        description: 'The new book. Its URL is in the `location` header.',
        headers: { location: { description: 'URL of the new book', schema: { type: 'string' } } },
        content: { 'application/json': { schema: { $ref: '#/components/schemas/BookResponse' } } },
      },
      '400': { $ref: '#/components/responses/BadRequest' },
      '409': {
        description: 'A book with this ISBN is already on the shelf',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/HttpErrorBody' } } },
      },
      '413': { $ref: '#/components/responses/PayloadTooLarge' },
    })
    expect(operation('/books/{id}', 'delete').responses?.['204']).toEqual({ description: 'No Content' })
    expect(operation('/books', 'get').responses?.['200']).toMatchObject({
      headers: { 'cache-control': { schema: { type: 'string' }, example: 'no-store' } },
    })
  })

  it('documents binary responses, Web Responses through @ApiResponse<T> and uploads', () => {
    expect(operation('/books/{id}/cover', 'get').responses?.['200']).toEqual({
      description: 'The cover image',
      content: { 'image/png': {}, 'image/jpeg': {} },
    })
    expect(operation('/books/report', 'get').responses?.['200']).toEqual({
      description: 'OK',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ShelfReport' } } },
    })
    const upload = operation('/books/{id}/cover', 'put')
    expect(upload.requestBody).toMatchObject({
      required: true,
      content: {
        'multipart/form-data': {
          encoding: { cover: { contentType: 'image/png, image/jpeg' } },
          schema: {
            allOf: [
              { $ref: '#/components/schemas/CoverForm' },
              {
                type: 'object',
                properties: {
                  cover: {
                    contentMediaType: 'application/octet-stream',
                    description: 'At most 2 MiB',
                    'x-znight-max-size': 2097152,
                  },
                },
                required: ['cover'],
              },
            ],
          },
        },
      },
    })
    expect(Object.keys(upload.responses ?? {})).toEqual(['200', '400', '413', '415'])
  })

  it('maps security: decisions with scopes, public routes, @ApiSecurity on the class and the route', () => {
    expect(document.security).toEqual([{ apiKey: [] }])
    expect(operation('/books', 'get').security).toEqual([{ oauth2: ['reader'] }])
    expect(operation('/books', 'post').security).toEqual([{ oauth2: ['admin'] }])
    expect(operation('/books/search', 'get').security).toEqual([])
    expect(operation('/orders', 'post').security).toEqual([{ apiKey: [] }])
    expect(operation('/orders', 'get').security).toEqual([])
    expect(Object.keys(document.components?.securitySchemes ?? {})).toEqual(['apiKey', 'oauth2'])
  })

  it('names operations, tags and @All expansions, and skips @ApiExclude', () => {
    expect(operation('/books/{id}', 'delete')).toMatchObject({ operationId: 'removeBook', deprecated: true })
    expect(Object.keys(document.paths?.['/books/{id}/proxy'] ?? {})).toEqual(['get', 'put', 'post', 'delete', 'patch'])
    expect(operation('/books/{id}/proxy', 'patch').operationId).toBe('book.proxy.patch')
    expect(document.paths?.['/books/internal']).toBeUndefined()
    expect(document.paths?.['/health']).toBeUndefined()
    expect(document.tags).toEqual([
      { name: 'Books', description: 'The shelf' },
      { name: 'Order', description: 'Orders of books.' },
    ])
  })

  it('converts TypeScript declarations: JSDoc tags, enums, nullables, discriminated unions, records', () => {
    const schemas = document.components?.schemas ?? {}
    expect(schemas['BookResponse']).toMatchObject({
      description: 'A book of the shelf.',
      properties: {
        id: { type: 'integer', format: 'int64' },
        title: { type: 'string', description: 'The title.', minLength: 1, examples: ['Dune'] },
        genre: { $ref: '#/components/schemas/Genre' },
        publishedYear: { type: ['number', 'null'] },
        createdAt: { type: 'string', format: 'date-time' },
        labels: { deprecated: true },
      },
    })
    expect((schemas['BookResponse'] as { required: string[] }).required).not.toContain('coverUrl')
    expect(schemas['Genre']).toEqual({ type: 'string', enum: ['novel', 'poetry'], description: 'Literary genres.' })
    expect(schemas['Payment']).toEqual({
      oneOf: [{ $ref: '#/components/schemas/Card' }, { $ref: '#/components/schemas/Transfer' }],
      discriminator: {
        propertyName: 'method',
        mapping: { card: '#/components/schemas/Card', transfer: '#/components/schemas/Transfer' },
      },
      description: 'How an order is paid.',
    })
    expect(schemas['ShelfReport']).toMatchObject({
      properties: { genres: { type: 'object', additionalProperties: { type: 'number' } } },
    })
    expect(Object.keys(schemas)).toContain('Page_BookResponse')
  })

  it('converts Valibot (fallback converter) and ArkType (Standard JSON Schema) schemas', () => {
    const schemas = document.components?.schemas ?? {}
    expect(schemas['NewOrder']).toEqual({
      type: 'object',
      properties: { bookId: { type: 'integer', minimum: 1 }, quantity: { type: 'integer', minimum: 1 } },
      required: ['bookId', 'quantity'],
    })
    expect(schemas['Rating']).toMatchObject({ properties: { stars: { type: 'integer', minimum: 1, maximum: 5 } } })
  })

  it('emits the generated section with the schema slots imported once', async () => {
    const result = await compileApp(app)
    const section = (metadata.extensions as { openapi: OpenApiMetadata }).openapi
    expect(section.version).toBe(1)
    expect(section.schemas.map(slot => [slot.name, slot.io])).toEqual([
      ['CoverForm', ['input']],
      ['CreateBook', ['input']],
      ['NewOrder', ['input']],
      ['Rating', ['input']],
      ['SearchQuery', ['input']],
    ])
    expect(section.schemas[1]?.source).toEqual({ file: 'src/books/book.schemas.ts', line: 6, column: 14 })
    expect(result.code.match(/import \{[^}]*\bCreateBook\b[^}]*\} from/g)?.length).toBe(1)
    const second = await compileApp(app)
    expect(second.code).toBe(result.code)
  })
})
