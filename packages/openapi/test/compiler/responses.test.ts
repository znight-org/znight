/**
 * Success responses inferred from handler signatures (§5.4.4 of RFC 0002), checked against the
 * serialiser of `@znight/http` (§9.1 of the architecture): `HttpResponse` unions, media types of
 * strings, bodyless statuses, `T | undefined`, HEAD, `HttpResponse.sse()`, path templates.
 */
import type { OpenApiObject } from '../../src/index.ts'

import { buildOpenApiDocument } from '../../src/index.ts'
import { cleanupApps, compileApp, loadApp, render, tempApp, validateDocument } from '../support/apps.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

const MAIN = `import { OpenApiPlugin } from '@znight/openapi'\nexport const plugin = OpenApiPlugin\n`

/** Compiles a controller: the openapi diagnostics, and the assembled document when the compile succeeds. */
async function assemble(body: string): Promise<{ lines: string[]; document: OpenApiObject | undefined }> {
  const app = tempApp({
    'src/main.ts': MAIN,
    'src/book.ts': `export interface Book { readonly title: string }
export enum Color { Red = 'red', Blue = 'blue' }
export enum Level { Low = 1, High = 2 }
`,
    'src/controller.ts': `import { Body, Controller, Delete, Get, Head, HttpCode, HttpResponse, Param, Post, Put, type SseBody } from '@znight/http'
import { ApiResponse } from '@znight/openapi'
import { type Book, Color, Level } from './book.ts'
@Controller('/w')
export class WController {
${body}
}
`,
  })
  const result = await compileApp(app)
  const lines = render(
    app,
    result.diagnostics.filter(diagnostic => /^ZNIGHT03\d$/.test(diagnostic.code)),
  )
  if (result.diagnostics.some(diagnostic => diagnostic.severity === 'error')) return { lines, document: undefined }
  const built = await buildOpenApiDocument(await loadApp(app))
  expect(await validateDocument(built.document)).toMatchObject({ valid: true })
  return { lines, document: built.document }
}

const responsesOf = (document: OpenApiObject | undefined, path: string, method: string): Record<string, unknown> => {
  const item = document?.paths?.[path] as Record<string, { responses: Record<string, unknown> }> | undefined
  const responses = { ...item?.[method]?.responses }
  delete responses['400']
  return responses
}

const BOOK = { $ref: '#/components/schemas/Book' }

describe('HttpResponse unions', () => {
  it('documents each member as its body type, the status chosen at runtime', async () => {
    const { lines, document } = await assemble(`  @Put('/:id')
  @ApiResponse(204, { description: 'Unchanged' })
  async update(@Param('id') id: string): Promise<HttpResponse<Book> | HttpResponse<undefined>> {
    return HttpResponse.noContent()
  }
  @Get('/mixed')
  mixed(): Book | HttpResponse<undefined> { return null! }
  @Get('/same')
  same(): Promise<Book | HttpResponse<Book>> { return null! }`)
    expect(lines).toEqual([])
    expect(responsesOf(document, '/w/{id}', 'put')).toEqual({
      '200': { description: 'OK', content: { 'application/json': { schema: BOOK } } },
      '204': { description: 'Unchanged' },
    })
    expect(responsesOf(document, '/w/mixed', 'get')).toEqual({
      '200': { description: 'OK', content: { 'application/json': { schema: BOOK } } },
    })
    expect(responsesOf(document, '/w/same', 'get')).toEqual({
      '200': { description: 'OK', content: { 'application/json': { schema: BOOK } } },
    })
  })

  it('still asks for the body type of a bare HttpResponse member', async () => {
    const { lines } = await assemble(`  @Get()
  get(): HttpResponse<Book> | HttpResponse { return null! }`)
    expect(lines).toEqual([
      'warning ZNIGHT031 src/controller.ts:7:3 The 200 response of GET /w (WController.get) cannot be documented: HttpResponse has no body type',
    ])
  })
})

describe('media types', () => {
  it('documents string literals, string enums and string unions as text/plain, mixes with both media types', async () => {
    const { lines, document } = await assemble(`  @Get('/lit')
  lit(): 'ok' { return 'ok' }
  @Get('/status')
  status(): 'active' | 'disabled' { return 'active' }
  @Get('/color')
  color(): Color { return Color.Red }
  @Get('/level')
  level(): Level { return Level.Low }
  @Get('/maybe')
  maybe(): string | null { return null }
  @Get('/either')
  either(): Book | Color { return null! }`)
    expect(lines).toEqual([])
    const media = (path: string): unknown => (responsesOf(document, path, 'get')['200'] as { content: unknown }).content
    expect(media('/w/lit')).toEqual({ 'text/plain': { schema: { type: 'string', const: 'ok' } } })
    expect(media('/w/status')).toEqual({
      'text/plain': { schema: { type: 'string', enum: ['active', 'disabled'] } },
    })
    expect(media('/w/color')).toEqual({ 'text/plain': { schema: { $ref: '#/components/schemas/Color' } } })
    expect(media('/w/level')).toEqual({ 'application/json': { schema: { $ref: '#/components/schemas/Level' } } })
    expect(media('/w/maybe')).toEqual({
      'application/json': { schema: { type: 'null' } },
      'text/plain': { schema: { type: 'string' } },
    })
    expect(media('/w/either')).toEqual({
      'application/json': { schema: BOOK },
      'text/plain': { schema: { $ref: '#/components/schemas/Color' } },
    })
  })
})

