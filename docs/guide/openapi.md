---
description: Document an HTTP API with @znight/openapi - serve an OpenAPI 3.1 document and a Scalar or Swagger UI, what is inferred from your code, documenting operations, security from route decisions, emitting openapi.json in CI, typed clients and contract tests.
---

# OpenAPI

`@znight/openapi` builds an **OpenAPI 3.1** document from the code that already runs: routes,
parameters and their coercion types, defaults, the schemas of `@Body()` and `@Query()`, annotated
return types, uploads and access decisions. You add what cannot be inferred with JSDoc and a few
`@Api*` decorators. The compiler checks the documentation at build time: a response it cannot
describe, a duplicate operation id or an unknown security scheme is a build error with a location.

This page shows how to document an API. The [package reference](/packages/openapi) lists the plugin
options, the decorators, the type-to-JSON-Schema rules and the diagnostics.

## Serve the document and a UI {#serve}

```sh
npm install @znight/openapi
npm install @scalar/api-reference     # optional, with ui: 'scalar': served from node_modules, not the CDN
```

```ts
import { HttpPlugin } from '@znight/http'
import { OpenApiPlugin } from '@znight/openapi'
import { createApplication } from './.znight/container.generated.js'

const app = await createApplication({
  plugins: [HttpPlugin.configure({ port: 3000 }), OpenApiPlugin.configure({ ui: 'scalar' })],
})
await app.start() // GET /openapi.json, GET /docs (Scalar)
```

That is all: the title, version and description come from `package.json`, there is one operation
per route, and the compiler extension is discovered because a scanned file imports
`@znight/openapi`. `ui` is `'scalar'` or `'swagger'`; without it, only the JSON document is served.

