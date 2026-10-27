/**
 * Diagnostics ZNIGHT030–036 of the compiler extension: reported (with their location and hints)
 * and not reported, through `compile()`.
 */
import type { Diagnostic } from '@znight/compiler'

import { cleanupApps, compileApp, render, tempApp } from '../support/apps.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

const MAIN = `import { OpenApiPlugin } from '@znight/openapi'\nexport const plugin = OpenApiPlugin\n`

/** Compiles `files` (plus a main importing @znight/openapi) and returns the openapi diagnostics. */
async function diagnose(files: Record<string, string>): Promise<{ lines: string[]; diagnostics: Diagnostic[] }> {
  const app = tempApp({ 'src/main.ts': MAIN, ...files })
  const result = await compileApp(app)
  const diagnostics = result.diagnostics.filter(diagnostic => /^ZNIGHT03\d$/.test(diagnostic.code))
  return { lines: render(app, diagnostics), diagnostics }
}

const controller = (body: string, imports = ''): Record<string, string> => ({
  'src/controller.ts': `import { Body, Controller, Delete, Get, Headers, HttpCode, HttpResponse, Post, Query, Res } from '@znight/http'
import { ApiBody, ApiExclude, ApiHeader, ApiOperation, ApiQuery, ApiResponse, ApiSecurity, ApiTags } from '@znight/openapi'
${imports}
@Controller('/items')
export class ItemController {
${body}
}
`,
})

describe('ZNIGHT030 InvalidOpenApiDefinition', () => {
  it('reports @Api* decorators outside controllers and route handlers', async () => {
    const { lines, diagnostics } = await diagnose({
      'src/service.ts': `import { ApiTags } from '@znight/openapi'
import { Controller, Get } from '@znight/http'
@ApiTags('x')
export class Helper {}
@Controller('/a')
export class AController {
  @ApiTags('y')
  helper(): void {}
  @Get()
  ok(): string { return '' }
}
`,
    })
    expect(lines).toEqual([
      'error ZNIGHT030 src/service.ts:3:1 @ApiTags applies to controllers: Helper is not a @Controller',
      'error ZNIGHT030 src/service.ts:7:3 @ApiTags applies to route handlers: AController.helper has no route decorator (@Get, @Post...)',
    ])
    expect(diagnostics[0]?.hints).toEqual(['Add @Controller() to the class, or remove the decorator'])
  })

  it('reports a second @OpenApiDocument and invalid options', async () => {
    const { lines } = await diagnose({
      'src/api.ts': `import { OpenApiDocument } from '@znight/openapi'
@OpenApiDocument({ info: { license: { name: 'MIT', identifier: 'not spdx!' } }, unknown: true } as never)
export class Api {}
@OpenApiDocument()
export class Other {}
`,
    })
    expect(lines).toEqual([
      'error ZNIGHT030 src/api.ts:2:18 Invalid @OpenApiDocument options: "info.license.identifier" must be an SPDX expression (MIT, Apache-2.0...)',
      'error ZNIGHT030 src/api.ts:2:18 Invalid @OpenApiDocument options: unknown option "unknown"',
      'error ZNIGHT030 src/api.ts:4:1 An application has one @OpenApiDocument: Other and Api both declare one',
    ])
  })

  it('reports invalid static values: status, operation id, media type, header name', async () => {
    const { lines } = await diagnose(
      controller(`  @Get()
  @ApiResponse(700 as never)
  @ApiOperation({ operationId: '1-bad' })
  @ApiResponse(200, { contentType: 'not a type' })
  @ApiHeader('bad header')
  list(): string[] { return [] }`),
    )
    expect(lines).toEqual([
      'error ZNIGHT030 src/controller.ts:7:16 Invalid response status 700: expected a code (100-599), "2XX"-like or "default"',
      'error ZNIGHT030 src/controller.ts:8:3 Invalid operation id "1-bad": it must match /^[A-Za-z_][\\w.-]*$/',
      'error ZNIGHT030 src/controller.ts:9:21 Invalid media type "not a type": expected "type/subtype" or a list of them',
      'error ZNIGHT030 src/controller.ts:10:14 Invalid header name "bad header"',
    ])
  })

  it('reports a malformed securityScheme() and the reserved $znight key', async () => {
    const { lines } = await diagnose({
      'src/api.ts': `import { OpenApiDocument, securityScheme } from '@znight/openapi'
export const Broken = securityScheme('broken', { type: 'apiKey', in: 'body', name: 'x' } as never)
@OpenApiDocument({ security: [Broken], extensions: { 'x-a': { $znight: 1 } } as never })
export class Api {}
`,
    })
    expect(lines).toEqual([
      'error ZNIGHT030 src/api.ts:2:48 Invalid security scheme Broken: "in" must be "query", "header" or "cookie"',
      'error ZNIGHT030 src/api.ts:3:18 Invalid @OpenApiDocument options: "$znight" is a reserved key (extensions.x-a.$znight)',
    ])
  })
})