describe('statuses', () => {
  it('reports a body on a bodyless @HttpCode status (ZNIGHT035) and documents no content', async () => {
    const { lines } = await assemble(`  @Get('/a')
  @HttpCode(204)
  a(): Book { return null! }
  @Delete('/b')
  @HttpCode(204)
  b(): void {}`)
    expect(lines).toEqual([
      'error ZNIGHT035 src/controller.ts:8:3 GET /w/a (WController.a) returns a body, but its status is always 204 (@HttpCode(204)): 204 responses have none, the body is never sent',
    ])
  })

  it('documents the empty 204 of `T | undefined`, and no content on HEAD routes', async () => {
    const { lines, document } = await assemble(`  @Get('/m/:id')
  maybe(@Param('id') id: string): Book | undefined { return undefined }
  @Get('/declared')
  @ApiResponse(204, { description: 'Not there' })
  declared(): Book | undefined { return undefined }
  @Post('/p')
  post(): Book | undefined { return undefined }
  @Head('/h')
  head(): Book { return null! }`)
    expect(lines).toEqual([])
    expect(responsesOf(document, '/w/m/{id}', 'get')).toEqual({
      '200': { description: 'OK', content: { 'application/json': { schema: BOOK } } },
      '204': { description: 'No Content' },
    })
    expect(responsesOf(document, '/w/declared', 'get')['204']).toEqual({ description: 'Not there' })
    expect(Object.keys(responsesOf(document, '/w/p', 'post'))).toEqual(['201'])
    expect(responsesOf(document, '/w/h', 'head')).toEqual({ '200': { description: 'OK' } })
  })
})

describe('HttpResponse.sse()', () => {
  it('documents a 200 event stream, even on POST, without exposing SseBody', async () => {
    const { lines, document } = await assemble(`  @Post('/:id/assistant')
  assistant(@Param('id') id: string): HttpResponse<SseBody> {
    return HttpResponse.sse([{ data: id }])
  }
  @Post('/created')
  @HttpCode(202)
  created(): Promise<HttpResponse<SseBody>> { return null! }`)
    expect(lines).toEqual([])
    expect(responsesOf(document, '/w/{id}/assistant', 'post')).toEqual({
      '200': { description: 'OK', content: { 'text/event-stream': { schema: { type: 'string' } } } },
    })
    expect(Object.keys(responsesOf(document, '/w/created', 'post'))).toEqual(['202'])
    expect(document?.components?.schemas?.['SseBody']).toBeUndefined()
  })
})

describe('path templates', () => {
  it('documents the routes of one path under one template, with a ZNIGHT035 warning', async () => {
    const { lines, document } = await assemble(`  @Get('/m/:id')
  get(@Param('id') id: string): Book { return null! }
  @Delete('/m/:bookId')
  remove(@Param('bookId') bookId: string): void {}`)
    expect(lines).toEqual([
      'warning ZNIGHT035 src/controller.ts:7:3 The routes of one path name its parameters differently (GET /w/m/:id (WController.get), DELETE /w/m/:bookId (WController.remove)): OpenAPI forbids two templates of one path, documented as /w/m/{bookId}',
    ])
    expect(Object.keys(document?.paths ?? {})).toEqual(['/w/m/{bookId}'])
    const parameters = (document?.paths?.['/w/m/{bookId}']?.get?.parameters ?? []) as readonly { name: string }[]
    expect(parameters.map(parameter => parameter.name)).toEqual(['bookId'])
  })

  it('names the wildcard parameter apart from a :wildcard parameter', async () => {
    const { lines, document } = await assemble(`  @Get('/:wildcard/*')
  files(@Param('wildcard') root: string): string { return root }`)
    expect(lines).toEqual([])
    const parameters = (document?.paths?.['/w/{wildcard}/{wildcard_1}']?.get?.parameters ?? []) as readonly {
      name: string
    }[]
    expect(parameters.map(parameter => parameter.name)).toEqual(['wildcard', 'wildcard_1'])
  })
})
