# RFC 0002: OpenAPI in Znight v0.1 (`@znight/openapi`)

|           |                                                                                                                                                                                                                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status    | Accepted (v0.1)                                                                                                                                                                                                                                                                                                                       |
| Date      | 2026-10-27                                                                                                                                                                                                                                                                                                                            |
| Affects   | New `@znight/openapi`. Prerequisites in `@znight/compiler` (type shapes, JSDoc, decorator type arguments, parameter initialisers), `@znight/http` (plugin routes, `prefix`, `RouteDecorator.meta()`, compiler contract), `@znight/core` (ZNIGHT030–037), `@znight/cli` (`znight openapi`, `build --openapi`), docs, a wave 7 example  |
| Interplay | Works without RFC 0001 (security) and RFC 0006 (cookies, SSE). When they land, `decisions` follows the RFC 0001 "nearest decision" rule, the docs routes carry an `access` decision, and `@Cookie` / `@Sse` are documented (§5.4)                                                                                                     |
| Decision  | **Ship `@znight/openapi` in v0.1.** The compiler builds the whole operation model and every JSON Schema it can derive from TypeScript, and checks it. Standard Schemas are converted by their own library, through Standard JSON Schema, when the document is assembled (at boot, at build time, in tests), never inside the compiler |

## 1. Summary

`@znight/openapi` turns a Znight HTTP application into an **OpenAPI 3.1 document** without asking
anyone to describe the API twice. It works in three steps, each with one owner:

1. **Compile time: the operation model (the compiler extension `@znight/openapi/compiler`).** It
   reads the route table that `@znight/http/compiler` already builds (methods, paths, parameters with
   their coercion plans, Standard Schema references, uploads, statuses, headers, route metadata),
   the handler signatures and their JSDoc, and a few `@Api*` decorators. It produces every
   operation: parameters with types and defaults, request bodies (JSON, `multipart/form-data`),
   responses inferred from **annotated return types**, security, tags and operation ids.
   TypeScript types become JSON Schema 2020-12 inside the compiler, through a new oxc-based **shape
   resolver** (no type checker). Mistakes are build errors with a location and a hint: a response
   that cannot be documented, a type that does not serialise as declared (a `bigint` in a JSON
   response is a guaranteed 500), duplicate operation ids, schema name clashes, unknown scopes.