describe('ZNIGHT031 UndocumentedResponse', () => {
  it('warns when the success response cannot be documented, with the RFC hints', async () => {
    const { lines, diagnostics } = await diagnose(
      controller(`  @Post()
  async create(): Promise<HttpResponse> { return HttpResponse.created() as never }
  @Get('/raw')
  raw(@Res() res: unknown): void { void res }
  @Get('/any')
  any() { return 1 }
  @Get('/web')
  @ApiResponse<{ ok: boolean }>(200)
  web(): Response { return new Response() }`),
    )
    expect(lines).toEqual([
      'warning ZNIGHT031 src/controller.ts:7:9 The 201 response of POST /items (ItemController.create) cannot be documented: HttpResponse has no body type',
      'warning ZNIGHT031 src/controller.ts:9:3 The 200 response of GET /items/raw (ItemController.raw) cannot be documented: the handler writes the response itself (@Res())',
      'warning ZNIGHT031 src/controller.ts:11:3 The 200 response of GET /items/any (ItemController.any) cannot be documented: the handler has no return type annotation',
    ])
    expect(diagnostics[0]?.hints).toEqual([
      'Give the body type: Promise<HttpResponse<BookResponse>>',
      'Or declare it: @ApiResponse<BookResponse>(201)',
    ])
  })

  it('is an error with strict', async () => {
    const { lines } = await diagnose({
      ...controller(`  @Get()
  list() { return [] }`),
      'src/api.ts': `import { OpenApiDocument } from '@znight/openapi'\n@OpenApiDocument({ strict: true })\nexport class Api {}\n`,
    })
    expect(lines.map(line => line.split(' ').slice(0, 2).join(' '))).toEqual(['error ZNIGHT031'])
  })
})

describe('ZNIGHT032 UnrepresentableType', () => {
  it('reports a bigint in a response as an error at the property, a Map as a warning', async () => {
    const { lines, diagnostics } = await diagnose({
      ...controller(
        `  @Get('/stats')
  stats(): ShelfStats { return null! }
  @Get('/map')
  map(): { index: Map<string, number> } { return null! }`,
        "import type { ShelfStats } from './stats.ts'",
      ),
      'src/stats.ts': 'export interface ShelfStats {\n  readonly total: bigint\n}\n',
    })
    expect(lines).toEqual([
      'warning ZNIGHT032 src/controller.ts:9:19 index (Map<string, number>) is not serialised as declared by JSON.stringify: it is documented as any value (GET /items/map (ItemController.map))',
      'error ZNIGHT032 src/stats.ts:2:19 ShelfStats.total is a bigint: JSON.stringify throws on bigint, so GET /items/stats (ItemController.stats) would answer 500',
    ])
    expect(diagnostics[1]?.hints).toEqual([
      'Return a number or a string (String(total)), or give the type a toJSON() method',
    ])
  })

  it('reports invalid JSDoc tag values', async () => {
    const { lines } = await diagnose({
      ...controller('  @Get()\n  get(): Book { return null! }', "import type { Book } from './book.ts'"),
      'src/book.ts': 'export interface Book {\n  /** @minimum lots */\n  readonly pages: number\n}\n',
    })
    expect(lines).toEqual(['warning ZNIGHT032 src/book.ts:2:7 Invalid @minimum value "lots": expected a number'])
  })
})