The documentation routes go through the same pipeline as your controllers. When your application has
a required [access decision](./security#route-decisions), give them one:

```ts
OpenApiPlugin.configure({ ui: 'scalar', meta: [Public.meta()] }) // the documentation is public
```

On a public deployment where the API should stay undocumented, `enabled: false` serves nothing.

## What is inferred {#inferred}

| From your code                                            | In the document                                                   |
| --------------------------------------------------------- | ----------------------------------------------------------------- |
| Routes and the HTTP `prefix`                              | `paths` (`:id` → `{id}`), the prefix in `servers`                 |
| `@Param`, `@Query`, `@Headers`, `@Cookie` and their types | parameters, with the schema of the coercion and the defaults      |
| `@Body(S)`, upload parameters                             | `requestBody`: the **input** schema of `S`, `multipart/form-data` |
| The annotated return type (`Promise<BookResponse>`)       | the success response: status, media type and schema               |
| JSDoc of handlers, controllers, interfaces and properties | `summary`, `description`, `deprecated`, schema descriptions       |
| Route decisions (`@Public()`, `@Roles(...)`)              | `security`                                                        |
| Routes that coerce, validate, read a body or upload files | the standard `400`, `413` and `415` error responses               |

Return types must be **annotated**: the compiler reads types, it does not infer them from method
bodies. A route whose success response cannot be documented is
[`ZNIGHT031`](/reference/error-codes#znight031) (a warning, an error with `strict`), unless an
`@ApiResponse` covers it. The [inference rules](/packages/openapi#what-is-inferred) detail statuses,
media types and `HttpResponse<T>`.

## Document operations {#operations}

Write JSDoc as you would anyway; add decorators for what the signature does not say:

```ts
import { Body, Controller, Get, HttpResponse, Param, Post, Query } from '@znight/http'
import { ApiResponse, ApiTags } from '@znight/openapi'

/** Books of the shelf. */
@Controller('/books')
@ApiTags('Books')
export class BookController {
  constructor(private readonly books: BookService) {}

  /**
   * List books
   *
   * Sorted and paginated, filtered by text.
   * @param search Case-insensitive search in titles and authors.
   */
  @Get()
  async list(@Query('q') search?: string, @Query('limit') limit = 20): Promise<Page<BookResponse>> {
    /* ... */
  }

  /** Get a book */
  @Get('/:id')
  @ApiResponse(404, { description: 'No book with this id' })
  async get(@Param('id') id: number): Promise<BookResponse> {
    /* ... */
  }

  /**
   * Add a book
   * @returns The new book. Its URL is in the `location` header.
   */
  @Post()
  @ApiResponse(409, { description: 'A book with this ISBN is already on the shelf' })
  async create(@Body(CreateBook) input: CreateBook): Promise<HttpResponse<BookResponse>> {
    const book = await this.books.add(input)
    return HttpResponse.created(toResponse(book), `/books/${book.id}`) // 201 + location
  }
}
```

- The first JSDoc paragraph is the `summary`, the rest the `description`; `@param` describes a
  parameter, `@returns` the success response, `@deprecated` marks the operation.
- `@ApiResponse(status, { description, schema })` declares the error responses your handler or your
  [exception mappers](./http#exception-mappers) produce.
- `@ApiBody`, `@ApiQuery` and `@ApiHeader` document what a handler reads outside its signature
  (`ctx.rawBody()`, `ctx.query`); `@ApiExclude()` leaves a route out.

Like every Znight decorator, they are markers: the compiler reads them, they are stripped from the
bundle.

## Security from route decisions {#security}

Declare the security schemes once, and map your [route decisions](./security#route-decisions) to
security requirements: every operation is then documented with the security its guards enforce.

```ts [src/api.ts]
import { OpenApiDocument, securityScheme } from '@znight/openapi'

import { Public, Roles } from './auth/access.js'

export const Bearer = securityScheme('bearer', { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })

/**
 * Bookshelf API
 *
 * A shelf of books. Every route needs a token, except the public ones.
 */
@OpenApiDocument({
  security: [Bearer], // default of every operation
  decisions: [{ when: Public, security: [] }], // @Public() routes need nothing
  tags: [{ name: 'Books', description: 'The shelf' }],
})
export class BookshelfApi {}
```

The title and description come from the JSDoc of the class. Schemes are referenced by value, so a
typo is a compile error, and an unknown OAuth scope is
[`ZNIGHT036`](/reference/error-codes#znight036). The `storefront-api` example documents a bearer
token and an API key this way (`src/api.ts`).

## Emit `openapi.json` in CI {#emit}

Write the document at build time, without starting the application, and commit it: an API change
then shows up in the pull request diff, and clients are generated from the file.

```sh
znight openapi            # writes openapi.json at the project root
znight openapi --check    # CI: exit 1 when the file is missing or stale; never writes
znight build --openapi    # after the bundle: dist/openapi.json, next to dist/main.js
```

In production, serve the emitted file to skip the schema conversion at boot:
`OpenApiPlugin.configure({ document: { file: new URL('./openapi.json', import.meta.url) } })`. The
`openapi()` Vite plugin of `@znight/openapi/vite` emits after every build, and checks the committed
file in CI. With an HTTP `prefix`, pass it when you emit (`--prefix /api`) so that the file has the
`servers` of the served document: [all the flags](/packages/openapi#emitting-openapi-json).

### A typed client {#typed-client}

Generate TypeScript types from the committed file with `openapi-typescript`, and call the API with
`openapi-fetch`: paths, parameters, bodies and responses are then checked by the compiler of the
callers. The `storefront-api` example does it in `src/client/`:

```json [package.json]
{
  "scripts": {
    "openapi": "znight openapi",
    "client:generate": "npm exec --yes --package=typescript@5.9.3 --package=openapi-typescript@7.13.0 -- openapi-typescript openapi.json -o src/client/schema.d.ts"
  }
}
```

::: warning TypeScript 7
`openapi-typescript` uses the JavaScript API of TypeScript 5, which TypeScript 7 (the native
compiler) does not have. Run it with its own TypeScript 5, through `npm exec` with both packages as
above, outside your project's dependencies. (`npx -p a -p b` does not work under `bun run`, which
keeps only the last package.)
:::

A server change that breaks the contract (a renamed route, a removed field) changes `openapi.json`,
then the generated types, and every caller relying on it fails its type check.

## Test the contract {#testing}

`TestApp` boots the plugin like any other; the `OpenApi` provider gives the document:

```ts
import { OpenApi } from '@znight/openapi'
import { validateResponse } from '@znight/openapi/testing'

test('the served document is the committed one', async () => {
  await using app = await createTestApp()
  const served = await app.inject({ url: '/openapi.json' })
  expect(served.status).toBe(200)
  expect(served.body).toBe(readFileSync('openapi.json', 'utf8')) // stale: run `znight openapi`
})

test('GET /books/:id answers what its documentation says', async () => {
  await using app = await createTestApp()
  const document = await app.get(OpenApi).document()
  const response = await app.inject({ url: '/books/1', headers: { authorization: `Bearer ${token}` } })
  expect(validateResponse(document, { method: 'GET', path: '/books/{id}', response })).toEqual([])
})
```

`validateResponse()` checks the status, the media type, the required headers and the JSON body
against the documented schema (with the optional peer `@cfworker/json-schema`): the contract is
tested, not only the code. A snapshot of the document (`expect(document).toMatchSnapshot()`) is a
lighter alternative when you do not commit `openapi.json`.
