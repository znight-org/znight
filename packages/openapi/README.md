# @znight/openapi

OpenAPI 3.1 for [Znight](../../README.md) HTTP applications, without describing the API twice.
Paths, parameters, coercion types, defaults, request and response bodies, uploads, statuses,
headers and access decisions come from the code that already runs: the route table of
`@znight/http`, the handler signatures, their **annotated return types**, their JSDoc and your
Standard Schemas (Zod, Valibot, ArkType...). A few `@Api*` decorators add what cannot be inferred.

- **Built at compile time.** `@znight/openapi/compiler` builds every operation and the JSON Schema
  of every TypeScript type, and checks them: a response that cannot be documented, a `bigint` in a
  JSON response (a guaranteed 500), duplicate operation ids or an undeclared OAuth2 scope fail the
  build with a location and a hint (ZNIGHT030–036).
- **One function, one truth.** `buildOpenApiDocument(metadata)` converts the Standard Schemas with
  their own library and assembles the document. The same pure function runs at boot, at build time
  and in tests: the served document and the committed `openapi.json` are byte-identical.
- **Served everywhere.** `OpenApiPlugin` serves `/openapi.json` (precomputed bytes, strong ETag),
  an optional YAML twin and an API reference UI (Scalar, or Swagger UI) with a strict CSP, the same
  way on the node, Fastify, Express and Hono adapters, on Node.js and Bun.

```sh
bun add @znight/openapi
bun add @scalar/api-reference   # optional: serve the UI from node_modules instead of the pinned CDN
bun add yaml                    # optional: YAML output
bun add -d @cfworker/json-schema # optional: validateResponse() in tests
```

Runs on Node.js >= 24 and Bun >= 1.3 (ESM only). `@znight/http` is a required peer dependency.

