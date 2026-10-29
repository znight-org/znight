---
description: "@znight/openapi - OpenAPI 3.1 documents generated from your controllers at build time, checked by the compiler, served with Scalar or Swagger UI on every HTTP adapter."
---

# @znight/openapi <Badge type="tip" text="available" />

An **OpenAPI 3.1** document for your `@znight/http` application, without describing the API twice.
Paths, parameters, coercion types, defaults, schemas, statuses, uploads and access decisions come
from the code that already runs; a few `@Api*` decorators and your JSDoc add what cannot be
inferred.

1. **At build time**, the compiler extension reads the route table, the handler signatures, their
   JSDoc and the annotated return types, turns TypeScript types into JSON Schema 2020-12 and checks
   everything: a response that cannot be documented, a `bigint` in a JSON response, a duplicate
   operation id or an unknown OAuth scope is a build error with a location and a hint.
2. **When the document is assembled**, the schemas only their library knows (Zod, Valibot, ArkType...)
   are converted by that library, through [Standard JSON Schema](https://standardschema.dev/json-schema):
   input schemas for requests, output schemas for responses. The compiler never runs your code.
3. **At runtime**, `OpenApiPlugin` serves `GET /openapi.json` (precomputed bytes, strong ETag) and an
   API reference UI (Scalar by default, Swagger UI as an option) through `@znight/http`, identically on
   the node, Fastify, Express and Hono adapters, on Node.js 24+ and Bun 1.3+.

```sh
npm install @znight/openapi
npm install @scalar/api-reference     # optional: serve the UI from node_modules instead of a pinned CDN
npm install @valibot/to-json-schema   # optional: Valibot schemas (Zod and ArkType need nothing)
```

```ts [src/main.ts]
import { Application } from '@znight/core'
import { HttpPlugin } from '@znight/http'
import { OpenApiPlugin } from '@znight/openapi'
import { __ZNIGHT_METADATA__ } from './.znight/container.generated.js'

const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins: [HttpPlugin.configure({ port: 3000 }), OpenApiPlugin.configure()],
})
await app.start() // GET /openapi.json, GET /docs
```

Nothing else is needed: the title, version and description come from `package.json`, there is one
operation per route, and the compiler extension is discovered because a scanned file imports
`@znight/openapi`.

## What is inferred

| From your code                                                         | In the document                                                              |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Routes (`fullPath`, `:id` → `{id}`), the HTTP `prefix`                 | `paths`; the prefix goes to `servers`                                        |
| `@Param`, `@Query`, `@Headers` with their declared types and defaults  | parameters, with the schema of the coercion (`limit = 20` → `default`)       |
| `@Cookie`, `@SignedCookie`                                             | `in: cookie` parameters                                                      |
| `@Body(S)` / `@Validate(S)`, upload parameters                         | `requestBody`: the **input** schema of `S`, or `multipart/form-data`         |
| The annotated return type (`Promise<BookResponse>`, `HttpResponse<T>`) | the success response: status, media type and schema                          |
| `@Sse` routes (`AsyncIterable<SseEvent<T>>`)                           | a `text/event-stream` response, the schema of `T` in `x-znight-event-schema` |
| `z.output<typeof S>` and its Valibot and ArkType equivalents           | the **output** schema of `S`                                                 |
| JSDoc of handlers, controllers, interfaces and properties              | `summary`, `description`, `deprecated`, schema descriptions                  |
| Route decisions (`@Public()`, `@Roles(...)`)                           | `security`, through the `decisions` of the document                          |
| Routes that coerce, validate, read a body or upload files              | the standard `400`, `413` and `415` error responses                          |

Return types must be **annotated**: the compiler reads types, it does not infer them from method
bodies. A route whose success response cannot be documented is
[`ZNIGHT031`](/reference/error-codes#znight031), unless an `@ApiResponse` covers it.

The success response follows what the serialiser sends:

- strings, string literals and string enums are `text/plain`, the rest `application/json` (a
  `string | null` return gets both);
- `HttpResponse<A> | HttpResponse<B>` documents `A | B`, its status chosen at runtime (declare the
  other 2XX with `@ApiResponse`);
- `T | undefined` adds an empty `204`, which the runtime sends for `undefined` (not on POST nor
  with `@HttpCode`);
- `HttpResponse.sse()` is a `200` `text/event-stream` response, even on POST (unless `@HttpCode`);
- a body with `@HttpCode(204)` or `304` is an error
  ([`ZNIGHT035`](/reference/error-codes#znight035)): the body would never be sent.

## Documenting operations

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

| Decorator                                                     | Purpose                                                                    |
| ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `@OpenApiDocument(options)`                                   | Options of the document (one per application, optional)                    |
| `@ApiOperation({ summary, operationId, ... })`                | Overrides the JSDoc and the defaults of an operation                       |
| `@ApiTags(...names)`                                          | Tags of a controller or a route (default: the controller name)             |
| `@ApiResponse<T>(status, { description, schema })`            | Declares or overrides a response; the body type comes from `T` or `schema` |
| `@ApiBody<T>(...)`, `@ApiQuery<T>(...)`, `@ApiHeader<T>(...)` | What a handler reads outside its signature (`ctx.rawBody()`, `ctx.query`)  |
| `@ApiSecurity(...requirements)`                               | Security of a controller or route; no argument means public                |
| `@ApiExclude()`                                               | Leaves a controller or route out of the document                           |

Like every Znight decorator, they are markers: the compiler reads them (type arguments included),
and they are stripped from the bundle.

## The document and its security

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

The title and description come from the JSDoc of the class. Schemes are declared with
`securityScheme()` and referenced by value, so a typo is a compile error; `decisions` map the
[route decisions](/guide/security#route-decisions) of your guards to OpenAPI security requirements.

## Plugin options

`OpenApiPlugin.configure(options)`, or a function of the container:

| Option           | Default           | Description                                                                      |
| ---------------- | ----------------- | -------------------------------------------------------------------------------- |
| `enabled`        | `true`            | `false` serves nothing (e.g. on a public deployment)                             |
| `path`           | `'/openapi.json'` | The JSON document, relative to the HTTP prefix                                   |
| `yaml`           | `false`           | A path (`'/openapi.yaml'`) also serves YAML (optional peer `yaml`)               |
| `ui`             | `'scalar'`        | `'scalar'`, `'swagger'` or `false`                                               |
| `uiPath`         | `'/docs'`         | The page of the API reference UI                                                 |
| `document`       | `'build'`         | `{ file }` serves an `openapi.json` emitted at build time: no conversion at boot |
| `meta`, `guards` | `[]`              | Route metadata and guards of the documentation routes                            |

The documentation routes go through the same pipeline as your controllers: the `http:request`
hook, the global guards, then the `guards` of the option. When your application has a required
access group, give them a decision:

```ts
OpenApiPlugin.configure({ meta: [Public.meta()] }) // the documentation is public
```

The complete reference (every option, converters, the assembly function, the compiler contract) is
the [package README](../../packages/openapi/README.md).

## Emitting `openapi.json`

The document can also be written at build time, without starting the application: commit it, and
an API change shows up in the pull request diff; clients are generated from the file.

```sh
znight openapi                      # writes openapi.json at the project root
znight openapi -o docs/openapi.yaml # YAML, chosen by the extension (needs yaml)
znight openapi --check              # CI: exit 1 when the file is missing or stale; never writes
znight openapi --prefix /api        # servers default when @OpenApiDocument declares none
znight build --openapi              # after the bundle: dist/openapi.json, next to dist/main.js
znight build --openapi --openapi-prefix /api # the same, with the HTTP prefix as servers default
```

Paths in the document never contain the HTTP prefix: it belongs to `servers`. When `HttpPlugin`
has a `prefix` and `@OpenApiDocument` declares no `servers`, pass the prefix when you emit the file
(`--prefix` for `znight openapi`, `--openapi-prefix` for `znight build --openapi`, `prefix` for the
`openapi()` Vite plugin): the file then has the `servers` of the document the application serves,
and clients generated from it call the right paths. `--openapi-prefix` needs `--openapi`, and when
your Vite config registers its own `openapi()` plugin, the CLI warns that the flags do not apply:
set `openapi({ output, prefix })` there instead.

Emission compiles the application like `znight generate` (compile errors stop it before any module
runs), then loads the generated module in a child process and assembles the document with the same
function as the plugin: nothing is instantiated, and the file is byte-identical on Node.js and Bun.
The `openapi()` Vite plugin of `@znight/openapi/vite` does the same after each build, and
`emitOpenApi()` of `@znight/openapi/emit` is the programmatic API.

In production, serve the emitted file to skip the schema conversion at boot:

```ts
OpenApiPlugin.configure({ document: { file: new URL('./openapi.json', import.meta.url) } })
```

The plugin options `info`, `servers`, `filter` and `transform` apply to the file as to a build. A
file emitted from another build of the application is reported at boot, and so is a file without
`servers` under an HTTP prefix: it is then served with `[{ url: prefix }]`
([`ZNIGHT030`](/reference/error-codes#znight030) warnings).

## Testing

`TestApp` boots the plugin like any other; the `OpenApi` provider gives the document:

```ts
import { OpenApi } from '@znight/openapi'
import { validateResponse } from '@znight/openapi/testing'

test('the served document is the one of the OpenApi provider', async () => {
  await using app = await createTestApp()
  const served = await app.inject({ url: '/openapi.json' })
  expect(served.status).toBe(200)
  expect(served.json()).toEqual(await app.get(OpenApi).document())
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
tested, not only the code.

## Diagnostics

| Code                                            | Meaning                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------- |
| [`ZNIGHT030`](/reference/error-codes#znight030) | Invalid OpenAPI definition (options, decorator usage, plugin setup) |
| [`ZNIGHT031`](/reference/error-codes#znight031) | Undocumented response (warning, error with `strict`)                |
| [`ZNIGHT032`](/reference/error-codes#znight032) | Unrepresentable type (a `bigint` in a JSON response is an error)    |
| [`ZNIGHT033`](/reference/error-codes#znight033) | Duplicate operation id                                              |
| [`ZNIGHT034`](/reference/error-codes#znight034) | Schema name conflict                                                |
| [`ZNIGHT035`](/reference/error-codes#znight035) | The documentation contradicts the route                             |
| [`ZNIGHT036`](/reference/error-codes#znight036) | Invalid security requirement                                        |
| [`ZNIGHT037`](/reference/error-codes#znight037) | A schema could not be converted while the document was assembled    |