2. **Assembly: the schemas only their library knows.** A Zod or Valibot schema is a runtime value.
   `buildOpenApiDocument(metadata)` converts the referenced schemas through the
   [Standard JSON Schema](https://standardschema.dev/json-schema) interface
   (`schema['~standard'].jsonSchema.input/output({ target: 'draft-2020-12' })`), with an
   `@valibot/to-json-schema` fallback and user converters. It hoists `$defs` into
   `components.schemas`, fills the placeholders left by the compiler and freezes the result. It is
   a pure function, and the same one runs at boot (`OpenApiPlugin`), at build time (`znight openapi`,
   `znight build --openapi`, the `openapi()` Vite plugin) and in tests. So the served document and
   the committed `openapi.json` are byte-identical, and that is tested.
3. **Serving.** `OpenApiPlugin` serves `GET /openapi.json` (precomputed bytes, strong ETag), an
   optional YAML twin and an API reference UI (Scalar by default, Swagger UI as an option). It plugs
   into `@znight/http` through a new generic **plugin routes** contract, so it behaves the same on the
   node, Fastify, Express and Hono adapters, on Node.js 24 and Bun. In production it can serve the
   file emitted at build time instead: then no conversion code runs at boot.

The compiler never executes user code, so `compile()` stays pure, deterministic and incremental.
What the compiler cannot know (the JSON Schema of a Zod object) is computed by the only code that
does know it (Zod), in one well-tested function.

## 2. What exists today (checked against the code)

| Fact                                                                                                                                                                                                                                                                    | Where                                                                                        | Consequence                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| The runtime route table holds `method`, `path`, `fullPath` (without the plugin prefix), `params[]` (`source`, `name`, readable `type`, `optional`, `schema: boolean`), `status`, `headers`, `meta`, `uploads`, `bodyLimit`                                              | `packages/http/src/metadata.ts`                                                              | The runtime metadata says _that_ a parameter has a schema, not _which_ one: the OpenAPI section must import the schemas itself |
| The http extension stores much more: `HttpParamData.schema: ValueRef`, `coercion: ParamCoercion` (plans with enum values), `bodySchema` (`@Validate`), `UploadData`, `MetaEntry`, locations. The types are exported from `@znight/http/compiler`                        | `packages/http/src/compiler/model.ts`, `index.ts`                                            | Another extension can reuse this data through `graph.extensions` (`{ name, stored: unknown[] }`, untyped)                      |
| In `validate`, an extension gets `classInfo(identity)`: `MethodInfo.returnType` (**annotated** types only), `ParameterInfo.type`, `hasDefault` (but not the default value), and `DecoratorInfo.node` as an escape hatch. There is no JSDoc                              | `packages/compiler/src/extensions/api.ts`                                                    | Return types must be annotated. JSDoc, defaults and decorator type arguments need small API additions (§9.1)                   |
| `TypeInfo` models references, unions, arrays, tuples and promises. Object literal types, mapped and conditional types and `typeof` are `opaque`. Interfaces are references without members. Aliases are expanded, so `z.output<typeof S>` becomes an opaque conditional | `packages/compiler/src/project/types.ts`, `type-resolver.ts:328`                             | The compiler has no structural model of DTOs. It needs a shape resolver working on declarations (§6.2)                         |
| The compiler never runs application code. `compile()` only reads sources and is deterministic                                                                                                                                                                           | architecture §3.3, §6.2                                                                      | Standard Schema values cannot be converted inside the compiler                                                                 |
| Zod 4.6.7 (catalog) implements Standard JSON Schema: `~standard.jsonSchema.input/output({ target, libraryOptions })`. `libraryOptions` is spread into the generator options, and `unrepresentable` may be a function                                                    | `zod@4.6.7/.../v4/core/standard-schema.d.ts`, `to-json-schema.js:645`, `to-json-schema.d.ts` | Zod needs no adapter, and dates can be mapped for responses (§7.3)                                                             |
| Valibot 1.5.0 (devDependency of http) does not expose `~standard.jsonSchema` in its types                                                                                                                                                                               | `valibot@1.5.0/dist/index.d.mts`                                                             | Valibot goes through `toStandardJsonSchema()` of `@valibot/to-json-schema` (≥ 1.5, per standardschema.dev)                     |
| `HttpResponse<T>` is generic. `HttpResponse.file()` returns `HttpResponse<FileBody>`. `created<T = undefined>(body?: T)` returns `HttpResponse<T \| undefined>`                                                                                                         | `packages/http/src/response.ts`                                                              | Body types can be read from the annotation. `created` needs an overload for nice annotations (§9.2)                            |
| JSON bodies are serialised with `JSON.stringify(payload)`, without a replacer                                                                                                                                                                                           | `packages/http/src/serialize.ts:186`                                                         | `bigint` throws (500), and `Map`/`Set` become `{}`. The compiler can report both                                               |
| A plugin cannot add an HTTP route. The http options are resolved in `onBootstrap` only                                                                                                                                                                                  | `packages/http/src/plugin.ts`                                                                | A plugin routes contract and a `prefix` getter are prerequisites (§9.2)                                                        |
| `createRouteDecorator(key)` returns a function with `key` and `get`. `MetaEntry` stores the key, not the identity of the decorator                                                                                                                                      | `decorators.ts:327`, `compiler/model.ts`                                                     | Mapping `@Public()` to `security: []` needs that identity (§9.2)                                                               |
| The last code is ZNIGHT022, and RFC 0001 takes ZNIGHT023                                                                                                                                                                                                                | `packages/core/src/errors.ts`                                                                | 030 and above are free. This RFC reserves 030–039                                                                              |
| Plugins are known when `Application.create` starts (`ctx.app.plugins`, `getPlugin`)                                                                                                                                                                                     | `packages/core/src/application.ts`                                                           | Route contributions can be pulled by HttpPlugin, whatever the plugin order                                                     |
| `TestApp.inject()`, `TestApp.get(key)`, plugin roots (`initRoots()`)                                                                                                                                                                                                    | `packages/testing`, architecture §10                                                         | `@znight/testing` needs no change                                                                                              |

## 3. Goals and non-goals

**Goals**

- **G1. Nothing written twice.** Paths, parameters, coercion types, defaults, schemas, statuses,
  headers, uploads and access decisions come from the code that already runs. Decorators only add
  what cannot be inferred.
- **G2. Build-time guarantees.** Every documented operation is checked by the compiler (codes,
  locations, hints). `znight openapi --check` turns any API drift into a CI failure.
- **G3. Correct and stable.**
  - The document is valid OpenAPI 3.1.1, checked against the official schema in tests.
  - It is deterministic: byte-identical across runs, operating systems, Node and Bun, source and
    `dist`.
  - It describes the wire: the **input** JSON Schema for requests, the **output** one for responses.
- **G4. Fast.**
  - Zero work per request (precomputed bytes).
  - At boot: a bounded cost (target < 25 ms for 150 schemas), or none with a prebuilt file.
  - At compile time: at most 15% overhead on the benchmark fixture.
- **G5. Library neutral.** Any Standard Schema library that implements Standard JSON Schema (Zod ≥
  4.2, ArkType ≥ 2.1.28...), Valibot through its official package, anything else through a
  converter.
- **G6. Portable.** The same behaviour on the four adapters, on Node.js 24 and Bun ≥ 1.3.
- **G7. Easy.** `OpenApiPlugin.configure()` alone gives `/openapi.json` and `/docs`.

**Non-goals for v0.1**

- Swagger 2.0 or OpenAPI 3.0 output. OpenAPI 3.2 output is open question Q1.
- Running the TypeScript type checker, or documenting types the compiler cannot see (return types
  inferred from the body of a method).
- `class-validator` / `class-transformer` DTOs and an `@ApiProperty` decorator. Types are documented
  with TypeScript and JSDoc.
- Validating requests or responses against the document at runtime. Validation stays the Standard
  Schema of `invoke`. The document is used for validation in tests only (§5.9).
- Webhooks, callbacks, links, several documents per application (one document plus `filter` is the
  v0.1 answer), and per-route content negotiation.
- Generating clients. `openapi.json` feeds openapi-typescript, Hey API, Orval... (wave 7 shows one).
- Contract-first: generating controllers from a document.
- Inferring error responses from `throw` statements.
- AsyncAPI for `@znight/messaging`. The shape resolver will serve it later.

## 4. Decisions

| #   | Decision                                                                                                                                                  | Why                                                                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | A separate, first-party package                                                                                                                           | It brings UI assets, converters, emission tooling and optional peers that workers and most services do not need. It must be first-party because it reads the http compiler data and needs compiler changes |
| D2  | The compiler computes the operation model and the JSON Schemas of TypeScript types. It never executes code                                                | This keeps principles 1 and 7 (compile-time, fail early) and the guarantees of §3.3 (determinism, incremental compiles)                                                                                    |
| D3  | Standard Schemas are converted by their library through Standard JSON Schema when the document is assembled. Requests use `input`, responses use `output` | Only Zod knows what `.transform()`, `.default()` or `.refine()` mean. Standard JSON Schema is the vendor-neutral API for it, and Zod, ArkType and Valibot (through its package) ship it                    |
| D4  | One function, `buildOpenApiDocument`, for boot, emission and tests                                                                                        | One code path gives a single truth: the served document equals the emitted one                                                                                                                             |
| D5  | Document options live in the sources (`@OpenApiDocument`, `securityScheme()`), not in a config file                                                       | The compiler resolves them by identity and checks them. Typos in scheme names are impossible                                                                                                               |
| D6  | `@znight/http` gets a generic, pull-based plugin routes contract                                                                                          | It is identical on every adapter and independent of plugin order. Health and metrics endpoints can use it later                                                                                            |
| D7  | Codes 030–039 are reserved for this package. Generic problems reuse ZNIGHT005/007/017/018                                                                 | It follows the precedent of messaging (011) and config (012), each with its own catch-all                                                                                                                  |
| D8  | The default UI is Scalar. Its assets are served locally when installed, otherwise from a pinned CDN with SRI, under a strict CSP                          | It supports OpenAPI 3.1 natively, has a built-in client, needs one script, and leaks nothing by default                                                                                                    |

## 5. User-facing API

### 5.1 Install and quick start

```sh
bun add @znight/openapi
bun add @scalar/api-reference   # optional: serve the UI from node_modules instead of the pinned CDN
```

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

Nothing else is needed:

- the title, version and description come from `package.json`;
- there is one operation per route;
- parameters come from the signatures, request schemas from `@Body(S)`, and responses from the
  annotated return types;
- summaries come from JSDoc.

The compiler extension is discovered because a scanned file (`main.ts`) imports `@znight/openapi`
(architecture §6.5).

### 5.2 The document: `@OpenApiDocument` and `securityScheme()`

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

- **One `@OpenApiDocument` per application, and it is optional.** The class is never instantiated
  nor registered as a provider, and its body is ignored.
- **`info` defaults, by precedence:**

  | Field         | Options            | JSDoc of the class | `package.json`                             | Fallback |
  | ------------- | ------------------ | ------------------ | ------------------------------------------ | -------- |
  | `title`       | `info.title`       | first line         | `name`                                     | —        |
  | `version`     | `info.version`     | —                  | `version`                                  | `0.0.0`  |
  | `description` | `info.description` | the rest           | `description`                              | —        |
  | `license`     | `info.license`     | —                  | an SPDX `license` (`{ name, identifier }`) | —        |

- **`securityScheme(name, definition)`** declares a scheme. The compiler reads it statically (like
  `createRouteDecorator`). At runtime it returns a frozen `{ name, definition }`.
  - `definition` is an OpenAPI Security Scheme Object: `apiKey`, `http`, `oauth2`, `openIdConnect`
    or `mutualTLS`.
  - Two different definitions with the same name give ZNIGHT036.
  - A scheme appears in `components.securitySchemes` as soon as something references it.

```ts
export interface OpenApiDocumentOptions {
  readonly info?: Partial<InfoObject>
  readonly servers?: readonly ServerObject[]
  readonly tags?: readonly TagObject[] // declared tags first, in this order; used tags are added, sorted
  readonly externalDocs?: ExternalDocumentationObject
  /** Default requirements of every operation: entries are alternatives (OR). Default: none. */
  readonly security?: readonly SecurityRequirementInput[]
  /** Security derived from route decorators; the first matching entry wins (§5.5). */
  readonly decisions?: readonly SecurityDecision[]
  /** Ids of operations without @ApiOperation({ operationId }). Default 'controller.handler'. */
  readonly operationIds?: 'controller.handler' | 'handler' | 'Controller_handler'
  /** Standard error responses (§5.4.4). Default true. */
  readonly errors?: boolean | { readonly schema: StandardSchemaV1; readonly contentType?: string }
  /** ZNIGHT031 and ZNIGHT032 become errors. Default false. */
  readonly strict?: boolean
  /** Read the JSDoc of controllers, handlers and types. Default true. */
  readonly jsdoc?: boolean
  /** `x-*` fields of the root object. */
  readonly extensions?: Readonly<Record<`x-${string}`, JsonValue>>
}

export interface SecurityDecision {
  /** A route decorator (createRouteDecorator) found in the route's effective metadata. */
  readonly when: RouteDecorator<unknown>
  /** Requirements of the matching routes; `[]` means public. */
  readonly security: readonly SecurityRequirementInput[]
  /** 'value': the decorator value (a static string array) becomes the scopes of every requirement. */
  readonly scopes?: 'value'
}

/** One scheme, several schemes that all apply (AND), or a scheme with scopes. */
export type SecurityRequirementInput =
  | SecurityScheme
  | readonly SecurityScheme[]
  | { readonly scheme: SecurityScheme; readonly scopes: readonly string[] }
```

### 5.3 Documenting operations

| Decorator                                                                                          | Target             | Arguments              | Effect                                                                                                                                                |
| -------------------------------------------------------------------------------------------------- | ------------------ | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@OpenApiDocument(options)`                                                                        | class              | value                  | Options of the document (§5.2)                                                                                                                        |
| `@ApiOperation({ summary?, description?, operationId?, deprecated?, externalDocs?, extensions? })` | method             | static                 | Overrides the JSDoc and the defaults                                                                                                                  |
| `@ApiTags(...names)`                                                                               | class, method      | static                 | Tags. Class and method tags are merged, class tags first. Without any, the tag is the controller name without its `Controller` suffix                 |
| `@ApiResponse<T>(status, { description?, schema?, contentType?, headers?, example? })`             | method, repeatable | static, `schema` value | Declares or overrides a response. `status` is a code, `'2XX'`-like or `'default'`. The body type comes from `T` or from a Standard Schema in `schema` |
| `@ApiBody<T>({ description?, required?, contentType?, schema? })`                                  | method             | static, `schema` value | The body of routes that read it themselves (`ctx.bodyStream()`, `ctx.rawBody()`)                                                                      |
| `@ApiQuery<T>(name, { description?, required?, deprecated?, example? })`                           | method             | static                 | A query parameter read outside the signature (`ctx.query`)                                                                                            |
| `@ApiHeader<T>(name, { ... })`                                                                     | class, method      | static                 | A header read by a guard or an interceptor (`x-tenant`)                                                                                               |
| `@ApiSecurity(...requirements)`                                                                    | class, method      | value                  | Security. The route's wins over the class's. Several arguments are alternatives. No argument means public (`security: []`)                            |
| `@ApiExclude()`                                                                                    | class, method      | —                      | Not documented                                                                                                                                        |

Every decorator is a no-op marker, stripped from the bundle like the others (architecture §6.3).
Type arguments (`@ApiResponse<Book[]>(200)`) are erased at runtime, but the compiler reads them
(§9.1, C3).

**JSDoc is the first source of text.** Decorators override it. Set `jsdoc: false` to ignore it.

| JSDoc                                             | OpenAPI                                                                                                   |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| First line of a handler comment                   | `summary`                                                                                                 |
| Rest of the handler comment                       | `description`                                                                                             |
| `@deprecated` on a handler                        | `deprecated: true`                                                                                        |
| `@param search Text...`                           | `description` of the parameter that the TypeScript parameter `search` feeds (`q`), or of the request body |
| `@returns Text`                                   | `description` of the success response (default: the reason phrase, `OK`)                                  |
| Comment of a controller                           | `description` of its default tag, when that tag is not declared in `@OpenApiDocument`                     |
| Comment of an interface, alias, class or property | `description` of the schema or property, plus the tags of §6.2                                            |

```ts
// src/books/book.controller.ts
import type { FileBody } from '@znight/http'
import { ApiResponse, ApiTags } from '@znight/openapi'

/** Books of the shelf. */
@Controller('/books')
@Roles(['reader'])
@ApiTags('Books')
export class BookController {
  /**
   * List books
   *
   * Sorted and paginated, filtered by text, author and tags.
   * @param search Case-insensitive search in titles and authors.
   * @param limit Page size, between 1 and 100.
   */
  @Get()
  async list(
    @Query('q') search?: string,
    @Query('author') author?: string,
    @Query('tag') tags: string[] = [],
    @Query('sort') sort: BookSort = 'title',
    @Query('limit') limit = 20,
    @Query('offset') offset = 0,
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
  @Roles(['admin'])
  @ApiResponse(201, { headers: { location: { description: 'URL of the new book' } } })
  @ApiResponse(409, { description: 'A book with this ISBN is already on the shelf' })
  async create(@Body(CreateBook) input: CreateBook): Promise<HttpResponse<BookResponse>> {
    const book = await this.books.add(input, this.user.get().principal.name)
    return HttpResponse.created(toResponse(book), `/books/${book.id}`)
  }

  /** Upload the cover */
  @Put('/:id/cover')
  @Roles(['admin'])
  async uploadCover(
    @Param('id') id: number,
    @UploadedFile('cover', { maxSize: '2mb', mimeTypes: COVER_TYPES }) cover: File,
  ): Promise<BookResponse> {
    /* ... */
  }

  /** Download the cover */
  @Get('/:id/cover')
  @Public()
  @ApiResponse(200, { description: 'The cover image', contentType: COVER_TYPES })
  @ApiResponse(404, { description: 'No book with this id, or no cover' })
  async downloadCover(@Param('id') id: number): Promise<HttpResponse<FileBody>> {
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

Any Standard Schema library works the same way:

```ts
import * as v from 'valibot'

export const NewOrder = v.object({
  productId: v.pipe(v.string(), v.uuid()),
  quantity: v.pipe(v.number(), v.integer(), v.minValue(1)),
})

@Post()
place(@Body(NewOrder) order: v.InferOutput<typeof NewOrder>): Promise<Order> {
  /* ... */
}
```

### 5.4 What is inferred

#### 5.4.1 Operations

- **One operation per route and concrete method.**
  - The path template comes from `fullPath`: `:id` becomes `{id}`.
  - The trailing wildcard `*` becomes `{wildcard}`, with `x-znight-wildcard: true` and a description
    saying that it matches the rest of the path, `/` included. **As implemented:** `{wildcard_1}`
    when the path already has a `:wildcard` parameter (`{wildcard_2}` when it also has
    `:wildcard_1`, and so on).
  - **As implemented:** routes of one path whose templates differ only by their parameter names
    (`GET /books/:id`, `DELETE /books/:bookId`) are documented under one template, since OpenAPI
    forbids two templates of one path: the first in code-point order (`{bookId}`), or the template
    of a whole-path `@Param(S)` schema, which keeps its own. Path parameters are renamed by
    position, with a ZNIGHT035 warning.
  - Automatic `HEAD` and `OPTIONS` are not documented. Explicit `@Head` and `@Options` routes are
    (**as implemented:** a `HEAD` response never has content).
  - `@All` is documented for each of GET, POST, PUT, PATCH and DELETE that has no explicit route on
    the same path. The operation id then ends with the method (`proxy.forward.get`).
- **Paths never contain the HttpPlugin `prefix`.** The prefix belongs to `servers`, by precedence:
  1. the plugin option `servers`;
  2. `@OpenApiDocument({ servers })`;
  3. `[{ url: prefix }]` when the prefix is not empty;
  4. nothing (the OpenAPI default, `/`).
- **Operation id.** By default `controller.handler`: the controller display name without its
  `Controller` suffix, in lower camel case, then the handler (`BookController.list` → `book.list`).
  Ids must be unique (ZNIGHT033) and match `^[A-Za-z_][\w.-]*$` (ZNIGHT030).

#### 5.4.2 Parameters

| Handler parameter                                                                   | OpenAPI parameter                                                                                                                               |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `@Param('id') id: number`                                                           | `{ name: 'id', in: 'path', required: true, schema: { type: 'number' } }`                                                                        |
| `@Query('limit') limit = 20`                                                        | `{ name: 'limit', in: 'query', required: false, schema: { type: 'number', default: 20 } }`                                                      |
| `@Query('tag') tags: string[] = []`                                                 | `in: 'query'`, `style: 'form'`, `explode: true`, `schema: { type: 'array', items: { type: 'string' }, default: [] }`                            |
| `@Query('sort') sort: BookSort = 'title'`                                           | `schema: { type: 'string', enum: ['author', 'newest', 'title', 'year'], default: 'title' }` (sorted, as the compiler normalises unions)         |
| `@Headers('x-tenant') tenant: string`                                               | `{ name: 'x-tenant', in: 'header', required: true, schema: { type: 'string' } }`                                                                |
| `@Cookie('theme') theme: 'light' \| 'dark'` (RFC 0006)                              | `in: 'cookie'`, coerced like a header                                                                                                           |
| `@Param('id', IdSchema)`, `@Query('q', S)`                                          | `schema: { $ref: '#/components/schemas/IdSchema' }` (the **input** JSON Schema)                                                                 |
| `@Query(SearchQuery)` (whole object, with a schema)                                 | One parameter per property of the input JSON Schema, `required` from its `required` list. It must be an object schema (ZNIGHT037 otherwise) (¹) |
| `@Query() q: SearchParams` (a TypeScript interface, no schema)                      | One parameter per property of the shape. ZNIGHT017 still applies                                                                                |
| `@Param()`, `@Query()`, `@Headers()` typed as records, `@Ctx()`, `@Req()`, `@Res()` | Nothing. Document what they read with `@ApiQuery` / `@ApiHeader`                                                                                |

(¹) **As implemented:** a property that another parameter of the operation already documents
(`@Query('page')`, `@ApiQuery('page')`, another whole-object schema) is dropped, with a ZNIGHT035
assembly warning: OpenAPI forbids two parameters with one name and location.

Coercion plans map to schemas as follows:

| Plan              | Schema                                                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| `string`          | `{ type: 'string' }`                                                                                |
| `number`          | `{ type: 'number' }`                                                                                |
| `integer`         | `{ type: 'integer' }` (only from a plan: TypeScript has no integer type)                            |
| `boolean`         | `{ type: 'boolean' }`                                                                               |
| `bigint`          | `{ type: 'string', pattern: '^-?[0-9]+$' }` (not `integer`: generated clients would lose precision) |
| `date`            | `{ type: 'string', format: 'date-time' }`                                                           |
| `enum`            | `{ enum: [...] }`, plus `type` when all the values have one type                                    |
| `array`           | `{ type: 'array', items }`                                                                          |
| `optional`        | `required: false`                                                                                   |
| `raw` (`unknown`) | `{}`                                                                                                |

The default value comes from a statically evaluable initialiser (§9.1, C4).

#### 5.4.3 Request bodies

| Signature                                              | `requestBody`                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `@Body(S)` / `@Validate(S)`                            | `content['application/json'].schema`: S, **input**. `required: true`, unless the parameter is optional |
| `@Body() input: T` (TypeScript, no schema)             | The same, with the shape of `T` (ZNIGHT017 still warns: the body is not validated)                     |
| `@Body() text: string`                                 | `text/plain`                                                                                           |
| `@Body() bytes: Uint8Array`                            | `application/octet-stream`                                                                             |
| Upload parameters, plus an optional `@Body(Form)`      | See the list below                                                                                     |
| `@UploadedFile()` / `@UploadedFiles()` without a field | `additionalProperties` of files                                                                        |
| `ctx.parseBody()`, `ctx.rawBody()`, `ctx.bodyStream()` | Nothing, unless `@ApiBody`                                                                             |
| `@ApiBody<T>({ contentType, description })`            | As declared                                                                                            |

An upload route gets a `multipart/form-data` body:

- an object whose properties are the file fields:
  - `@UploadedFile` gives `{ type: 'string', contentMediaType: 'application/octet-stream' }`;
  - `@UploadedFiles` gives an array of those, with `maxItems: maxFiles`;
- the text fields of `Form` (input), merged with `allOf`;
- `encoding[field].contentType` from `mimeTypes`;
- `required` lists the required file fields;
- `maxSize` goes into the description (`At most 2 MiB`) and into `x-znight-max-size` (bytes).

The other content types parsed by Znight (urlencoded, multipart for text fields) are added with
`@ApiBody({ contentType: [...] })`.

#### 5.4.4 Responses

**The success status** is `@HttpCode`, else 201 for POST and 200 otherwise. When the return type
is `void` or `undefined`, it is `@HttpCode`, else 201 for POST and 204 otherwise. This is the
runtime rule of architecture §9.1. Its content comes from the annotated return type, after
unwrapping `Promise<…>`.

> **As implemented** (v0.1, after the wave 6 review), differences with the table below:
>
> - The return type is read member by member. `HttpResponse<A> | HttpResponse<B> | C` is documented
>   as `A | B | C` (repetitions removed), and the status, chosen at runtime, lets `@ApiResponse`
>   declare other 2XX statuses.
> - `T | undefined` documents `T` **and** an empty 204 response (what the runtime sends for
>   `undefined`), except on POST and with `@HttpCode`; `@ApiResponse(204)` is then accepted.
> - Media types follow the serialiser: strings, string literals and string enums are `text/plain`;
>   a mixed union gets both media types, each with its members (`string | null`: `text/plain` and
>   `application/json` for `null`).
> - `HttpResponse<SseBody>` (`HttpResponse.sse()` on any route) is `text/event-stream`, status 200
>   even on POST unless `@HttpCode`; an event stream or another body is ZNIGHT031.
> - A body with `@HttpCode(204)` or `304` is a ZNIGHT035 error (the serialiser drops it) and is not
>   documented. `HEAD` operations never have content.

| Return type                                                                                                          | Success response                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Object types: interfaces, aliases, classes, records, arrays, unions...                                               | `application/json`, with the schema of the shape (§6.2)                                                                                    |
| `HttpResponse<T>`                                                                                                    | As `T`. In `T \| undefined`, `undefined` adds the empty 204 (as implemented, above)                                                        |
| `z.output<typeof S>`, `v.InferOutput<typeof S>`, or an alias of them                                                 | The **output** JSON Schema of `S`                                                                                                          |
| `string`, string literals, string enums (as implemented)                                                             | `text/plain`                                                                                                                               |
| `Uint8Array`, `ArrayBuffer`, `Buffer`, views, `ReadableStream`, `Readable`, `Blob`, `File`, `HttpResponse<FileBody>` | `application/octet-stream` without schema. Set the media type with `@ApiResponse(s, { contentType })`                                      |
| `AsyncIterable<SseEvent<T>>` on an `@Sse` route (RFC 0006)                                                           | `text/event-stream`. The schema of `T` goes into `x-znight-event-schema` and the description. OpenAPI 3.2 `itemSchema` is open question Q1 |
| `void`, `undefined`, `HttpResponse<undefined>`                                                                       | No content                                                                                                                                 |
| No annotation, `any`, `unknown`, `HttpResponse` without type argument, `Response`, `@Res()`                          | ZNIGHT031, unless an `@ApiResponse` documents the success status                                                                           |

More rules:

- `@Header('cache-control', 'no-store')` documents the header on the success response.
- `@ApiResponse` entries are merged by status: declared fields win over inferred ones.
- The `description` of a response defaults to `@returns`, else to the reason phrase.

**Standard errors** (`errors: true`, the default) use two components:

```ts
// components.schemas
HttpErrorBody: { statusCode: integer, error: string, message: string, details?: {} } // required: statusCode, error, message
ValidationErrorBody: HttpErrorBody & { details: { path: string, message: string }[] }
```

- `400` (`components.responses.BadRequest` → `ValidationErrorBody`) on every route that coerces or
  validates an input.
- `413` (`PayloadTooLarge`) on every route that reads a body.
- `415` (`UnsupportedMediaType`) on upload routes.
- A declared `4XX`/`5XX` response without a schema (`@ApiResponse(404)`) gets `HttpErrorBody`.
- An exception mapper that changes the envelope (RFC 9457 problem details, for example) declares
  it once: `errors: { schema: ProblemDetails, contentType: 'application/problem+json' }`.

### 5.5 Security

For each operation, the first rule that applies wins:

1. `@ApiSecurity(...)` on the route;
2. `@ApiSecurity(...)` on the controller;
3. the first `decisions` entry whose decorator is in the route's **effective** metadata. Route
   entries are looked at before controller entries (with RFC 0001: the nearest decision of its
   group);
4. otherwise the operation inherits the document `security`, and gets no `security` field.

Requirement inputs:

- `ApiKey`: one scheme;
- `[Bearer, Tenant]`: both (AND);
- `{ scheme: OAuth, scopes: ['books:write'] }`: a scheme with scopes;
- several arguments are alternatives (OR). `@ApiSecurity()` means public.

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

Checks (ZNIGHT036):

- scopes must be declared by one of the flows of the scheme;
- scopes are only allowed on `oauth2` and `openIdConnect` schemes;
- `scopes: 'value'` needs a static string array as the decorator value;
- a `when` that is not a route decorator is an error. One that no route uses is a warning.

### 5.6 Plugin configuration

`OpenApiPlugin.configure(options | (container) => options)` (name `openapi`). A function is
evaluated once, after `container.init()` (architecture §8.2).

| Option            | Default           | Description                                                                                                                                                                     |
| ----------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`         | `true`            | `false` serves nothing and builds nothing (the `OpenApi` external still works)                                                                                                  |
| `path`            | `'/openapi.json'` | JSON document, relative to the HTTP prefix like controller routes                                                                                                               |
| `yaml`            | `false`           | A path (`'/openapi.yaml'`) serves YAML (`application/yaml`). Needs the optional peer `yaml`                                                                                     |
| `ui`              | `'scalar'`        | `'scalar'`, `'swagger'`, `false`, or `{ scalar: ScalarConfig }` / `{ swagger: SwaggerUiConfig }`. The config must be JSON-serialisable                                          |
| `uiPath`          | `'/docs'`         | HTML page of the UI. Local assets are under `${uiPath}/_assets/`                                                                                                                |
| `assets`          | `'auto'`          | `'local'` serves the UI package from `node_modules`. `'cdn'` uses the jsDelivr URL pinned by this release, with SRI. `'auto'` is local when the package resolves, CDN otherwise |
| `document`        | `'build'`         | `'build'` assembles the document from the metadata. `{ file: string \| URL }` serves a prebuilt `openapi.json` (§5.8), with the options below applied to it                     |
| `build`           | `'boot'`          | `'boot'` builds in `onBootstrap`, so a failure fails `Application.create`. `'first-request'` builds lazily (serverless)                                                         |
| `info`, `servers` | —                 | Runtime overrides. `info` is merged over the static one, `servers` replaces it                                                                                                  |
| `filter`          | —                 | `(operation: OpenApiOperationView) => boolean`: hides operations, for example by tag or route meta. Unreferenced components are pruned                                          |
| `transform`       | —                 | `(document) => document`: last-resort escape hatch, applied before freezing                                                                                                     |
| `converters`      | `[]`              | Extra `SchemaConverter`s, tried before the built-in ones (§7.3)                                                                                                                 |
| `unrepresentable` | `'error'`         | `'warn'`: a schema that cannot be converted becomes `{}`, with a ZNIGHT037 warning, instead of failing the build                                                                |
| `meta`            | `[]`              | Route metadata of the docs routes (`[Public.meta()]`), seen by guards and by the RFC 0001 boot check                                                                            |
| `guards`          | `[]`              | Extra guards of the docs routes (classes or instances). Global guards still run first                                                                                           |
| `cacheControl`    | `'no-cache'`      | `cache-control` of the document (revalidated with the ETag)                                                                                                                     |

```ts
OpenApiPlugin.configure(container => {
  const server = container.get(ServerConfig)
  return {
    enabled: server.docs, // DOCS=false hides the documentation of an internal deployment
    servers: [{ url: server.publicUrl }],
    meta: [Public.meta()], // the access group of RFC 0001 is required: the docs are public
    ui: { scalar: { theme: 'purple', hideModels: false } },
  }
})

// production: serve the file written by `znight build --openapi`, no conversion at boot
OpenApiPlugin.configure({
  document: process.env['NODE_ENV'] === 'production' ? { file: new URL('./openapi.json', import.meta.url) } : 'build',
})
```

### 5.7 Injection

The plugin provides one singleton external, `OpenApi`, declared in the manifest:

```ts
export abstract class OpenApi {
  /** The frozen document, built on the first call in 'first-request' mode. */
  abstract document(): Promise<OpenApiObject>
  /** The served JSON text (2 spaces, final newline). */
  abstract json(): Promise<string>
  /** YAML text (optional peer `yaml`). */
  abstract yaml(): Promise<string>
  /** Static view of the operations, without any schema conversion. */
  abstract readonly operations: readonly OpenApiOperationView[]
}

export interface OpenApiOperationView {
  readonly method: 'get' | 'put' | 'post' | 'delete' | 'options' | 'head' | 'patch'
  readonly path: string // template without the HTTP prefix
  readonly operationId: string
  readonly tags: readonly string[]
  readonly controller: string // display name
  readonly handler: string
  readonly meta: Readonly<Record<string, unknown>> // effective route metadata
}
```

```ts
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

### 5.8 Emitting `openapi.json` at build time

> **As implemented** (v0.1, after the wave 6 review): `znight build` takes `--openapi-prefix`, and
> the `openapi()` Vite plugin a `prefix` option, so that every way of emitting the file can give it
> the `servers` of the served document. A prebuilt file served with `document: { file }` gets the
> runtime options of the plugin (§5.6) and is checked against the HTTP prefix.

```sh
znight openapi                      # writes openapi.json at the project root
znight openapi -o docs/openapi.yaml # YAML, chosen by the extension (needs `yaml`)
znight openapi --check              # CI: exit 1 when the file is missing or stale; never writes
znight openapi --prefix /api        # servers default when @OpenApiDocument declares none
znight openapi --runtime bun        # load the modules with Bun (default: the runtime running the CLI)
znight build --openapi              # after the bundle: dist/openapi.json, next to dist/main.js
znight build --openapi --openapi-prefix /api # the same, with the prefix of HttpPlugin as servers default
```

`--prefix` and `--openapi-prefix` take the `prefix` of `HttpPlugin.configure()` (a path starting with
`/`; anything else is a usage error). Without it, a document emitted for an application served
under a prefix has no `servers`, and clients generated from the file call the wrong paths.
`--openapi-prefix` needs `--openapi` (usage error otherwise). When the Vite config registers its
own `openapi()`, that plugin emits the document with its own options: `--openapi=<path>` and
`--openapi-prefix` do not apply, and the CLI warns about it (set `openapi({ output, prefix })` in the
config instead).

```ts
// vite.config.ts
import { znight } from '@znight/compiler'
import { openapi } from '@znight/openapi/vite'
import { defineConfig } from 'vite'
import options from './znight.config.ts'

export default defineConfig({
  plugins: [
    znight(options),
    // vite build / znight build: after the bundle is written; znight dev: after each good rebuild
    openapi({
      output: ['openapi.json', 'dist/openapi.json'],
      check: process.env['CI'] === 'true',
      prefix: '/api', // the prefix of HttpPlugin: servers default when @OpenApiDocument declares none
    }),
  ],
})
```

```ts
// programmatic API, used by the CLI and the Vite plugin
import { emitOpenApi } from '@znight/openapi/emit'

const result = await emitOpenApi({ root: process.cwd(), output: 'openapi.json', check: false, runtime: 'auto' })
// { written: string[], stale: boolean, staleFiles: string[], document: OpenApiObject, diagnostics }
```

- **Custom converters** are runtime functions: emission loads them from a module
  (`openapi({ converters: './src/openapi.converters.ts' })`, `--converters <file>`, default export
  `SchemaConverter[]`). The plugin takes the same array.
- **Commit `openapi.json` and check it in CI** (`znight openapi --check`). An API change then shows
  up in the pull request diff, and clients can be generated from the file without starting
  anything.
- **Serving the file** (`document: { file }`): `info`, `servers`, `filter` and `transform` apply to
  it as to a build (operations matched by path and method; empty paths, unused tags and
  unreferenced components pruned), and a file without `servers` gets `[{ url: prefix }]` under an
  HTTP prefix, with a ZNIGHT030 warning: emit it with the prefix. Relative servers of the file that
  do not end with the prefix are a ZNIGHT030 warning too. With none of these, the file is served
  byte for byte.

### 5.9 Testing (`@znight/testing` and `@znight/openapi/testing`)

`@znight/testing` needs no change. `TestApp` boots the plugin, and `app.get(OpenApi)` reaches the
document.

```ts
import { OpenApi } from '@znight/openapi'
import { validateResponse } from '@znight/openapi/testing'
import { createTestApp } from './support/app.js' // the plugins of main.ts, with OpenApiPlugin.configure({ ui: false })

test('the served document is the committed openapi.json', async () => {
  await using app = await createTestApp()
  const served = await app.inject({ url: '/openapi.json' })
  expect(served.status).toBe(200)
  expect(served.body).toBe(await Bun.file(new URL('../openapi.json', import.meta.url)).text())
})

test('GET /books/:id answers what its documentation says', async () => {
  await using app = await createTestApp()
  const document = await app.get(OpenApi).document()
  const response = await app.inject({ url: '/books/1', headers: { 'x-api-key': READER_KEY } })
  expect(validateResponse(document, { method: 'GET', path: '/books/{id}', response })).toEqual([])
})

test('404 is documented too', async () => {
  await using app = await createTestApp()
  const document = await app.get(OpenApi).document()
  const response = await app.inject({ url: '/books/999', headers: { 'x-api-key': READER_KEY } })
  expect(response.status).toBe(404)
  expect(validateResponse(document, { method: 'GET', path: '/books/{id}', response })).toEqual([])
})
```

```ts
// without HTTP: the pure function
import { buildOpenApiDocument } from '@znight/openapi'
import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'

test('every operation has an id and a tag', async () => {
  const { document, warnings } = await buildOpenApiDocument(metadata)
  expect(warnings).toEqual([])
  for (const item of Object.values(document.paths ?? {}))
    for (const operation of operationsOf(item)) expect(operation.tags?.length).toBeGreaterThan(0)
})
```

- `validateResponse(document, { method, path, response })` returns
  `{ path, message, keyword }[]` issues.
- It checks:
  - that the status is documented (an explicit code, then `NXX`, then `default`);
  - the media type, and the documented headers;
  - the JSON body against the resolved schema, with JSON Schema 2020-12 through the optional peer
    `@cfworker/json-schema` (no code generation, so it runs on Bun, Node and edge runtimes).
- `response` is an `InjectResponse` or a `{ status, headers, body }` object.

## 6. Compile-time analysis and validations

### 6.1 The extension (`@znight/openapi/compiler`)

```ts
const decorators = {
  '@znight/openapi#OpenApiDocument': { targets: ['class'], params: ['value'] },
  '@znight/openapi#ApiOperation': { targets: ['method'], params: ['static'] },
  '@znight/openapi#ApiTags': { targets: ['class', 'method'], params: [], rest: 'static' },
  '@znight/openapi#ApiResponse': { targets: ['method'], params: ['static', 'value'] },
  '@znight/openapi#ApiBody': { targets: ['method'], params: ['value'] },
  '@znight/openapi#ApiQuery': { targets: ['method'], params: ['static', 'static'] },
  '@znight/openapi#ApiHeader': { targets: ['class', 'method'], params: ['static', 'static'] },
  '@znight/openapi#ApiSecurity': { targets: ['class', 'method'], params: [], rest: 'value' },
  '@znight/openapi#ApiExclude': { targets: ['class', 'method'], params: [] },
} satisfies Record<string, DecoratorSpec>
```

The core reports wrong targets, extra arguments and non-static arguments as ZNIGHT005 before the
extension runs. `securityScheme` is not a decorator. It is recognised as the callee
(`@znight/openapi#securityScheme`) of the `const` initialiser behind a `value` argument, the way
`@znight/http/compiler` recognises `createRouteDecorator`.

**`analyzeClass(cls)`** (classes carrying at least one decorator of the extension):

1. **`@OpenApiDocument`.**
   - Evaluate the options. Nested references are allowed: schemes, route decorators,
     `errors.schema`.
   - Check their shape against the OpenAPI 3.1 objects (unknown keys, URLs, SPDX identifier,
     `x-` keys). Problems are ZNIGHT030.
   - Store `{ kind: 'document', ... }`. A second class gives ZNIGHT030, located at both.
2. **Any other class** must carry `@znight/http#Controller`. Otherwise ZNIGHT030: "`@Api*`
   decorators apply to controllers"; on a `@Consumer`, the hint mentions AsyncAPI as a non-goal.
   - Method decorators must sit on route handlers (methods with a route decorator), ZNIGHT030
     otherwise.
   - Store `{ kind: 'controller', identity, class: {...}, methods: {...} }`. It holds the evaluated
     options, the `ValueRef`s (schemas, schemes) and the decorator type arguments (C3).
3. **Security schemes.** Resolve every scheme reference to its `securityScheme(name, definition)`
   call and evaluate it statically (`refs: 'none'`). The definition is checked (type, `in`, `name`,
   `scheme`, `flows`, URLs): ZNIGHT036 for a requirement problem, ZNIGHT030 for a malformed
   definition.

**`validate(ctx)`**, once per compile, after the http extension:

1. Read the http controllers from `graph.extensions` (`name: 'http'`, typed `HttpControllerData`,
   §9.2 H6), sorted by token. Routes with `complete: false` are skipped: http already reported
   them.
2. For each documented route and concrete method (§5.4.1), build the operation model:
   - `ctx.classInfo(controller.identity)` gives the method: JSDoc (C2), return type, parameter
     initialisers (C4);
   - parameters come from `HttpParamData` (source, key, coercion plan, schema reference, optional)
     plus `@ApiQuery` / `@ApiHeader`;
   - the body comes from the body parameter, the uploads, `bodySchema` or `@ApiBody`;
   - responses come from the success status and the return shape (`types.shape`, C1), plus
     `@ApiResponse` and the standard errors;
   - security, tags and the operation id follow §5.4 and §5.5.
3. Run the checks of §6.3 and report the diagnostics.
4. Keep the model in a `WeakMap` keyed by the `ApplicationGraph` for `generate`. Nothing is
   computed twice.

**`generate(ctx)`** emits `extensions.openapi` (§7.1) with the builders of the generate context.

- Literals use `ctx.lit` / `ctx.obj` / `ctx.arr`. Every schema slot uses `ctx.importValue(ref)`, so
  the schemas imported by `invoke` are imported once.
- The section is emitted as soon as the extension is loaded, even without a controller (empty
  `operations`), so that the plugin always finds it.
- **Fingerprint.** SHA-256 (base64url) of the canonical JSON of the section, where each schema
  value is replaced by its slot name. `node:crypto` works in the compiler on Node and Bun.

**Cost.** Like the rest of the binding phase, the model is recomputed on every compile. Shapes are
cached by `(declaration identity, type arguments, content hash)` in the compiler (C1). Budget:
≤ 15% of compile time on the 200-route fixture of §13.

**Compiled provider libraries.** Controllers from a compiled library (`znight.providers.json`) are
documented from their `.d.ts` types. Their `@Api*` decorators are read only when the library was
compiled with `@znight/openapi` installed (its stored data is in the manifest, architecture §6.4).

### 6.2 Type shapes: TypeScript → JSON Schema

> **As implemented** (v0.1, after the wave 6 review). Normative text: architecture §6.5 (type
> shapes) and §9.5 (components). Differences with the first version of this section, all reflected
> below:
>
> - Enum member types (`kind: Kind.Cat`) are the literal of their value, and enums and aliases of
>   literal unions work as keys (`Record<Genre, T>`, `{ [K in Genre]?: T }`, `Pick` / `Omit` keys,
>   `T[K]`) and in `Exclude` / `Extract` / `NonNullable`.
> - A `discriminator` is only emitted with a complete `mapping` (every member a named component).
> - Generic instantiations with an anonymous type argument, or whose name another instantiation of
>   the same declaration already has, get a short hash.
> - A declaration named like a Standard Schema is ZNIGHT034 whatever the route order, except the
>   `interface User extends z.infer<typeof User>` pattern, documented by the schema.
> - A `bigint` first met in a request and then in a response is reported again, as an error.

The compiler gets a structural view of type annotations (C1). It works on declarations and AST
nodes, from sources and from `.d.ts` alike. It records the files it reads for `watchFiles`.

```ts
interface TypeHelpers {
  // ...existing helpers
  shape(target: ShapeTarget, options?: ShapeOptions): ShapeResult
}
type ShapeTarget =
  | { readonly returnOf: MethodInfo }
  | { readonly parameter: ParameterInfo }
  | { readonly decorator: DecoratorInfo; readonly typeArgument: number }
interface ShapeOptions {
  /** Generic aliases meaning "the schema S" (`z.output<typeof S>`): identity → io. */
  readonly schemaAliases?: Readonly<Record<string, 'input' | 'output'>>
  readonly jsdoc?: boolean
}
interface ShapeResult {
  readonly root: Shape
  readonly named: ReadonlyMap<string, NamedShape> // key: identity + serialized type arguments
  readonly issues: readonly ShapeIssue[] // unrepresentable parts, with their location and path
}
type Shape =
  | {
      readonly kind:
        | 'string'
        | 'number'
        | 'boolean'
        | 'null'
        | 'unknown'
        | 'never'
        | 'date'
        | 'bigint'
        | 'binary'
        | 'url'
    }
  | { readonly kind: 'literal'; readonly value: string | number | boolean }
  | { readonly kind: 'array'; readonly items: Shape }
  | { readonly kind: 'tuple'; readonly items: readonly Shape[]; readonly rest?: Shape; readonly minItems: number }
  | { readonly kind: 'object'; readonly properties: readonly ShapeProperty[]; readonly additional?: Shape }
  | { readonly kind: 'union' | 'intersection'; readonly members: readonly Shape[] }
  | { readonly kind: 'named'; readonly key: string } // interface, class, alias or enum: a component
  | { readonly kind: 'schema'; readonly ref: ValueRef; readonly io: 'input' | 'output' } // Standard Schema behind z.output<typeof S>
  | { readonly kind: 'opaque'; readonly text: string; readonly reason: string }
```

The openapi extension maps shapes to JSON Schema 2020-12:

| TypeScript                                                                                                                                                                      | JSON Schema                                                                                                                                                                      | Note                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `string`, `number`, `boolean`, `null`                                                                                                                                           | `type`                                                                                                                                                                           |                                                                                                                                                                      |
| Literal `'a'`                                                                                                                                                                   | `const: 'a'`                                                                                                                                                                     |                                                                                                                                                                      |
| Union of literals                                                                                                                                                               | `enum` (`type` when homogeneous)                                                                                                                                                 |                                                                                                                                                                      |
| `T \| null`                                                                                                                                                                     | `type: [T, 'null']`, or `anyOf` with `{ type: 'null' }` for references                                                                                                           |                                                                                                                                                                      |
| Optional property `?`, `\| undefined`                                                                                                                                           | Not in `required`                                                                                                                                                                |                                                                                                                                                                      |
| `T[]`, `readonly T[]`, `Array<T>`, `ReadonlyArray<T>`                                                                                                                           | `{ type: 'array', items }`                                                                                                                                                       |                                                                                                                                                                      |
| Tuple `[A, B?, ...C[]]`                                                                                                                                                         | `prefixItems`, `minItems`, `items`                                                                                                                                               |                                                                                                                                                                      |
| Interface, object literal, class                                                                                                                                                | `type: 'object'`, `properties`, `required`                                                                                                                                       | Class: own instance fields and parameter properties only. Methods and prototype getters are not serialised by `JSON.stringify`. `additionalProperties` is left unset |
| `interface A extends B`                                                                                                                                                         | Flattened properties                                                                                                                                                             | Generators prefer flat objects                                                                                                                                       |
| `Record<string, T>`, index signature                                                                                                                                            | `additionalProperties: T`                                                                                                                                                        |                                                                                                                                                                      |
| `Record<'a' \| 'b', T>`, `Record<Enum, T>`, `{ [K in Alias]?: T }`                                                                                                              | Object with a property per key (required for `Record`)                                                                                                                           | Keys go through enums and aliases of unions (as implemented); `Record<never, T>` is `{}`                                                                             |
| `Partial`, `Required`, `Readonly`, `Pick`, `Omit`, `NonNullable`, `Exclude`, `Extract`                                                                                          | Applied structurally                                                                                                                                                             | Other mapped and conditional types: ZNIGHT032. A filter that removes nothing keeps the named component (`NonNullable<Pet>` is `Pet`)                                 |
| `A & B` (objects)                                                                                                                                                               | Merged object                                                                                                                                                                    |                                                                                                                                                                      |
| Union of objects                                                                                                                                                                | `anyOf`. `oneOf` when every member has a required string literal property with distinct values, plus a `discriminator` with its `mapping` when every member is a named component | As implemented: without a complete mapping tools would read the values as component names, so no `discriminator`                                                     |
| TypeScript `enum`                                                                                                                                                               | `enum` of the member values, as a named component                                                                                                                                | An enum member type (`Kind.Cat`) is `const` of its value (as implemented)                                                                                            |
| `Date`                                                                                                                                                                          | `{ type: 'string', format: 'date-time' }`                                                                                                                                        | `Date.prototype.toJSON`                                                                                                                                              |
| `URL`                                                                                                                                                                           | `{ type: 'string', format: 'uri' }`                                                                                                                                              | `URL.prototype.toJSON`                                                                                                                                               |
| Template literal type                                                                                                                                                           | `{ type: 'string' }`                                                                                                                                                             |                                                                                                                                                                      |
| Class with `toJSON(): X`                                                                                                                                                        | The shape of `X`                                                                                                                                                                 | The return type must be annotated, ZNIGHT032 otherwise                                                                                                               |
| `unknown`, `any`                                                                                                                                                                | `{}`                                                                                                                                                                             | As a whole response: ZNIGHT031                                                                                                                                       |
| `bigint` in a JSON body                                                                                                                                                         | **ZNIGHT032, error** in a response (as implemented: a warning in a request body)                                                                                                 | `JSON.stringify` throws, so the route answers 500                                                                                                                    |
| `Map`, `Set`, `WeakMap`, `RegExp`, `Error`, typed arrays inside JSON                                                                                                            | ZNIGHT032 (warning)                                                                                                                                                              | Serialised as `{}` or as numeric keys                                                                                                                                |
| Functions, symbols, unbound type parameters, `opaque`                                                                                                                           | ZNIGHT032 (warning), `{}`                                                                                                                                                        |                                                                                                                                                                      |
| `z.output<typeof S>`, `z.infer`, `z.input`, `v.InferOutput`, `v.InferInput`, `StandardSchemaV1.InferOutput`, `InferSchemaOutput` (http), ArkType `typeof S.infer` / `S.inferIn` | `{ $ref }` to the slot of `S` with that io                                                                                                                                       | The table of aliases is passed in `schemaAliases`, and tested against the installed libraries                                                                        |

**JSDoc tags on types and properties:**

| Tag                                                                             | JSON Schema                                               |
| ------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Text                                                                            | `description`                                             |
| `@deprecated`                                                                   | `deprecated: true`                                        |
| `@example`                                                                      | `examples`                                                |
| `@default`                                                                      | `default`                                                 |
| `@format`                                                                       | `format` (`int32` and `int64` also set `type: 'integer'`) |
| `@minimum`, `@maximum`, `@exclusiveMinimum`, `@exclusiveMaximum`, `@multipleOf` | Numeric keywords                                          |
| `@minLength`, `@maxLength`, `@pattern`                                          | String keywords                                           |
| `@minItems`, `@maxItems`, `@uniqueItems`                                        | Array keywords                                            |

Tag values are parsed as JSON, or as a string. An invalid value is ZNIGHT032 at the tag.

**Component names** (normative, compile time):

- A non-generic named declaration uses its display name: `BookResponse`.
- A generic instantiation joins the names of its arguments: `Page<BookResponse>` gives
  `Page_BookResponse`, and primitives use their keyword (`Page_string`). **As implemented:** an
  argument that does not name itself (an object literal, a tuple, an opaque type, a generic
  reference) adds the first 8 hexadecimal characters of the SHA-256 of the instantiation key
  (`Page<{ id: string }>` → `Page_object_1a2b3c4d`), and so does an instantiation whose name another
  instantiation of the same declaration already has (`Box<Book[]>` and `Box<BookArray>`): two
  instantiations never clash.
- A Standard Schema slot uses the export name of its binding (`CreateBook`). The `XInput` variant
  is decided at assembly (§7.3), for the slot and for each of its hoisted definitions.
- **As implemented:** the components are checked against the schema slots once every operation is
  built, so the result does not depend on the route order. A declaration named like a schema is
  ZNIGHT034, except a declaration merged with the schema it is inferred from (`export const User =
  z.object(…)` and `export interface User extends z.infer<typeof User> {}`: one identity), which is
  documented by the schema (its output variant).
- Names keep `[A-Za-z0-9._-]`. Other characters are replaced with `_`.
- The same name for two different identities is ZNIGHT034, with both declarations in the message.
  The fix is to rename one of them.
- The standard error components (`HttpErrorBody`, `ValidationErrorBody`) are reserved names when
  `errors` is on.

### 6.3 Diagnostics

**Code range policy** (added to architecture §4.8):

- 001–029 belong to the core, the compiler and the features shipped in 0.1 (http, messaging,
  config, observability). 023–029 stay for them, and RFC 0001 takes 023.
- From 030 on, each new first-party package reserves a **block of ten** in the `@znight/core`
  catalogue: 030–039 `@znight/openapi`, 040–049 the next package, and so on.
- A package uses its block for its own failure modes, with one catch-all code for invalid usage and
  options (like ZNIGHT011 for messaging and ZNIGHT012 for config). It reuses a lower code when the
  meaning is the same: a decorator on the wrong target is always ZNIGHT005.
- Third-party packages do not get `ZNIGHT` codes. The catalogue is closed.

**New codes** (as implemented in v0.1, after the wave 6 review: the ZNIGHT030, 032, 034 and 035
rows list the cases added then):

| Code          | Name                         | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Severity                                       |
| ------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| ZNIGHT030     | `InvalidOpenApiDefinition`   | Invalid `@OpenApiDocument` options or a second `@OpenApiDocument`. `@Api*` outside a controller or a route handler. Invalid static values (status, media type, tag, header name, operation id, `x-` key, `$znight` keys). A malformed `securityScheme()` definition. At runtime: invalid `OpenApiPlugin` options, a missing `extensions.openapi`, a prefix that the declared servers do not reflect, a stale prebuilt file, a prebuilt file without `servers` (or with relative servers not ending with the prefix) under an HTTP prefix (warnings) | error / warning                                |
| ZNIGHT031     | `UndocumentedResponse`       | The success response cannot be documented (§5.4.4) and no `@ApiResponse` covers it                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | warning (error with `strict`)                  |
| ZNIGHT032     | `UnrepresentableType`        | A documented type has no JSON Schema, or does not serialise as declared (§6.2). `bigint` in a JSON response is always an error (a warning in a request body), also when the type was first reported in a request body                                                                                                                                                                                                                                                                                                                               | warning / error (error with `strict`)          |
| ZNIGHT033     | `DuplicateOperationId`       | Two operations with the same id                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | error                                          |
| ZNIGHT034     | `SchemaNameConflict`         | Two different declarations or schemas for one component name: at compile time (a declaration named like a schema included, whatever the route order; not `interface X extends z.infer<typeof X>`), or at assembly for two different schemas of one io under one name (hoisted `$defs` ids, `XInput` names)                                                                                                                                                                                                                                          | error                                          |
| ZNIGHT035     | `InconsistentOperation`      | The documentation contradicts the route: a body on 204/304 (`@ApiResponse` or `@HttpCode`), a success status other than the route's, `@ApiQuery('x')` next to `@Query('x')`, a documented `accept` / `content-type` / `authorization` header (use a security scheme), `@ApiBody` next to `@Body(S)`. Warnings: `@ApiBody` on GET/HEAD, `@ApiExclude` with other `@Api*`, routes of one path with differently named parameters (one template), a whole-object parameter property documented twice (assembly)                                         | error / warning                                |
| ZNIGHT036     | `InvalidSecurityRequirement` | A requirement that is not a `securityScheme()`, scopes on a scheme without scopes, undeclared OAuth2 scopes, one scheme name for two definitions, an invalid `decisions[].when` or `scopes: 'value'` value, a decision never applied (warning)                                                                                                                                                                                                                                                                                                      | error / warning                                |
| ZNIGHT037     | `SchemaConversionFailed`     | At assembly (boot, emission, tests): no converter for a schema, a converter that throws or returns something other than an object, a whole-object `@Query(S)` / `@Param(S)` / `@Headers(S)` schema that is not an object                                                                                                                                                                                                                                                                                                                            | error (warning with `unrepresentable: 'warn'`) |
| ZNIGHT038–039 | —                            | Reserved                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | —                                              |

**Reused codes:** ZNIGHT005 (targets and arguments, checked by the core), ZNIGHT007 (a docs route
that collides with a controller route, at boot), ZNIGHT017 (unchanged: a TypeScript-typed body is
documented and still reported as unvalidated), ZNIGHT018 (a metadata `version` other than 1, a
failing extension).

```text
⚠ ZNIGHT031: The 201 response of POST /books (BookController.create) cannot be documented: HttpResponse has no body type
  --> src/books/book.controller.ts:96:54
   |
96 |   async create(@Body(CreateBook) input: CreateBook): Promise<HttpResponse> {
   |                                                      ^^^^^^^^^^^^^^^^^^^^^
   = hint: Give the body type: Promise<HttpResponse<BookResponse>>
   = hint: Or declare it: @ApiResponse<BookResponse>(201)
```

```text
✗ ZNIGHT032: ShelfStats.total is a bigint: JSON.stringify throws on bigint, so GET /books/stats (BookController.stats) would answer 500
  --> src/books/book.ts:58:19
   |
58 |   readonly total: bigint
   |                   ^^^^^^
  ::: src/books/book.controller.ts:140:12
   = note: returned by BookController.stats
   = hint: Return a number or a string (String(total)), or give ShelfStats a toJSON() method
```

```text
✗ ZNIGHT033: Duplicate operation id "book.list": admin/BookController.list and catalog/BookController.list
  --> src/admin/book.controller.ts:14:3
  ::: src/catalog/book.controller.ts:22:3
   = hint: Rename one controller, or set an id: @ApiOperation({ operationId: 'adminBook.list' })
```

## 7. Generated metadata and runtime contract

### 7.1 `metadata.extensions.openapi`

```ts
/** metadata.extensions.openapi, format 1. JSON-compatible, except the `schemas[].schema` values. */
export interface OpenApiMetadata {
  readonly version: 1
  /** SHA-256 (base64url) of the section, schema values replaced by their names (stale-file detection). */
  readonly fingerprint: string
  /** Root fields known at build time: openapi ('3.1.1'), info, servers?, tags?, externalDocs?, security?, x-*. */
  readonly document: OpenApiDocumentTemplate
  /** Sorted by path, then by method (get, put, post, delete, options, head, patch). */
  readonly operations: readonly OpenApiOperationDefinition[]
  /** JSON Schemas computed by the compiler from TypeScript declarations, by component name (sorted). */
  readonly components: Readonly<Record<string, SchemaTemplate>>
  readonly securitySchemes: Readonly<Record<string, SecuritySchemeObject>>
  /** Standard Schemas converted at assembly, sorted by name. */
  readonly schemas: readonly OpenApiSchemaSlot[]
  /** Standard error components; absent with `errors: false`. */
  readonly errors?: { readonly contentType: string; readonly schema?: string /* slot name */ }
}

export interface OpenApiSchemaSlot {
  readonly name: string
  readonly schema: StandardSchemaV1 // imported value
  readonly io: readonly ('input' | 'output')[] // the JSON Schemas needed
  readonly source?: { readonly file: string; readonly line: number; readonly column: number } // serve/test modes
}

export interface OpenApiOperationDefinition {
  readonly controller: Token
  readonly handler: string
  readonly route: HttpMethod // the compiled route method ('ALL' gives one definition per method)
  readonly method: 'get' | 'put' | 'post' | 'delete' | 'options' | 'head' | 'patch'
  readonly path: string // OpenAPI template, without the HTTP prefix
  readonly operation: OperationTemplate
}

/** Where a schema is expected, the compiler writes JSON Schema or a placeholder. */
export type SchemaTemplate = JsonSchema | SchemaPlaceholder
export interface SchemaPlaceholder {
  readonly $znight: 'schema'
  readonly name: string // slot name
  readonly io: 'input' | 'output'
}
/** In `parameters` arrays: the properties of an object schema, one parameter each. */
export interface ParametersPlaceholder {
  readonly $znight: 'parameters'
  readonly in: 'path' | 'query' | 'header' | 'cookie'
  readonly name: string
  readonly io: 'input'
}
/** An OpenAPI 3.1 Operation Object whose schemas are SchemaTemplates and whose parameters may hold ParametersPlaceholders. */
export type OperationTemplate = OperationObjectOf<SchemaTemplate, ParametersPlaceholder>

declare module '@znight/core' {
  interface ZnightExtensionsMetadata {
    readonly openapi?: OpenApiMetadata
  }
}
```

The `$znight` key is reserved. JSON Schema has no keyword with that name, and the compiler rejects
it in user-provided values (ZNIGHT030).

### 7.2 Generated section (`examples/rest-api`, shortened)

```ts
import { CreateBook } from '../books/book.schemas.js' // already imported by invoke

// in __ZNIGHT_METADATA__.extensions:
['openapi']: {
  ['version']: 1,
  ['fingerprint']: 'u0Zp3b4fQ1fYt2u9oEw0xg2H2bq1n4Ck1y0kq3mZ4sA',
  ['document']: {
    ['openapi']: '3.1.1',
    ['info']: { ['title']: 'Bookshelf API', ['version']: '0.0.0', ['description']: 'A shelf of books...' },
    ['servers']: [{ ['url']: '/api' }],
    ['security']: [{ ['apiKey']: [] }],
    ['tags']: [{ ['name']: 'Books', ['description']: 'The shelf' }],
  },
  ['securitySchemes']: { ['apiKey']: { ['type']: 'apiKey', ['in']: 'header', ['name']: 'x-api-key' } },
  ['schemas']: [{ ['name']: 'CreateBook', ['schema']: CreateBook, ['io']: ['input'], ['source']: { ['file']: 'src/books/book.schemas.ts', ['line']: 28, ['column']: 14 } }],
  ['components']: {
    ['BookResponse']: {
      ['type']: 'object',
      ['properties']: {
        ['id']: { ['type']: 'number' },
        ['isbn']: { ['type']: 'string' },
        ['publishedYear']: { ['type']: ['number', 'null'] },
        ['tags']: { ['type']: 'array', ['items']: { ['type']: 'string' } },
        ['createdBy']: { ['type']: 'string', ['description']: 'Name of the API key that added the book.' },
        ['createdAt']: { ['type']: 'string', ['format']: 'date-time' },
        ['coverUrl']: { ['type']: ['string', 'null'] },
        // ...
      },
      ['required']: ['author', 'coverUrl', 'createdAt', 'createdBy', 'id', 'isbn', 'publishedYear', 'tags', 'title', 'updatedAt'],
    },
    ['Page_BookResponse']: { /* items: { type: 'array', items: { $ref: '#/components/schemas/BookResponse' } }, total, limit, offset */ },
  },
  ['errors']: { ['contentType']: 'application/json' },
  ['operations']: [
    {
      ['controller']: 'src/books/book.controller.ts#BookController',
      ['handler']: 'create',
      ['route']: 'POST',
      ['method']: 'post',
      ['path']: '/books',
      ['operation']: {
        ['operationId']: 'book.create',
        ['summary']: 'Add a book',
        ['tags']: ['Books'],
        ['requestBody']: {
          ['required']: true,
          ['content']: { ['application/json']: { ['schema']: { ['$znight']: 'schema', ['name']: 'CreateBook', ['io']: 'input' } } },
        },
        ['responses']: {
          ['201']: {
            ['description']: 'The new book. Its URL is in the `location` header.',
            ['headers']: { ['location']: { ['description']: 'URL of the new book', ['schema']: { ['type']: 'string' } } },
            ['content']: { ['application/json']: { ['schema']: { ['$ref']: '#/components/schemas/BookResponse' } } },
          },
          ['400']: { ['$ref']: '#/components/responses/BadRequest' },
          ['409']: { ['description']: 'A book with this ISBN is already on the shelf', ['content']: { ['application/json']: { ['schema']: { ['$ref']: '#/components/schemas/HttpErrorBody' } } } },
          ['413']: { ['$ref']: '#/components/responses/PayloadTooLarge' },
        },
      },
    },
    // ...
  ],
},
```

### 7.3 Assembly: `buildOpenApiDocument` (normative)

> **As implemented** (v0.1, after the wave 6 review). Steps 2 to 5 below describe the shipped
> algorithm: dates of coerced Zod schemas and of Valibot responses, `$defs` named per id with their
> own `XInput` variants, anonymous definitions scoped to their slot, a root `.meta({ id })` equal to
> the export name unwrapped, and duplicate expanded parameters dropped. The same runtime options
> also apply to a prebuilt file (§5.8). Normative summary: architecture §9.5.

```ts
export function buildOpenApiDocument(
  metadata: ZnightMetadata,
  options?: BuildOpenApiOptions,
): Promise<OpenApiBuildResult>

export interface BuildOpenApiOptions {
  readonly prefix?: string // derived `servers` (§5.4.1)
  readonly info?: Partial<InfoObject>
  readonly servers?: readonly ServerObject[]
  readonly filter?: (operation: OpenApiOperationView) => boolean
  readonly transform?: (document: OpenApiObject) => OpenApiObject
  readonly converters?: readonly SchemaConverter[]
  readonly unrepresentable?: 'error' | 'warn'
}
export interface OpenApiBuildResult {
  readonly document: OpenApiObject // deep-frozen
  readonly json: string // JSON.stringify(document, null, 2) + '\n'
  readonly warnings: readonly ZnightWarningEntry[] // code, message, hints
  readonly stats: { readonly operations: number; readonly schemas: number; readonly durationMs: number }
}

export interface SchemaConverter {
  readonly name: string
  /** `undefined`: not supported, try the next converter. */
  convert(
    schema: StandardSchemaV1,
    context: { readonly io: 'input' | 'output'; readonly target: 'draft-2020-12'; readonly lenient: boolean },
  ): JsonSchema | undefined | Promise<JsonSchema | undefined>
}
```

The algorithm:

1. **Metadata.** `extensions.openapi` must exist (ZNIGHT030 otherwise, hint: "import
   `@znight/openapi` in a scanned file and regenerate") and have `version: 1` (ZNIGHT018
   otherwise).
2. **Conversion.** Each slot is converted for each `io` it needs, with the first converter that
   answers:
   1. the user `converters`;
   2. **Standard JSON Schema:**
      `schema['~standard'].jsonSchema[io]({ target: 'draft-2020-12', libraryOptions })`. For
      `vendor: 'zod'`, `libraryOptions.unrepresentable` maps `z.date()` to
      `{ type: 'string', format: 'date-time' }` for `io: 'output'`, because Znight serialises dates
      with `toJSON`, and a coerced date (`z.coerce.date()`) in both io, since it reads a string in
      requests;
   3. **Valibot** (`vendor: 'valibot'`, no `jsonSchema`): a lazy import of `@valibot/to-json-schema`,
      then `toStandardJsonSchema(schema)` and the same call, its options passed as `libraryOptions`
      (`toStandardJsonSchema` takes the schema only): `v.date()` is `date-time` for `io: 'output'`,
      and the lenient mode sets `errorMode: 'ignore'`.

   A missing converter, a throw, or a result that is not an object is ZNIGHT037 with the slot name,
   the vendor, the io and the source location. With `unrepresentable: 'warn'`, the conversion is
   retried in lenient mode (Zod: `unrepresentable: 'any'`), else gives `{}`, and a warning is added.
3. **Normalisation.**
   - Drop `$schema` and `$id`.
   - Split each converted schema into its root and its `$defs` (and `definitions`), at any depth,
     hoisted into `components.schemas`. Every local reference is rewritten (`#/$defs/X`, `#`,
     `#/properties/...`): inside an OpenAPI document, `#` is the document, not the schema, so
     unhoisted references would dangle.
   - A definition with a library id (`.meta({ id: 'Address' })`) is named after it. Anonymous
     definitions (Zod's `__schema0` of a recursive schema without id) are local to one conversion:
     they are scoped to their slot (`Tree_schema0`), so two slots never clash on them.
   - A root that only references one definition (`{ $ref: '#/$defs/X', $defs: { X } }`, Zod's
     `.meta({ id })` on the root) is unwrapped when X is named after the slot (the id equals the
     export name) or anonymous: X is the slot component. Another id keeps the root as an alias of X.
4. **Names.** Every global name, slot or hoisted definition, gives one component `Name` when its
   input and output JSON values are deeply equal. Otherwise it gives `Name` (output, the resource)
   and `NameInput`. A schema whose own JSON is equal in both io still gets `NameInput` when it
   references a definition that has one (propagated to a fixed point), so that the input variant
   references input definitions. Two different schemas of one io under one name, or a clash with a
   component of a TypeScript declaration, are ZNIGHT034; one name for an input and an output schema
   is not a conflict.
5. **Placeholders.**
   - `{ $znight: 'schema' }` becomes `{ $ref: '#/components/schemas/<name>' }`.
   - `{ $znight: 'parameters' }` becomes one parameter per property of the resolved object schema,
     with `required` from its `required` list and `description` from the property. ZNIGHT037 when
     the schema is not an object. OpenAPI forbids two parameters with one name and location: an
     expanded property that an explicit parameter of the operation, or an earlier expansion,
     already documents (header names compared case-insensitively) is dropped, and one ZNIGHT035
     warning lists them.
6. **Document.**
   - `paths[path][method] = operation`, in metadata order, after `filter`.
   - `components.schemas` gathers the compiler components, the converted slots, the hoisted `$defs`
     and the error bodies, sorted by name. Then `components.responses`, then
     `components.securitySchemes`.
   - Unreferenced components are pruned after `filter`.
   - Declared tags come first, then used tags, sorted.
   - Runtime `info` and `servers` are applied, else the `prefix` rule of §5.4.1.
   - `x-znight-fingerprint` is set at the root.
7. **Output.** `transform`, deep-freeze, then serialise once: 2-space JSON and a final newline.
   Key order is fixed by this algorithm, and library output keeps its own order.

The function is async because optional peers load lazily. Standard JSON Schema converters are
synchronous, so the cost is the CPU work of the conversion.

### 7.4 Package manifest and entries

```jsonc
"znight": {
  "apiVersion": 1,
  "compiler": "@znight/openapi/compiler",
  "provides": [{ "export": "OpenApi", "plugin": "OpenApiPlugin", "scope": "singleton" }]
}
```

| Entry                      | Contents                                                                                                                                                       | Loads                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `@znight/openapi`          | Decorators, `securityScheme`, `OpenApiPlugin`, `OpenApi`, `buildOpenApiDocument`, `SchemaConverter`, OpenAPI 3.1 types (`OpenApiObject`, `OperationObject`...) | `@znight/core`, `@znight/http`. Optional peers lazily                         |
| `@znight/openapi/compiler` | The compiler extension                                                                                                                                         | Type imports of `@znight/compiler` and `@znight/http/compiler`, `node:crypto` |
| `@znight/openapi/emit`     | `emitOpenApi()` (Node and Bun)                                                                                                                                 | `@znight/compiler`, `vite` (Node path), lazily                                |
| `@znight/openapi/vite`     | The `openapi()` Vite plugin                                                                                                                                    | `emit`, lazily                                                                |
| `@znight/openapi/testing`  | `validateResponse()`                                                                                                                                           | `@cfworker/json-schema`, lazily                                               |

The token is `@znight/openapi#OpenApi`. The OpenAPI types are our own (about 300 lines, written for
`exactOptionalPropertyTypes`), not `openapi-types` or `openapi3-ts`, so there is no dependency.

### 7.5 Emission (normative)

`emitOpenApi()`, used by `znight openapi`, `znight build --openapi` and `openapi()`:

1. Resolve the compiler options like `znight generate` does: `znight.config.*`, else the `znight()`
   plugin of the Vite config.
2. `compile()` in `serve` mode. Errors are printed, and the command exits 1 before anything runs.
3. Load the metadata in a **child process**, so that module side effects and globals never reach
   the CLI or Vite process:
   - **Bun:** `bun --preload @znight/compiler/bun <emitter> <outFile>`. The preload serves the
     module and blanks decorators.
   - **Node:** a Vite server in middleware mode with the project config (`appType: 'custom'`,
     `server.hmr: false`, no watcher). When `isRunnableDevEnvironment(server.environments.ssr)`
     holds, `server.environments.ssr.runner.import(outFile)`. The `znight()` plugin strips the
     decorators and serves the module from memory.
   - **Nothing is instantiated:** no container, no plugin, no port. Only the module graph of the
     generated file is evaluated. `NODE_ENV` defaults to `production`.
4. `buildOpenApiDocument(metadata, { prefix, converters })`. ZNIGHT037/034 make the command exit 1.
5. Write each output (JSON, or YAML by extension) atomically, only when it changed. With `check`,
   never write. A stale or missing output gives exit 1 and lists the files. The Vite plugin then
   fails the build, as `generate --check` does.

## 8. Runtime architecture

### 8.1 Plugin lifecycle

| Hook                                                      | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `register`                                                | Throws ZNIGHT030 when `metadata.extensions.openapi` is missing or malformed, or when no plugin named `http` is registered (hint: `HttpPlugin.configure()`). Registers the `OpenApi` external value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `httpRoutes()` (called by `HttpPlugin.onBootstrap`, §8.2) | Resolves the options (memoised, container ready) and returns the docs routes, or `[]` when disabled                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `onBootstrap`                                             | Resolves the options (memoised) and reads `http.prefix`. In `'boot'` mode, it builds the document and precomputes the response bodies (JSON bytes and strong ETag, YAML, UI HTML with its CSP), then logs `OpenAPI document built` (debug: operations, schemas, ms). In `{ file }` mode, it reads and parses the file, checks `openapi: 3.1.x` and compares `x-znight-fingerprint` with the metadata (ZNIGHT030 warning when stale); **as implemented**, it then applies `filter`, `info`, `servers` and `transform` to the file, and gives a file without `servers` `[{ url: prefix }]` under an HTTP prefix (ZNIGHT030 warning, §5.8). Checks that declared relative servers (or those of the file) end with the HTTP prefix (ZNIGHT030 warning) |
| `onReady`                                                 | Logs `API reference: <address><prefix>/docs` (info) when the UI is on and the server listens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `onStop`                                                  | Nothing: HttpPlugin drains the docs requests like any other                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `onDispose`                                               | Drops the cached bodies and resets the instance, which can then serve another application (shared test setups, like HttpPlugin)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

`initRoots()` returns the classes of the `guards` option (the `PluginInitRoots` contract), so
`TestApp` creates them at boot.

### 8.2 Integration with `@znight/http`

The docs routes are **plugin routes** (prerequisite H1). They are not generated controllers, for
three reasons: their paths are runtime options, they can be disabled per environment, and they need
no compiled metadata.

- `HttpPlugin.onBootstrap` collects the routes of every plugin of `ctx.app.plugins` that
  implements `httpRoutes()`. It does so after the compiled routes, so the plugin order does not
  matter.
- These routes are registered through `adapter.registerRoute`, in the **same pipeline**:
  `http:request` hook, request scope, global guards, then the guards of the route, the handler, the
  exception mappers.
- Behaviour is therefore identical on node, Fastify (inside Znight's encapsulated context), Express
  (Znight's router) and Hono (`Bun.serve()` on Bun, `@hono/node-server` on Node).
- Paths follow the controller grammar and the prefix. A collision with a controller route is
  ZNIGHT007, naming the plugin.
- `meta` entries are the route metadata: guards read them (`Public.get(ctx)`), and the RFC 0001
  boot check sees the `access` decision. Without one, a required group fails the boot, and the hint
  names `OpenApiPlugin.configure({ meta: [Public.meta()] })`.
- `HttpPlugin.routes` lists them with `source: 'openapi'`.

### 8.3 Serving

| Route                    | Response                                                                                                                                                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET {path}`             | Precomputed `Uint8Array`, `content-type: application/json; charset=utf-8`, strong `etag` (`"<base64url SHA-256, 27 characters>"`), `cache-control` option. `if-none-match` gives 304. HEAD is automatic                                                              |
| `GET {yaml}`             | The same, with `application/yaml` (RFC 9512)                                                                                                                                                                                                                         |
| `GET {uiPath}`           | HTML page (below), with its own `content-security-policy`. RFC 0001 security headers never override a header the handler set, so this CSP wins over their default                                                                                                    |
| `GET {uiPath}/_assets/*` | `assets: 'local'` only. `HttpResponse.file(name, { root: <package dist> })`. The path is versioned (`_assets/scalar@1.x.y/standalone.js`), so `cache-control: public, max-age=31536000, immutable`. Ranges and 304 are free, and `sendfile` is used on `Bun.serve()` |

**UI page.**

- **Scalar:** `<div id="app">`, the standalone script, then
  `Scalar.createApiReference('#app', { url, withDefaultFonts: false, ...config })`.
- **Swagger UI:** `swagger-ui.css`, `swagger-ui-bundle.js`, then
  `SwaggerUIBundle({ url, dom_id: '#swagger-ui', validatorUrl: null, ...config })`.
- The inline script is fixed at boot, so the CSP allows it by hash (`'sha256-…'`), with no nonce.
  The page is cacheable.

The CSP:

```text
default-src 'none'; script-src 'self' <cdn> 'sha256-…'; style-src 'self' 'unsafe-inline' <cdn>;
img-src 'self' data: https:; font-src 'self' data: <cdn>; connect-src 'self' <server origins>;
frame-ancestors 'none'; base-uri 'none'; form-action 'none'
```

> **As implemented** (v0.1, after the wave 6 review): `connect-src` lists the origins of the
> servers of the served document in every build mode. With `'first-request'`, the first request
> of the page builds the document; when that build fails, the page allows the declared servers
> (static, or the `servers` option) and is not cached. The installed UI package is found from
> `@znight/openapi`, then from the working directory, through `<package>/package.json` when it
> resolves, else in the `node_modules` directories of the resolution paths (manifest `name`
> checked): `@scalar/api-reference`, whose exports map hides its manifest, is found on Node.js as
> on Bun.

**Third parties.** None, except the pinned CDN, and none at all with local assets. Scalar's fonts
are disabled, and so are its proxy and the Swagger validator.

**CDN pins.** The CDN URLs and their SRI hashes are constants of each `@znight/openapi` release,
bumped by Renovate. A network test (`ZNIGHT_NETWORK=1`) checks the hashes.

### 8.4 Build modes, scopes, hooks, shutdown, runtimes

- **Build modes.**
  - `'boot'` (default): fail fast. A broken schema fails `Application.create` with ZNIGHT037, the
    way a missing configuration value fails with ZNIGHT006.
  - `'first-request'`: one shared promise. Concurrent first requests wait for it. A failure answers
    500, is logged once, and the next request tries again.
  - `{ file }`: the bytes are read once. No converter and no schema library code run. **As
    implemented:** `filter`, `info`, `servers` and `transform` apply to the file (§5.8); the bytes
    are served as read when none of them applies and the file needs no `servers` default.
- **Scopes.** `OpenApi` is a singleton value. The handlers of the docs routes resolve nothing
  per request. Guards of the `guards` option may be request-scoped: they are resolved per request
  like global guards. The pipeline opens a request scope for every request anyway.
- **Hooks and observability.**
  - Docs requests go through `http:request`, like every request: logs, RED metrics labelled with
    the route pattern (`/openapi.json`, `/docs`, `/docs/_assets/*`), spans. The README shows
    `logging.requests.ignore: e => e.route?.startsWith('/docs')`.
  - No new hook in v0.1. An `openapi:build` hook would have one producer and no consumer. The build
    is reported by logs (debug: stats; warn: each warning once, with its code).
- **Graceful shutdown.** Nothing to drain beyond HttpPlugin's in-flight accounting. An asset still
  being sent as a file body keeps its request in flight until it is sent, like any file.
- **HMR** (`hot: import.meta.hot`): the old application stops, and the new one builds its document
  again.
- **Node 24 and Bun.**
  - Everything is standard: `node:crypto` `createHash`, `import.meta.resolve` for local assets, Web
    streams.
  - Emission chooses the runtime that loads the modules (`--runtime`). The emitted file must be
    byte-identical on both, and a test checks it.

## 9. Changes to other packages

### 9.1 `@znight/compiler` (additive under extension `apiVersion: 1`; the lockstep check ZNIGHT018 guarantees that a matching compiler is present)

| #   | Change                                                                                                                                                                                                                                                                                                | Priority               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| C1  | `TypeHelpers.shape()` and the `Shape` model (§6.2): declarations from sources and `.d.ts`, utility types, generics, recursion through `named`, schema aliases, JSDoc. Cached by declaration content hash. Files read are added to `watchFiles`. Covered by the golden test of §4.1 (source vs `dist`) | P0                     |
| C2  | JSDoc: `ClassInfo.doc`, `MethodInfo.doc`, `PropertyInfo.doc`: `{ summary, description, tags: { name, text }[] }`, from the leading `/** */` comment (oxc `comments`)                                                                                                                                  | P0                     |
| C3  | `DecoratorInfo.typeArgs: readonly TypeInfo[]` (`@ApiResponse<Book[]>(200)`), also usable as a `ShapeTarget`                                                                                                                                                                                           | P1 (`@ApiResponse<T>`) |
| C4  | `ParameterInfo.initializer: ArgInfo \| undefined`, evaluated as a `value` (defaults of parameters)                                                                                                                                                                                                    | P1                     |
| C5  | `ValidateContext.storedOf<T>(extension)` / `GenerateContext.storedOf<T>(extension)`: typed sugar over `graph.extensions`                                                                                                                                                                              | P2                     |

### 9.2 `@znight/http`

| #   | Change                                                                                                                                                                                                                                                                                                                                              | Priority |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| H1  | **Plugin routes**: the `PluginHttpRoutes` contract, `httpRoutes(context: { prefix, container }): readonly PluginRoute[]`, with `PluginRoute = { method, path, name, handler(ctx), meta?, guards? }`. Collected in `onBootstrap` from `ctx.app.plugins`, validated (grammar, ZNIGHT007 conflicts naming the plugin), registered in the same pipeline | P0       |
| H2  | `HttpPlugin.prefix` (getter). Option resolution is memoised per application (reset in `register`), so another plugin can read it before or after `onBootstrap`                                                                                                                                                                                      | P0       |
| H3  | `RouteDecorator.meta(value?)` returns `{ key, value }` (`RouteMetaEntry`), for plugin routes (`Public.meta()`, `Roles.meta(['admin'])`). It carries `group` once RFC 0001 lands                                                                                                                                                                     | P0       |
| H4  | `MetaEntry.identity`: the canonical identity of the decorator `const` (needed by `decisions`). RFC 0001 already adds `decorator` and `definition`                                                                                                                                                                                                   | P0       |
| H5  | `HttpResponse.created<T>(body: T, location?): HttpResponse<T>` and `accepted<T>(body: T)` overloads, so that `Promise<HttpResponse<BookResponse>>` type-checks                                                                                                                                                                                      | P1       |
| H6  | "Compiler contract for other extensions" (README): `HttpControllerData`, `HttpRouteData`, `HttpParamData`, `UploadData`, `MetaEntry` become a documented contract, covered by the lockstep release line. Adds `HttpParamData.defaultValue?: StaticValue` (from C4)                                                                                  | P1       |
| H7  | `HttpRouteSummary.source` (`'controller'` or the plugin name), plus `meta` (effective metadata, also planned by RFC 0001 §5.3), used by `filter`                                                                                                                                                                                                    | P1       |

### 9.3 `@znight/core`

ZNIGHT030–037 in `ErrorCode` and `ERROR_DESCRIPTIONS`, and the code range policy in the comment of
the catalogue (P0).

### 9.4 `@znight/cli`

- `znight openapi` (P0): `-o/--output` (repeatable), `--check`, `--prefix`, `--runtime
  <auto|node|bun>`, `--converters`, `--root`, `--config`, `--config-loader`.
- `znight build --openapi[=path]` (P1): adds `openapi()` to the inline Vite config when the config
  has none. **As implemented:** `--openapi-prefix <path>` passes the HTTP prefix (§5.8; a usage
  error without `--openapi`), and a warning says when the config's own `openapi()` makes both
  options inapplicable.
- `znight new --features openapi` (P2): adds the plugin, `src/api.ts` with `@OpenApiDocument`, and
  an `openapi` script.
- `@znight/openapi` becomes an optional peer of the CLI. A command that needs it fails with an
  install hint when it is missing.

### 9.5 `@znight/testing`

No change.

### 9.6 Specification and documentation

- **`docs/internals/architecture.md`:**
  - §4.8: codes and the range policy;
  - §5: the `@znight/openapi` catalogue;
  - §6.5: C1–C5;
  - §7: the manifest table;
  - new §9.5 "OpenAPI": metadata, assembly, plugin;
  - §9.1: plugin routes and `prefix`;
  - §11: the CLI commands.
- **New pages:** `packages/openapi/README.md`, `docs/packages/openapi.md` and `docs/guide/openapi.md`
  (inference rules, recipes: problem details, OAuth2 scopes from roles, hiding internal routes,
  typed clients).
- **Updated pages:** `docs/reference/decorators.md`, `docs/reference/error-codes.md`, the feature
  list of the root README, `migrating-from-nestjs.md` (`@nestjs/swagger` → `@znight/openapi`
  table).

## 10. Dependencies

| Package                                                                                             | Kind               | Range         | Why                                                                                                                                            |
| --------------------------------------------------------------------------------------------------- | ------------------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `@znight/core`                                                                                      | dependency         | `workspace:*` | Like every feature package                                                                                                                     |
| `@znight/http`                                                                                      | **peer, required** | `workspace:^` | One copy of `HttpPlugin`, `HttpResponse` and `HttpContext` in the application. A second copy would break plugin routes and `instanceof` checks |
| `@znight/compiler`                                                                                  | optional peer      | `workspace:^` | Compiler entry, emission, Vite plugin                                                                                                          |
| `vite`                                                                                              | optional peer      | `^8.0.0`      | Emission on Node, `@znight/openapi/vite`                                                                                                       |
| `@valibot/to-json-schema`                                                                           | optional peer      | `^1.5.0`      | Valibot conversion. `toStandardJsonSchema()` exists from 1.5 according to standardschema.dev; not installed here, verify at implementation     |
| `yaml`                                                                                              | optional peer      | `^2.0.0`      | YAML output. Same range as `@znight/config` (2.9.1 installed)                                                                                  |
| `@scalar/api-reference`                                                                             | optional peer      | `^1.0.0`      | Local Scalar assets (`dist/browser/standalone.js`). Not installed here; the jsDelivr builds go up to 1.48 at least                             |
| `swagger-ui-dist`                                                                                   | optional peer      | `^5.0.0`      | Local Swagger UI assets                                                                                                                        |
| `@cfworker/json-schema`                                                                             | optional peer      | `^4.1.0`      | `validateResponse()`: JSON Schema 2020-12, no `eval`, Bun, Node and edge                                                                       |
| `zod` (catalog 4.6.7), `valibot` 1.5.0, `@valibot/to-json-schema`, `arktype` ≥ 2.1.28, `yaml` 2.9.1 | devDependencies    | exact         | Converter tests against real libraries                                                                                                         |
| `@seriousme/openapi-schema-validator`                                                               | devDependency      | exact         | Every fixture document is validated against the OpenAPI 3.1 schema (the package also lists 3.2)                                                |

**Not used, and why:**

- `@nestjs/swagger`, `@fastify/swagger`: bound to one framework or one adapter.
- `zod-openapi`, `@asteasolutions/zod-to-openapi`: Zod only, and they extend Zod.
- `ts-json-schema-generator`, `typia`, `tsoa`: they need the TypeScript checker, while the compiler
  is oxc only.
- `ajv` in the runtime: code generation and size. It is fine in tests, but `@cfworker/json-schema`
  suffices.
- `openapi-types` / `openapi3-ts`: our own types avoid a dependency and fit
  `exactOptionalPropertyTypes`.
- `@standard-schema/spec`: the types are copied and flattened, as `@znight/http` does.

Facts checked in `node_modules`: Zod 4.6.7 implements `~standard.jsonSchema` and forwards
`libraryOptions`; Valibot 1.5.0 core does not. From the web (October 2026), to verify at
implementation:

- the standardschema.dev implementer table: Zod ≥ 4.2, ArkType ≥ 2.1.28, Valibot through
  `@valibot/to-json-schema` ≥ 1.5;
- Scalar's `createApiReference` CDN API;
- Vite's `isRunnableDevEnvironment` / `runner.import`;
- OpenAPI 3.2.0 (September 2025), supported by Swagger tooling since April 2026.

## 11. Alternatives considered

| Alternative                                                                         | Verdict                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Convert Standard Schemas **inside the compiler** by loading the application modules | Rejected. It breaks the purity and determinism of `compile()` (the output would depend on library versions loaded at compile time), and incremental compiles (re-evaluate on any change of the runtime module graph). It also needs a module runner in the Vite plugin, the preload and the CLI. The emitter does the same at the right place (§7.5) |
| **Translate Zod/Valibot code statically** (AST patterns)                            | Rejected. It is wrong for transforms, refinements, `pipe`, spreads and imported fragments, and breaks with each library release                                                                                                                                                                                                                      |
| **Build everything at runtime** from the metadata (`@nestjs/swagger` style)         | Rejected. No build-time checks, and the document cannot be produced without booting. We keep the runtime part for schema values only                                                                                                                                                                                                                 |
| **Use the TypeScript type checker** (Nest CLI plugin, tsoa, typia)                  | Rejected. It is slow, it is a second compiler, and it goes against "oxc only". Annotated return types, which `isolatedDeclarations` style already favours, are enough                                                                                                                                                                                |
| **OpenAPI inside `@znight/http`**                                                   | Rejected. UI assets, converters, emission and optional peers for every HTTP service                                                                                                                                                                                                                                                                  |
| **A generated controller** for the docs routes                                      | Rejected. Static paths, cannot be disabled per environment, adds compiled metadata to apps that do not use it                                                                                                                                                                                                                                        |
| **Push-based registration** (`http.addRoute()` from another plugin's `register`)    | Rejected. It depends on the plugin order and on HttpPlugin resetting its state in `register`                                                                                                                                                                                                                                                         |
| **Document options in `znight.config.ts`** (`extensions: [openapi({...})]`)         | Rejected. The config cannot reference the application's schemes and route decorators by identity without executing application code in the compiler process                                                                                                                                                                                          |
| **OpenAPI 3.0 output**                                                              | Rejected. 3.1 uses JSON Schema 2020-12, the default target of Standard JSON Schema, so no down-conversion is needed                                                                                                                                                                                                                                  |
| **`@ApiProperty` on DTO classes**                                                   | Rejected. Duplicates TypeScript; JSDoc carries the same information                                                                                                                                                                                                                                                                                  |

## 12. Open questions (with recommended answers)

| #   | Question                                                                                                                  | Recommendation                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Emit OpenAPI 3.2.0 (September 2025: `itemSchema` for streams and SSE, `query` method, tag hierarchy)?                     | **3.1.1 by default in v0.1.** Swagger tooling supports 3.2 since April 2026, but generators and gateways lag behind. Add `openapi: '3.2.0'` in v0.2 behind `@OpenApiDocument({ version })`, starting with `itemSchema` for `@Sse` and NDJSON |
| Q2  | Serve the docs in production by default?                                                                                  | **Yes for the JSON, yes for the UI, both easy to turn off** (`enabled`, `ui: false`, `meta`, `guards`). The guide recommends a decision: public, admin-only or disabled. Environment-dependent defaults surprise people                      |
| Q3  | Default build mode: `'boot'` or `'first-request'`?                                                                        | **`'boot'`** (fail fast, principle 7). Serverless deployments use `{ file }` (zero cost), not `'first-request'`                                                                                                                              |
| Q4  | Default operation id style?                                                                                               | **`controller.handler`** (`book.list`): stable when other controllers are added, readable in generated clients (Hey API makes `bookList`)                                                                                                    |
| Q5  | Should TypeScript-only request bodies (no schema) be documented?                                                          | **Yes**, with ZNIGHT017 unchanged. The document describes the wire, and validation stays a separate concern                                                                                                                                  |
| Q6  | Validate responses against the document in development?                                                                   | **No in v0.1.** It costs per request and duplicates `validateResponse()` in tests. Reconsider as a dev-only interceptor in v0.2                                                                                                              |
| Q7  | Several documents (public and internal)?                                                                                  | **v0.2** with `@OpenApiDocument({ name })` and a `document` option per plugin route. v0.1 has one document and `filter`                                                                                                                      |
| Q8  | `storedOf()` (C5) or `graph.extensions` directly?                                                                         | Read `graph.extensions` in M1. Add `storedOf` when a third extension needs another's data                                                                                                                                                    |
| Q9  | Self-host the UI by default (`@scalar/api-reference` as a dependency)?                                                    | **No**: it is several MB for an optional feature. `'auto'` serves it locally as soon as it is installed. The pinned CDN has SRI                                                                                                              |
| Q10 | Document `x-request-id` on every response?                                                                                | **No by default** (noise). A recipe shows it with `transform`                                                                                                                                                                                |
| Q11 | Should a security `decision` be expressible on the RFC 0001 group (`{ group: 'access', ... }`) rather than per decorator? | **Per decorator.** It is precise (Roles → scopes), works without RFC 0001, and groups can be added later without breaking anything                                                                                                           |

## 13. Implementation plan

### 13.1 Milestones

| Milestone                  | Content                                                                                                                                             | Exit criteria                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| M0, prerequisites          | C1–C4, H1–H4, core codes                                                                                                                            | Every package test green. Golden test byte-identical. `generate --check` green for every example (no change to their output) |
| M1, document from metadata | Package skeleton, decorators, types, manifest, boundaries. Compiler extension (analyse, validate, generate). `buildOpenApiDocument` with converters | Fixture applications give documents valid against OpenAPI 3.1. Diagnostics 030–037 are snapshotted with their locations      |
| M2, serving                | `OpenApiPlugin`: JSON, YAML, ETag, `{ file }`, `OpenApi` external, UI (Scalar, Swagger), CDN with SRI, local assets, CSP                            | Shared adapter suite green on four adapters plus `Bun.serve()`                                                               |
| M3, emission and testing   | `emitOpenApi`, `znight openapi`, `build --openapi`, Vite plugin, `--check`, `@znight/openapi/testing`                                               | The emitted file is byte-identical with `--runtime node` and `bun`, and equal to the served one                              |
| M4, docs and example       | Spec, README, guide, reference pages, wave 7 example                                                                                                | Docs tests (imports, error codes) green. Example tests and e2e on Node and Bun                                               |

### 13.2 Tasks and effort (one developer)

| #   | Task                                                                                    | Days       |
| --- | --------------------------------------------------------------------------------------- | ---------- |
| T1  | C2 JSDoc, C3 decorator type arguments, C4 initialisers                                  | 1.5        |
| T2  | C1 shape resolver, with fixtures and a golden test (source vs `.d.ts`)                  | 4          |
| T3  | H1–H7 (plugin routes, prefix, `meta()`, identity, overloads, contract)                  | 2          |
| T4  | Core codes, `ERROR_DESCRIPTIONS`, error-codes page                                      | 0.5        |
| T5  | Package skeleton, decorators, OpenAPI types, manifest, boundaries                       | 1          |
| T6  | Extension: operations, parameters, bodies, responses, security, tags, ids, diagnostics  | 5          |
| T7  | Generate, fingerprint, metadata contract                                                | 1          |
| T8  | `buildOpenApiDocument`: converters, hoisting, placeholders, names, pruning, determinism | 3          |
| T9  | `OpenApiPlugin`: serving, ETag, YAML, `{ file }`, logs, `initRoots`                     | 2          |
| T10 | UI: Scalar and Swagger, CDN with SRI, local assets, CSP                                 | 1.5        |
| T11 | Emission: API, CLI command and flag, Vite plugin, `--check`, both runtimes              | 3          |
| T12 | `@znight/openapi/testing`                                                               | 1          |
| T13 | Spec, README, guide, reference pages                                                    | 2          |
| T14 | Wave 7 example (§14)                                                                    | 3          |
|     | **Total**                                                                               | **≈ 30.5** |

Order: T4, T1, T3 (independent pull requests), then T2, T5–T8 (M1), T9–T10 (M2), T11–T12 (M3),
T13–T14 (M4).

### 13.3 Test plan

- **Compiler, `packages/compiler/test`.**
  - **Shapes:**
    - primitives, literals, unions, nullables, optional properties, arrays, tuples;
    - interfaces with `extends`, aliases, classes (fields, parameter properties, getters excluded,
      `toJSON`), records, index signatures;
    - `Partial`, `Pick`, `Omit`, `Required`, `Readonly`, `NonNullable`, generics and nested
      generics, recursion;
    - discriminated unions, enums, `Date`, `URL`, `bigint`, `Map`;
    - the schema aliases of Zod, Valibot, ArkType and Standard Schema, resolved against the installed
      `.d.ts`;
    - JSDoc tags, including invalid values.
  - **Golden:** the same fixture library from sources and from `dist` gives identical shapes.
  - **Watch:** editing an interface in another file recompiles, and the shape changes.
- **Extension, `packages/openapi/test/compiler`, fixture applications through `compile()`.**
  - The generated section is snapshotted, deterministic across two compiles, and the same with
    incremental compiles.
  - Each diagnostic 030–036 is reported, and not reported, with its location, related locations
    and hints (formatted snapshots).
  - Interplay: ZNIGHT017, a controller from a source library, `@All`, the wildcard, uploads,
    `@Validate`, `@Res()`, decision mapping with and without RFC 0001 groups.
  - Performance: the 200-route / 150-schema fixture adds ≤ 15% to compile time.
- **Assembly, `buildOpenApiDocument`.**
  - Zod 4.6.7 (input vs output with transforms and defaults; `z.date()` output mapped), Valibot
    1.5.0 through `@valibot/to-json-schema`, ArkType ≥ 2.1.28, a user converter.
  - `$defs` hoisting and reference rewriting, `XInput` naming, conflicts (ZNIGHT034).
  - Whole-object query explosion, ZNIGHT037, `unrepresentable: 'warn'`.
  - `filter` with pruning, `transform`, runtime `info` / `servers` and prefix.
  - Every output validated with `@seriousme/openapi-schema-validator` (3.1).
  - Determinism: run twice, `JSON.stringify` equal, on Node and Bun.
  - Budget: 150 schemas in < 25 ms on both runtimes (benchmark, reported, not flaky-gated).
- **Plugin, `packages/openapi/test/runtime`.**
  - Lifecycle: register without http, without metadata, function options, reuse after dispose,
    `initRoots`.
  - Modes: `boot`, `first-request` (concurrent first requests, retry after failure), `{ file }`
    (fresh and stale fingerprints).
  - Behaviour: ETag and 304, HEAD, `cache-control`, YAML with and without the peer, `meta`, `guards`
    (401 and 403 through a global AuthGuard), docs path collision (ZNIGHT007), `enabled: false`.
- **Adapters.** The docs routes join the shared adapter suite (`adapters.test.ts`: node, Fastify,
  Express, Hono) and `hono-bun.test.ts` (`Bun.serve()`, `sendfile` of local assets).
- **UI.** The HTML contains the expected script and config. The CSP hash matches the inline script.
  Local assets come with `immutable`. CDN mode has SRI attributes. A network test checks the pinned
  hashes (`ZNIGHT_NETWORK=1`).
- **Emission.** Fixture projects under `ZNIGHT_E2E=1`:
  - `--runtime node` and `--runtime bun` give byte-identical files;
  - `--check` with fresh, stale and missing files;
  - YAML output, converters module;
  - compile errors exit 1 before any module runs;
  - module side effects stay in the child process (a fixture module that sets a global);
  - the Vite plugin in `vite build` and `vite build --watch`.
- **Testing helpers.** `validateResponse` matches statuses (code, `NXX`, `default`), media types,
  headers and bodies, follows `$ref`, and reports readable paths.
- **Examples and docs.** The wave 7 example tests and e2e on Node and Bun, `docs/test` (guide
  imports, error codes listed), and `tests/boundaries.test.ts` (the compiler entry imports only types
  and `@znight/http/compiler` types).

## 14. Wave 7 example: `examples/storefront-api`

**Purpose.** The tested reference of everything in this RFC, and the proof of end-to-end types: the
server code produces `openapi.json` (committed, checked in CI), which produces a typed client used
by the example's own end-to-end tests.

**Domain.** A small shop:

- a public catalogue of products, with images;
- carts and orders for customers (bearer token);
- a back office (API key, admin);
- an order export as NDJSON;
- a health endpoint.

Repositories live in memory, because the data layer is the subject of rest-api.

**Stack.**

- `honoAdapter()`: `Bun.serve()` on Bun, `@hono/node-server` on Node. No other example covers Hono.
- Zod for the catalogue, Valibot (with `@valibot/to-json-schema`) for orders, TypeScript interfaces
  with JSDoc for responses.
- `@znight/config`, Scalar with local assets.
- Client side: `openapi-typescript` and `openapi-fetch` at their current majors.
- Trivial token and key verifiers from the configuration: real JWT is the subject of secure-api
  (RFC 0001).

| Route                            | Shows                                                                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /products`                  | Query coercion (enum sort, arrays, defaults with `default`), `Page<ProductSummary>` generic, JSDoc `@param`, public through `decisions` |
| `GET /products/:id`              | Path parameter, `ProductResponse` with `Date`, nullable and enum fields, documented 404                                                 |
| `POST /products`                 | Zod body with transforms (`CreateProduct` and `CreateProductInput`), API key, 201 with a `location` header, 409                         |
| `PUT /products/:id/image`        | Upload: `multipart/form-data`, `contentMediaType`, `encoding`, size limit, 413 and 415                                                  |
| `GET /products/:id/image`        | Binary response with several media types, public                                                                                        |
| `POST /carts/:id/items`          | Valibot body (fallback converter), bearer                                                                                               |
| `POST /orders`                   | Discriminated union `Card \| Transfer` → `oneOf` + `discriminator`, Valibot                                                             |
| `GET /orders/export`             | `@ApiResponse<Order>(200, { contentType: 'application/x-ndjson' })`, `HttpResponse.stream`, admin                                       |
| `GET /admin/stats`               | `@ApiSecurity(ApiKey)` on the controller, overriding the document default (bearer)                                                      |
| `GET /health`                    | `@ApiExclude()`                                                                                                                         |
| `GET /openapi.json`, `GET /docs` | The plugin, with `meta: [Public.meta()]`                                                                                                |

**Layout:**

```text
examples/storefront-api/
├─ src/
│  ├─ main.ts                 Application.create() with the plugins of http.ts
│  ├─ http.ts                 HttpPlugin (hono) + OpenApiPlugin options, shared with the tests
│  ├─ api.ts                  @OpenApiDocument, securityScheme('bearer'), securityScheme('apiKey'), decisions
│  ├─ auth/                   Public, Roles (createRouteDecorator), AuthGuard (bearer or API key), CurrentCustomer
│  ├─ catalog/                ProductController, product.schemas.ts (Zod), product.ts (response types + JSDoc), repository
│  ├─ carts/  orders/         controllers, Valibot schemas, Order (discriminated payment), NDJSON export
│  ├─ admin/  health/
│  └─ openapi.converters.ts   empty array, documented (where an Effect converter would go)
├─ openapi.json               committed; `bun run openapi:check` in CI
├─ client/
│  ├─ schema.d.ts             generated by `bun run client:generate` (openapi-typescript), committed
│  └─ client.ts               createClient<paths>() (openapi-fetch)
├─ test/                      see below
├─ vite.config.ts             znight(options) + openapi({ output: ['openapi.json', 'dist/openapi.json'], check: CI })
├─ znight.config.ts
└─ README.md                  "What it shows", "Typed client", "Try breaking it"
```

**Scripts.**

- `openapi` (`znight openapi`) and `openapi:check` (`--check`);
- `client:generate`, then `typecheck`, which also type-checks `client/` against `schema.d.ts`;
- `build` (`znight build`: `dist/main.js` and `dist/openapi.json`);
- `start`: production serves `dist/openapi.json` through `document: { file }`.

**Tests** (`bun test`, plus e2e runs gated by `ZNIGHT_E2E`):

- **`document.test.ts`.**
  - The served document is byte-identical to `openapi.json`.
  - `openapi.json` is valid OpenAPI 3.1.
  - The operation view is snapshotted: ids, tags, security per route. It is the access matrix of
    the documentation.
- **`contract.http.test.ts`.** Every route through `app.inject()` and `validateResponse()`: the 2xx
  and each documented error (400 with `details`, 401, 404, 409, 413, 415).
- **`docs.http.test.ts`.** `/docs` HTML with its CSP. A local asset gets 200 with `immutable`.
  `/openapi.json` gets ETag and 304, and HEAD.
- **`build-check.test.ts`** keeps "Try breaking it" honest. Fixtures compiled through `compile()`
  give:
  - ZNIGHT031 when a return annotation is removed;
  - ZNIGHT032 for a `bigint` total;
  - ZNIGHT033 for two `ProductController`s;
  - ZNIGHT036 for an undeclared scope.
- **`emit.e2e.test.ts`.** `znight openapi --check` passes. `--runtime node` and `--runtime bun`
  write identical files. `znight build` writes `dist/openapi.json` equal to the committed file.
- **`client.e2e.test.ts`.** Builds, runs the bundle on Node and on Bun, then calls it with the
  typed client: list products, create one with the API key, place an order with a card. Its types
  come from `openapi.json`, so a server change that breaks the contract fails `typecheck`.

The guide (`docs/guide/openapi.md`) links every rule of §5.4 to a file and a test of this example.
`examples/rest-api` gets `@OpenApiDocument` and the H5 annotations in a follow-up pull request
(about 30 lines), which shows the migration path from an existing application.