- [Quick start](#quick-start)
- [The document](#the-document)
- [Documenting operations](#documenting-operations)
- [What is inferred](#what-is-inferred)
- [Security](#security)
- [Plugin options](#plugin-options)
- [Injection](#injection)
- [Emitting openapi.json at build time](#emitting-openapijson-at-build-time)
- [Testing](#testing)
- [Diagnostics](#diagnostics)
- [Compiler contract](#compiler-contract)
- [Limitations](#limitations)

## Quick start

```ts
// src/main.ts
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

Nothing else is needed: the title, version, description and license come from `package.json`,
parameters from the signatures, request schemas from `@Body(S)`, responses from the annotated
return types and summaries from JSDoc. The compiler extension is discovered because a scanned file
(`main.ts`) imports `@znight/openapi`.

## The document

```ts
// src/api.ts
import { OpenApiDocument, securityScheme } from '@znight/openapi'
import { Public } from './auth/auth.decorators.js'

/** The `x-api-key` header checked by AuthGuard. */
export const ApiKey = securityScheme('apiKey', { type: 'apiKey', in: 'header', name: 'x-api-key' })

/**
 * Bookshelf API
 *
 * A shelf of books with a cover each. Every route needs an API key, except the public ones.
 */
@OpenApiDocument({
  info: { contact: { email: 'api@example.com' } }, // title and description: the JSDoc above
  servers: [{ url: '/api' }],
  security: [ApiKey], // default of every operation
  decisions: [{ when: Public, security: [] }], // @Public() routes need nothing
  tags: [{ name: 'Books', description: 'The shelf' }],
})
export class BookshelfApi {}
```

- One `@OpenApiDocument` per application, optional. The class is never instantiated.
- `info` precedence: the options, then the JSDoc of the class (first paragraph: `title`, the rest:
  `description`), then `package.json` (`name`, `version`, `description`, an SPDX `license`), then
  `API` / `0.0.0`.
- `securityScheme(name, definition)` declares an OpenAPI Security Scheme Object (`apiKey`, `http`,
  `oauth2`, `openIdConnect`, `mutualTLS`). The compiler reads it statically; a scheme appears in
  `components.securitySchemes` as soon as something references it.

| Option         | Default                | Description                                                                                |
| -------------- | ---------------------- | ------------------------------------------------------------------------------------------ |
| `info`         | —                      | Title, version, description, contact, license, terms of service                            |
| `servers`      | —                      | Servers of the document (else the HTTP prefix, see below)                                  |
| `tags`         | —                      | Declared tags first, in this order; the used tags are added, sorted                        |
| `externalDocs` | —                      | External documentation of the API                                                          |
| `security`     | none                   | Default requirements of every operation (entries are alternatives)                         |
| `decisions`    | `[]`                   | Security derived from route decorators (`createRouteDecorator`), see [Security](#security) |
| `operationIds` | `'controller.handler'` | `'controller.handler'` (`book.list`), `'handler'` (`list`) or `'Controller_handler'`       |
| `errors`       | `true`                 | Standard error responses; `false`, or `{ schema, contentType? }` for your own envelope     |
| `strict`       | `false`                | ZNIGHT031 and ZNIGHT032 become errors                                                      |
| `jsdoc`        | `true`                 | Read the JSDoc of controllers, handlers and types                                          |
| `extensions`   | —                      | `x-*` fields of the root object                                                            |

## Documenting operations

```ts
import { Body, Controller, Get, HttpResponse, Param, Post, Query } from '@znight/http'
import { ApiResponse, ApiTags } from '@znight/openapi'

/** Books of the shelf. */
@Controller('/books')
@ApiTags('Books')
export class BookController {
  /**
   * List books
   *
   * Sorted and paginated.
   * @param search Case-insensitive search in titles and authors.
   */
  @Get()
  async list(
    @Query('q') search?: string,
    @Query('sort') sort: BookSort = 'title',
    @Query('limit') limit = 20,
  ): Promise<Page<BookResponse>> {
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
  @ApiResponse(201, { headers: { location: { description: 'URL of the new book' } } })
  @ApiResponse(409, { description: 'A book with this ISBN is already on the shelf' })
  async create(@Body(CreateBook) input: CreateBook): Promise<HttpResponse<BookResponse>> {
    /* ... */
  }

  /** Report of the shelf */
  @Get('/report')
  @ApiResponse<ShelfReport>(200) // documents a Web Response, whose body type the compiler cannot see
  report(): Response {
    /* ... */
  }
}
```

| Decorator                                                                                          | Target             | Effect                                                                                                                             |
| -------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `@OpenApiDocument(options)`                                                                        | class              | Options of the document                                                                                                            |
| `@ApiOperation({ summary?, description?, operationId?, deprecated?, externalDocs?, extensions? })` | method             | Overrides the JSDoc and the defaults                                                                                               |
| `@ApiTags(...names)`                                                                               | class, method      | Tags (class tags first). Without any: the controller name without its `Controller` suffix                                          |
| `@ApiResponse<T>(status, { description?, schema?, contentType?, headers?, example? })`             | method, repeatable | Declares or overrides a response (`404`, `'4XX'`, `'default'`). The body type comes from `T` or from a Standard Schema in `schema` |
| `@ApiBody<T>({ description?, required?, contentType?, schema? })`                                  | method             | The body of routes that read it themselves (`ctx.parseBody()`, `ctx.bodyStream()`)                                                 |
| `@ApiQuery<T>(name, { description?, required?, deprecated?, example? })`                           | method             | A query parameter read outside the signature                                                                                       |
| `@ApiHeader<T>(name, { ... })`                                                                     | class, method      | A header read by a guard or an interceptor (`x-tenant`)                                                                            |
| `@ApiSecurity(...requirements)`                                                                    | class, method      | Security of the operations; no argument means public                                                                               |
| `@ApiExclude()`                                                                                    | class, method      | Not documented                                                                                                                     |

Every decorator is a no-op marker stripped from the bundle. Type arguments (`@ApiResponse<Book[]>`)
are erased at runtime, but the compiler reads them.

**JSDoc is the first source of text** (decorators override it):

| JSDoc                                | OpenAPI                                                                          |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| First paragraph of a handler comment | `summary`                                                                        |
| The rest                             | `description`                                                                    |
| `@deprecated` on a handler           | `deprecated: true`                                                               |
| `@param search Text`                 | `description` of the parameter (or body) the TypeScript parameter `search` feeds |
| `@returns Text`                      | `description` of the success response (default: the reason phrase)               |
| Comment of a controller              | `description` of its default tag (when it is not declared in `@OpenApiDocument`) |
| Comment of a type or property        | `description`, plus the tags below                                               |

Tags on types and properties: `@deprecated`, `@example`, `@default`, `@format` (`int32` / `int64`
make a `number` an `integer`), `@minimum`, `@maximum`, `@exclusiveMinimum`, `@exclusiveMaximum`,
`@multipleOf`, `@minLength`, `@maxLength`, `@pattern`, `@minItems`, `@maxItems`, `@uniqueItems`.
Values are JSON (`@example {"id": 1}`) or text.

## What is inferred

**Operations.** One per route and method; `:id` becomes `{id}`, a trailing `*` becomes
`{wildcard}` (`x-znight-wildcard: true`). Automatic `HEAD` / `OPTIONS` are not documented, explicit
ones are. `@All` is documented for GET, POST, PUT, PATCH and DELETE when no explicit route has the
same path (ids end with the method: `proxy.forward.get`). Paths never contain the HTTP prefix: it
belongs to `servers` (plugin `servers`, then `@OpenApiDocument({ servers })`, then
`[{ url: prefix }]`).

**Parameters.**

| Handler parameter                            | OpenAPI                                                                                        |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `@Param('id') id: number`                    | `{ name: 'id', in: 'path', required: true, schema: { type: 'number' } }`                       |
| `@Query('limit') limit = 20`                 | `{ in: 'query', schema: { type: 'number', default: 20 } }`                                     |
| `@Query('tag') tags: string[] = []`          | `style: 'form'`, `explode: true`, `schema: { type: 'array', items: { type: 'string' } }`       |
| `@Query('sort') sort: BookSort = 'title'`    | `schema: { type: 'string', enum: ['author', 'title', 'year'], default: 'title' }`              |
| `@Headers('x-tenant') tenant: string`        | `{ in: 'header', required: true }`                                                             |
| `@Cookie('theme') theme?: 'light' \| 'dark'` | `{ in: 'cookie', schema: { type: 'string', enum: ['dark', 'light'] } }` (also `@SignedCookie`) |
| `@Param('id', IdSchema)`, `@Query('q', S)`   | `schema: { $ref }` to the **input** JSON Schema of the schema                                  |
| `@Query(SearchQuery)` (whole object)         | One parameter per property of the input JSON Schema (ZNIGHT037 for a non-object schema)        |
| `@Query() q: SearchParams` (TypeScript type) | One parameter per property of the type                                                         |

Coercion plans give `string`, `number`, `integer`, `boolean`, `bigint` (`string` with a pattern),
`date` (`date-time`), enums and arrays. `Accept`, `Content-Type` and `Authorization` are never
parameters (describe credentials with a security scheme).

**Request bodies.** `@Body(S)` / `@Validate(S)`: `application/json` with the **input** schema;
`@Body() input: T`: the shape of `T` (`string`: `text/plain`, bytes: `application/octet-stream`).
Upload routes get a `multipart/form-data` object of their file fields
(`contentMediaType: application/octet-stream`, `maxItems`, `At most 2 MiB` and
`x-znight-max-size`, `encoding.contentType` from `mimeTypes`), merged with the text fields of
`@Body(Form)` (`allOf`).

**Responses.** The success status is `@HttpCode`, else 201 for POST, else 200 (204 when the
handler returns `void`). Its content comes from the annotated return type, `Promise` unwrapped:

| Return type                                                         | Success response                                                                        |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Interfaces, aliases, classes, records, arrays, unions...            | `application/json` with the schema of the type                                          |
| `HttpResponse<T>`                                                   | As `T`                                                                                  |
| `z.output<typeof S>`, `v.InferOutput<typeof S>`, ArkType `S.infer`  | The **output** JSON Schema of `S`                                                       |
| `string`                                                            | `text/plain`                                                                            |
| Bytes, streams, `Blob`, `HttpResponse<FileBody>`                    | `application/octet-stream` (set the media type with `@ApiResponse(s, { contentType })`) |
| `@Sse` routes (`AsyncIterable<SseEvent<T>>`, `AsyncGenerator`...)   | `text/event-stream`, the schema of `T` in `x-znight-event-schema`                       |
| `void`, `undefined`                                                 | No content                                                                              |
| No annotation, `unknown`, bare `HttpResponse`, `Response`, `@Res()` | ZNIGHT031, unless `@ApiResponse` documents the success status                           |

`@Header` values are documented on the success response. **Standard errors** (`errors: true`):
`400` (`#/components/responses/BadRequest`) on routes that coerce or validate an input, `413` on
routes that read a body, `415` on upload routes, and `HttpErrorBody` for every declared `4XX` /
`5XX` response without schema. A custom envelope (RFC 9457 problem details) is declared once:
`errors: { schema: ProblemDetails, contentType: 'application/problem+json' }`.

**Types → JSON Schema.** Interfaces (flattened `extends`), classes (instance fields, `toJSON()`),
aliases, enums, generics (`Page<Book>` → component `Page_Book`), records, tuples, `Partial`,
`Pick`, `Omit`... `T | null` gives `type: [T, 'null']`, unions of literals give `enum`, unions of
objects with a required literal property give `oneOf` with a `discriminator`. `Date` is a
`date-time` string and `URL` a `uri` string. Named declarations become components, named after the
declaration; Standard Schemas are named after their export, with an `XInput` variant when their
input and output JSON Schemas differ.

## Security

For each operation, the first rule that applies wins: `@ApiSecurity` on the route, on the
controller, then the first `decisions` entry whose route decorator is in the route's effective
metadata (route entries first), else the document `security`.

```ts
export const OAuth = securityScheme('oauth2', {
  type: 'oauth2',
  flows: {
    clientCredentials: {
      tokenUrl: 'https://id.example.com/oauth2/token',
      scopes: { reader: 'Read books', admin: 'Manage books' },
    },
  },
})

@OpenApiDocument({
  security: [OAuth],
  decisions: [
    { when: Public, security: [] },
    { when: Roles, security: [OAuth], scopes: 'value' }, // @Roles(['admin']) → security: [{ oauth2: ['admin'] }]
  ],
})
export class BookshelfApi {}
```

Requirements: `ApiKey` (one scheme), `[Bearer, Tenant]` (both), `{ scheme: OAuth, scopes: [...] }`;
several arguments of `@ApiSecurity` are alternatives, and `@ApiSecurity()` means public. Scopes
must be declared by a flow of the scheme and are only allowed on `oauth2` and `openIdConnect`
schemes (ZNIGHT036).

## Plugin options

`OpenApiPlugin.configure(options | (container) => options)` (name `openapi`):

| Option            | Default           | Description                                                                                                  |
| ----------------- | ----------------- | ------------------------------------------------------------------------------------------------------------ |
| `enabled`         | `true`            | `false` serves nothing and builds nothing (the `OpenApi` external still works)                               |
| `path`            | `'/openapi.json'` | JSON document, relative to the HTTP prefix                                                                   |
| `yaml`            | `false`           | A path (`'/openapi.yaml'`) serves YAML (`application/yaml`, needs `yaml`)                                    |
| `ui`              | `'scalar'`        | `'scalar'`, `'swagger'`, `false`, or `{ scalar: config }` / `{ swagger: config }` (JSON configuration)       |
| `uiPath`          | `'/docs'`         | The UI page; local assets are under `${uiPath}/_assets/`                                                     |
| `assets`          | `'auto'`          | `'local'` (from `node_modules`), `'cdn'` (jsDelivr, pinned with SRI), `'auto'` (local when installed)        |
| `document`        | `'build'`         | `{ file }` serves a prebuilt `openapi.json` (no conversion at boot; a stale file is a ZNIGHT030 warning)     |
| `build`           | `'boot'`          | `'boot'`: a failure fails `Application.create`; `'first-request'`: built lazily, one shared promise, retried |
| `info`, `servers` | —                 | Runtime overrides (`info` merged, `servers` replaced)                                                        |
| `filter`          | —                 | `(operation: OpenApiOperationView) => boolean`; unreferenced components are pruned                           |
| `transform`       | —                 | `(document) => document`, last-resort escape hatch                                                           |
| `converters`      | `[]`              | Extra `SchemaConverter`s, tried before the built-in ones                                                     |
| `unrepresentable` | `'error'`         | `'warn'`: a schema that cannot be converted becomes `{}` with a ZNIGHT037 warning                            |
| `meta`            | `[]`              | Route metadata of the docs routes (`[Public.meta()]`), seen by guards and by the route decision check        |
| `guards`          | `[]`              | Extra guards of the docs routes (global guards still run first)                                              |
| `cacheControl`    | `'no-cache'`      | `cache-control` of the document (revalidated with the ETag)                                                  |

```ts
OpenApiPlugin.configure(container => ({
  enabled: container.get(ServerConfig).docs, // DOCS=false hides the documentation
  meta: [Public.meta()], // the access group of @znight/http route decisions is required: the docs are public
  ui: { scalar: { theme: 'purple' } },
  document: process.env['NODE_ENV'] === 'production' ? { file: new URL('./openapi.json', import.meta.url) } : 'build',
}))
```

The docs routes are **plugin routes** of `@znight/http`: they go through the same pipeline as the
controllers (`http:request` hook, request scope, global guards, then `guards`), are listed in
`HttpPlugin.routes` with `source: 'openapi'`, and a collision with a controller route is ZNIGHT007.
The document is served from precomputed bytes with a strong ETag (`if-none-match` → 304, `HEAD`
included). The UI page has its own `content-security-policy` (`default-src 'none'`, the inline
script allowed by hash, `connect-src` limited to the document's servers); Scalar runs without its
fonts, telemetry nor proxy, Swagger UI without its validator. With local assets nothing is loaded
from a third party; otherwise only the pinned jsDelivr files, with Subresource Integrity.

Logs: `OpenAPI document built` (debug: operations, schemas, ms), each assembly warning once,
`API reference: <address>/docs` when the server listens. Exclude the docs from request logs with
`logging.requests.ignore: e => e.route?.startsWith('/docs')`.

## Injection

```ts
import { Injectable, type OnReady } from '@znight/core'
import { OpenApi } from '@znight/openapi'

/** Publishes the contract to the API gateway once the service is ready. */
@Injectable()
export class GatewayRegistration implements OnReady {
  constructor(
    private readonly openapi: OpenApi,
    private readonly gateway: GatewayClient,
  ) {}

  async onReady(): Promise<void> {
    await this.gateway.publish(await this.openapi.json())
  }
}
```

`OpenApi` (singleton external, token `@znight/openapi#OpenApi`): `document()`, `json()`, `yaml()`
and `operations` (`OpenApiOperationView`: method, path, operation id, tags, controller, handler,
effective route metadata).

## Emitting openapi.json at build time

```sh
znight openapi                      # writes openapi.json at the project root
znight openapi -o docs/openapi.yaml # YAML, chosen by the extension (needs yaml)
znight openapi --check              # CI: exit 1 when the file is missing or stale; never writes
znight openapi --prefix /api        # servers default when @OpenApiDocument declares none
znight openapi --runtime bun        # load the modules with Bun (default: the runtime running the CLI)
znight build --openapi              # after the bundle: dist/openapi.json, next to dist/main.js
```

```ts
// vite.config.ts
import { znight } from '@znight/compiler'
import { openapi } from '@znight/openapi/vite'
import { defineConfig } from 'vite'
import options from './znight.config.ts'

export default defineConfig({
  plugins: [
    znight(options),
    // after the bundle is written (and after each good rebuild of znight dev); default output: dist/openapi.json
    openapi({ output: ['openapi.json', 'dist/openapi.json'], check: process.env['CI'] === 'true' }),
  ],
})
```

```ts
// programmatic API, used by the CLI and the Vite plugin
import { emitOpenApi } from '@znight/openapi/emit'

const result = await emitOpenApi({ root: process.cwd(), output: 'openapi.json', check: false, runtime: 'auto' })
// { ok, written, stale, staleFiles, document, diagnostics, warnings, outputs, runtime }
```

Emission compiles the application like `znight generate` (`znight.config.*`, else the `znight()`
plugin of the Vite config; compile errors stop it before any module runs), then loads the
generated module in a **child process** (Bun: the compiler preload; Node.js: a Vite server in
middleware mode), so module side effects never reach the CLI or Vite process. Nothing is
instantiated: no container, no plugin, no port; `NODE_ENV` defaults to `production`. Outputs are
written atomically, only when they changed; the file is byte-identical on Node.js and Bun.

Custom converters are runtime functions: emission loads them from a module whose default export is
a `SchemaConverter[]` (`--converters src/openapi.converters.ts`, `openapi({ converters })`).

**Commit `openapi.json` and check it in CI** (`znight openapi --check`): an API change shows up in
the pull request diff, and clients can be generated from the file without starting anything.

## Testing

`@znight/testing` needs nothing special: `TestApp` boots the plugin, `app.get(OpenApi)` reaches the
document.

```ts
import { OpenApi } from '@znight/openapi'
import { validateResponse } from '@znight/openapi/testing'

test('GET /books/:id answers what its documentation says', async () => {
  await using app = await createTestApp() // the plugins of main.ts, with OpenApiPlugin.configure({ ui: false })
  const document = await app.get(OpenApi).document()
  const response = await app.inject({ method: 'GET', url: '/books/1', headers: { 'x-api-key': READER_KEY } })
  expect(validateResponse(document, { method: 'GET', path: '/books/{id}', response })).toEqual([])
})
```

```ts
import { buildOpenApiDocument } from '@znight/openapi'

test('the committed openapi.json is up to date', async () => {
  const { json } = await buildOpenApiDocument(__ZNIGHT_METADATA__)
  expect(json).toBe(await Bun.file(new URL('../openapi.json', import.meta.url)).text())
})
```

`validateResponse(document, { method, path, response })` returns `{ path, message, keyword }[]`
issues: the status must be documented (exact code, then `NXX`, then `default`), the media type
documented (ranges included), documented `required` headers present and a JSON body valid against
its schema (JSON Schema 2020-12 with the optional peer `@cfworker/json-schema`: no code generation,
so it runs on Bun, Node.js and edge runtimes). `response` is an `InjectResponse` or a
`{ status, headers, body }` object.

## Diagnostics

| Code      | Name                         | When                                                                                                                                                                                                                                                                                                                     | Severity                                       |
| --------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| ZNIGHT030 | `InvalidOpenApiDefinition`   | Invalid `@OpenApiDocument` options or a second one, `@Api*` outside a controller or route handler, invalid static values, a malformed `securityScheme()`, the reserved `$znight` key. At runtime: invalid plugin options, a missing OpenAPI section, a stale prebuilt file, servers not reflecting the prefix (warnings) | error / warning                                |
| ZNIGHT031 | `UndocumentedResponse`       | The success response cannot be documented and no `@ApiResponse` covers it                                                                                                                                                                                                                                                | warning (error with `strict`)                  |
| ZNIGHT032 | `UnrepresentableType`        | A documented type has no JSON Schema or does not serialise as declared; a `bigint` in a JSON response is always an error                                                                                                                                                                                                 | warning / error                                |
| ZNIGHT033 | `DuplicateOperationId`       | Two operations with the same id                                                                                                                                                                                                                                                                                          | error                                          |
| ZNIGHT034 | `SchemaNameConflict`         | Two declarations or schemas for one component name (at compile time, or at assembly for hoisted `$defs` and `XInput` names)                                                                                                                                                                                              | error                                          |
| ZNIGHT035 | `InconsistentOperation`      | The documentation contradicts the route: a body on 204/304, another success status than the route's, `@ApiQuery('x')` next to `@Query('x')`, a documented `Accept` / `Content-Type` / `Authorization` header, `@ApiBody` next to a body schema, `@ApiBody` on GET/HEAD and `@ApiExclude` with other `@Api*` (warnings)   | error / warning                                |
| ZNIGHT036 | `InvalidSecurityRequirement` | A requirement that is not a `securityScheme()`, misplaced or undeclared scopes, one scheme name for two definitions, an invalid decision, a decision never applied (warning)                                                                                                                                             | error / warning                                |
| ZNIGHT037 | `SchemaConversionFailed`     | At assembly: no converter for a schema, a converter that throws or returns something else than an object, a whole-object query schema that is not an object                                                                                                                                                              | error (warning with `unrepresentable: 'warn'`) |

```text
✗ ZNIGHT032: ShelfStats.total is a bigint: JSON.stringify throws on bigint, so GET /books/stats (BookController.stats) would answer 500
  --> src/books/book.ts:58:19
   = hint: Return a number or a string (String(total)), or give the type a toJSON() method
```

## Compiler contract

`@znight/openapi/compiler` reads the data stored by `@znight/http/compiler` (`graph.extensions`,
see "Compiler contract for other extensions" in the `@znight/http` README) and the shapes of the
compiler (`ctx.types.shape()`), and generates `metadata.extensions.openapi` (types exported from
`@znight/openapi`):

```ts
interface OpenApiMetadata {
  readonly version: 1
  /** SHA-256 (base64url) of the section, schema values replaced by their names (stale-file detection). */
  readonly fingerprint: string
  /** openapi ('3.1.1'), info, servers?, tags?, externalDocs?, security?, x-*. */
  readonly document: OpenApiDocumentTemplate
  /** Sorted by path, then method; `operation` holds schema templates. */
  readonly operations: readonly OpenApiOperationDefinition[]
  /** JSON Schemas of TypeScript declarations, by component name (sorted). */
  readonly components: Readonly<Record<string, SchemaTemplate>>
  readonly securitySchemes: Readonly<Record<string, SecuritySchemeObject>>
  /** Standard Schemas (imported values) converted at assembly, sorted by name. */
  readonly schemas: readonly OpenApiSchemaSlot[] // { name, schema, io, source }
  readonly errors?: { readonly contentType: string; readonly schema?: string }
  /** Descriptions of the default tags (JSDoc of the controllers). */
  readonly tagDescriptions?: Readonly<Record<string, string>>
}
```

Where a schema is expected, the compiler writes JSON Schema or a placeholder
`{ $znight: 'schema', name, io }`; in `parameters`, `{ $znight: 'parameters', in, name, io: 'input' }`
expands to one parameter per property. The `$znight` key is reserved. The manifest declares the
extension and the `OpenApi` external:

```jsonc
"znight": {
  "apiVersion": 1,
  "compiler": "@znight/openapi/compiler",
  "provides": [{ "export": "OpenApi", "plugin": "OpenApiPlugin", "scope": "singleton" }]
}
```

## Limitations

- OpenAPI 3.1.1 only (3.2 with `itemSchema` for streams is planned behind an option).
- Return types must be annotated: the compiler does not run the TypeScript checker.
- Controllers of compiled provider libraries are documented from their `.d.ts` signatures; their
  `@Api*` decorators are not read yet.
- One document per application (use `filter` to hide operations).
- Error responses are not inferred from `throw` statements: declare them with `@ApiResponse`.