describe('ZNIGHT033 DuplicateOperationId', () => {
  it('reports two operations with one id', async () => {
    const { lines, diagnostics } = await diagnose({
      'src/a/book.controller.ts': `import { Controller, Get } from '@znight/http'
@Controller('/a')
export class BookController {
  @Get()
  list(): string[] { return [] }
}
`,
      'src/b/book.controller.ts': `import { Controller, Get } from '@znight/http'
@Controller('/b')
export class BookController {
  @Get()
  list(): string[] { return [] }
}
`,
    })
    expect(lines).toEqual([
      'error ZNIGHT033 src/b/book.controller.ts:5:3 Duplicate operation id "book.list": GET /a (BookController.list) and GET /b (BookController.list)',
    ])
    expect(diagnostics[0]?.related?.[0]?.location.file).toEndWith('src/a/book.controller.ts')
  })
})

describe('ZNIGHT034 SchemaNameConflict', () => {
  it('reports two declarations with one component name', async () => {
    const { lines } = await diagnose({
      ...controller(
        `  @Get('/a')\n  a(): A.Item { return null! }\n  @Get('/b')\n  b(): B.Item { return null! }`,
        "import type * as A from './a.ts'\nimport type * as B from './b.ts'",
      ),
      'src/a.ts': 'export interface Item { readonly a: string }\n',
      'src/b.ts': 'export interface Item { readonly b: string }\n',
    })
    expect(lines).toEqual([
      'error ZNIGHT034 src/b.ts:1:18 Two declarations are named "Item" in the OpenAPI document: src/b.ts#Item and src/a.ts#Item',
    ])
  })

  it('reserves the names of the standard error components', async () => {
    const { lines } = await diagnose({
      ...controller(
        '  @Get()\n  get(): HttpErrorBody { return null! }',
        "import type { HttpErrorBody } from './errors.ts'",
      ),
      'src/errors.ts': 'export interface HttpErrorBody { readonly code: string }\n',
    })
    expect(lines).toEqual([
      'error ZNIGHT034 src/errors.ts:1:18 HttpErrorBody is named "HttpErrorBody", a name reserved for the standard error components of the OpenAPI document',
    ])
  })
})

describe('ZNIGHT035 InconsistentOperation', () => {
  it('reports contradictions between the documentation and the route', async () => {
    const { lines } = await diagnose(
      controller(
        `  @Get()
  @ApiQuery('page')
  @ApiHeader('Authorization')
  list(@Query('page') page: number): string[] { return [String(page)] }

  @Post()
  @HttpCode(202)
  @ApiResponse(200)
  @ApiBody({ description: 'x' })
  create(@Body(Item) item: unknown): void { void item }

  @Delete('/:id')
  @ApiResponse<{ a: string }>(204)
  remove(): void {}

  @Get('/hidden')
  @ApiExclude()
  @ApiTags('x')
  hidden(): string { return '' }

  @Get('/body')
  @ApiBody<{ a: string }>()
  body(): string { return '' }`,
        "import { z } from 'zod'\nexport const Item = z.object({ a: z.string() })",
      ),
    )
    expect(lines).toEqual([
      'error ZNIGHT035 src/controller.ts:8:3 @ApiQuery(\'page\') documents the query parameter "page" of GET /items (ItemController.list), which the signature already reads',
      "error ZNIGHT035 src/controller.ts:9:3 @ApiHeader('Authorization'): OpenAPI ignores Accept, Content-Type and Authorization parameters",
      'error ZNIGHT035 src/controller.ts:14:3 @ApiResponse(200) on POST /items (ItemController.create), whose success status is always 202',
      'error ZNIGHT035 src/controller.ts:15:3 @ApiBody on POST /items (ItemController.create), whose body is already documented by its schema',
      'error ZNIGHT035 src/controller.ts:19:3 @ApiResponse(204) on DELETE /items/:id (ItemController.remove) declares a body: 204 responses have none',
      'warning ZNIGHT035 src/controller.ts:23:3 ItemController.hidden is excluded from the OpenAPI document (@ApiExclude): @ApiTags has no effect',
      'warning ZNIGHT035 src/controller.ts:28:3 @ApiBody on GET /items/body (ItemController.body): GET requests have no body in OpenAPI tools',
    ])
  })

  it('warns about an Authorization header read by the signature', async () => {
    const { lines } = await diagnose(
      controller(`  @Get()\n  list(@Headers('authorization') auth: string): string { return auth }`),
    )
    expect(lines).toEqual([
      'warning ZNIGHT035 src/controller.ts:7:8 The "authorization" header of GET /items (ItemController.list) is not documented as a parameter: OpenAPI ignores Accept, Content-Type and Authorization parameters',
    ])
  })
})

describe('ZNIGHT036 InvalidSecurityRequirement', () => {
  const api = (body: string): Record<string, string> => ({
    'src/api.ts': `import { OpenApiDocument, securityScheme } from '@znight/openapi'
import { createRouteDecorator } from '@znight/http'
export const Roles = createRouteDecorator<readonly string[]>('roles')
export const Unused = createRouteDecorator('unused')
export const ApiKey = securityScheme('apiKey', { type: 'apiKey', in: 'header', name: 'x-api-key' })
export const Other = securityScheme('apiKey', { type: 'apiKey', in: 'query', name: 'key' })
export const OAuth = securityScheme('oauth2', { type: 'oauth2', flows: { clientCredentials: { tokenUrl: 'https://id.example.com/token', scopes: { read: 'Read' } } } })
export const NotAScheme = { name: 'x' }
${body}
`,
  })

  it('reports scopes on a scheme without scopes, undeclared scopes, name clashes, non-schemes', async () => {
    const { lines } = await diagnose({
      ...api(`@OpenApiDocument({ security: [{ scheme: ApiKey, scopes: ['x'] }, { scheme: OAuth, scopes: ['write'] }, NotAScheme as never, Other] })
export class Api {}`),
      ...controller('  @Get()\n  list(): string[] { return [] }'),
    })
    expect(lines).toEqual([
      'error ZNIGHT036 src/api.ts:6:14 Two security schemes are named "apiKey" with different definitions: Other and src/api.ts#ApiKey',
      'error ZNIGHT036 src/api.ts:9:18 Scopes are only allowed on oauth2 and openIdConnect schemes, not on "apiKey" (apiKey)',
      'error ZNIGHT036 src/api.ts:9:18 The scope "write" is not declared by the flows of "oauth2"',
      'error ZNIGHT036 src/api.ts:9:18 { scheme, scopes } needs a static array of scope names',
    ])
  })

  it('reports invalid decisions, decisions never applied and invalid scope values', async () => {
    const { lines } = await diagnose({
      ...api(`@OpenApiDocument({ decisions: [{ when: NotAScheme as never, security: [] }, { when: Unused, security: [] }, { when: Roles, security: [OAuth], scopes: 'value' }] })
export class Api {}`),
      ...controller(
        `  @Get()\n  @Roles(['admin'])\n  list(): string[] { return [] }`,
        "import { Roles } from './api.ts'",
      ),
    })
    expect(lines).toEqual([
      'error ZNIGHT036 src/api.ts:9:18 decisions[].when must be a route decorator created with createRouteDecorator(), not an object',
      'warning ZNIGHT036 src/api.ts:9:85 The security decision on Unused applies to no route',
      'error ZNIGHT036 src/controller.ts:7:3 @Roles(["admin"]) on GET /items (ItemController.list) uses a scope that "oauth2" does not declare: admin',
    ])
  })

  it('accepts valid requirements', async () => {
    const { lines } = await diagnose({
      ...api(`@OpenApiDocument({ security: [ApiKey, [ApiKey, OAuth], { scheme: OAuth, scopes: ['read'] }] })
export class Api {}`),
      ...controller('  @Get()\n  @ApiSecurity()\n  list(): string[] { return [] }'),
    })
    expect(lines).toEqual([])
  })
})
