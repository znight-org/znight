# Storefront API

A small shop built with [Znight](../../README.md): a public catalogue of products with their images,
carts and orders for the customers (bearer token), a back office (API key) with an order export, served
by **Hono**. It is the reference example of [`@znight/openapi`](../../packages/openapi/README.md):

- the **OpenAPI 3.1 document is generated from the code**: paths and parameters from the route table,
  request bodies from the Zod and Valibot schemas, responses from the annotated return types,
  descriptions from the JSDoc, and checked at build time like the dependency graph;
- it is **committed** ([`openapi.json`](openapi.json)), **served** byte for byte (`/openapi.json`,
  `/docs`) and **checked** in CI (`bun run openapi:check`);
- a **typed client** is generated from it ([`src/client/`](src/client)), and the example's own
  end-to-end tests use that client against the production build, on Node.js and on Bun.

Repositories live in memory: the data layer is the subject of [`examples/rest-api`](../rest-api), real
authentication (JWT, sessions) the subject of [`examples/secure-api`](../secure-api).

## What it shows

| Feature                                                                                                      | Where                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| The document: `@OpenApiDocument`, `securityScheme()` (bearer and API key), `decisions`                       | [`api.ts`](src/api.ts)                                                                                                         |
| Query parameters: coercion, enums, arrays, defaults, JSDoc `@param`                                          | `GET /products` in [`catalog/product.controller.ts`](src/catalog/product.controller.ts)                                        |
| Responses from TypeScript interfaces, JSDoc tags as JSON Schema keywords (`@format`, `@example`, `@minimum`) | [`catalog/product.ts`](src/catalog/product.ts), [`carts/cart.ts`](src/carts/cart.ts), [`orders/order.ts`](src/orders/order.ts) |
| A generic response, `Page<ProductSummary>` → `Page_ProductSummary`                                           | [`shared/page.ts`](src/shared/page.ts)                                                                                         |
| Zod bodies with transforms: one schema, an **input** and an **output** component                             | [`catalog/product.schemas.ts`](src/catalog/product.schemas.ts), `POST /products/validate`                                      |
| Valibot bodies (`@valibot/to-json-schema`)                                                                   | [`carts/cart.schemas.ts`](src/carts/cart.schemas.ts), [`orders/order.schemas.ts`](src/orders/order.schemas.ts)                 |
| Discriminated unions → `oneOf` + `discriminator`, in responses (TypeScript) and requests (Valibot)           | [`orders/order.ts`](src/orders/order.ts), [`openapi.converters.ts`](src/openapi.converters.ts)                                 |
| A path parameter validated by a schema (`@Param('id', Id)`), documented as a component                       | [`shared/id.ts`](src/shared/id.ts)                                                                                             |
| Upload (`multipart/form-data`, size limit, media types: `413`, `415`) and binary download (`206`, `304`)     | `PUT` / `GET /products/:id/image`                                                                                              |
| A streamed NDJSON export, `@ApiResponse<Order>(200, { contentType })`                                        | `GET /orders/export` in [`orders/order.controller.ts`](src/orders/order.controller.ts)                                         |
| Security per controller and route (`@ApiSecurity`), error responses shared as constants                      | [`admin/admin.controller.ts`](src/admin/admin.controller.ts), [`shared/responses.ts`](src/shared/responses.ts)                 |
| An undocumented route (`@ApiExclude()`)                                                                      | [`health/health.controller.ts`](src/health/health.controller.ts)                                                               |
| `OpenApiPlugin`: `/openapi.json`, Scalar on `/docs`, `DOCS=false`, the prebuilt file in production           | [`http.ts`](src/http.ts), [`main.ts`](src/main.ts)                                                                             |
| Emission at build time and in CI, a custom schema converter                                                  | [`vite.config.ts`](vite.config.ts), [`package.json`](package.json), [`openapi.converters.ts`](src/openapi.converters.ts)       |
| A typed client: `openapi-typescript` + `openapi-fetch`                                                       | [`client/client.ts`](src/client/client.ts), [`client/schema.d.ts`](src/client/schema.d.ts)                                     |
| The Hono adapter: `Bun.serve()` on Bun, `@hono/node-server` on Node.js                                       | [`http.ts`](src/http.ts)                                                                                                       |
| Access decisions (`@Public()` / `@Roles()`), a request-scoped customer read through `Lazy<T>`                | [`auth/`](src/auth)                                                                                                            |
| `@Config` classes with `@Secret` values (a JSON record of tokens)                                            | [`config/`](src/config), [`.env.development`](.env.development)                                                                |
| Contract tests (`validateResponse()` on every documented response), document checks, `TestBed`, e2e          | [`test/`](test)                                                                                                                |

## Run it

Requirements: Node.js 24+ or Bun 1.3+. In this repository, install and build the framework once,
from the repository root: `bun install && bun run build` (the CLI and the production build use the
packages' `dist`).

```sh
bun run dev          # or: npm run dev
```

`dev` builds the application in watch mode and restarts it on every change, with
`NODE_ENV=development`: [`.env.development`](.env.development) provides development keys and tokens,
debug logs and three sample products. The API listens on <http://localhost:3000>, its reference on
<http://localhost:3000/docs>.

| Script            | bun                       | npm / Node.js             | Does                                                                                  |
| ----------------- | ------------------------- | ------------------------- | ------------------------------------------------------------------------------------- |
| `dev`             | `bun run dev`             | `npm run dev`             | `znight dev`: build in watch mode, restart on change                                  |
| `build`           | `bun run build`           | `npm run build`           | `znight build`: `dist/main.js` and `dist/openapi.json` (fails on any DI or API error) |
| `start`           | `bun run start`           | `npm run start`           | `znight start`: runs `dist/main.js` with `NODE_ENV=production`                        |
| `test`            | `bun run test`            | —                         | `openapi:check`, then unit, HTTP, contract and document tests (`bun test`)            |
| `test:e2e`        | `bun run test:e2e`        | —                         | builds, runs the bundle on Node.js **and** Bun with the typed client, emits on both   |
| `typecheck`       | `bun run typecheck`       | `npm run typecheck`       | generates the container, then `tsc --noEmit` (the typed client included)              |
| `generate`        | `bun run generate`        | `npm run generate`        | writes `src/.znight/container.generated.ts` (`--check` in CI)                         |
| `openapi`         | `bun run openapi`         | `npm run openapi`         | `znight openapi`: writes `openapi.json`                                               |
| `openapi:check`   | `bun run openapi:check`   | `npm run openapi:check`   | exits with code 1 when `openapi.json` is missing or stale (CI)                        |
| `client:generate` | `bun run client:generate` | `npm run client:generate` | `openapi-typescript`: `openapi.json` → `src/client/schema.d.ts`                       |
| `client:check`    | `bun run client:check`    | `npm run client:check`    | exits with code 1 when `schema.d.ts` is stale (CI)                                    |

The production bundle runs on both runtimes, configured by environment variables only:

```sh
bun run build
export ADMIN_API_KEY=change-me CUSTOMER_TOKENS='{"alice":"change-me-too"}'
node --enable-source-maps dist/main.js   # Node.js
bun dist/main.js                         # Bun
bun run start                            # znight start (same PID, signals forwarded)
```

In production (`NODE_ENV=production`) the document is the file `znight build` wrote next to the
bundle, `dist/openapi.json`: no schema conversion at boot, and the bytes served are the ones
reviewed in `openapi.json`.

### Configuration

Read by [`ConfigPlugin`](../../packages/config/README.md) from `.env` files (`.env`,
`.env.<NODE_ENV>`, ...), then from the environment (which wins), and validated at boot: a missing
`ADMIN_API_KEY` stops the application with `ZNIGHT006`, without printing any secret.

| Variable          | Default            | Description                                                                       |
| ----------------- | ------------------ | --------------------------------------------------------------------------------- |
| `ADMIN_API_KEY`   | (required)         | API key of the administrators: every back-office route (`@Secret`: never printed) |
| `CUSTOMER_TOKENS` | (required)         | Bearer tokens of the customers, a JSON object: `{"alice":"<token>"}`              |
| `CATALOG_API_KEY` | —                  | API key of the catalogue managers: products and images only                       |
| `PORT` / `HOST`   | `3000` / `0.0.0.0` | API address (`PORT=0`: a free port, logged when ready)                            |
| `LOG_LEVEL`       | `info`             | `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`                      |
| `DOCS`            | `true`             | Serve `/openapi.json` and `/docs` (`false` for an internal deployment)            |
| `EXPOSE_ERRORS`   | `false`            | Send the message of unexpected errors in 500 responses (development)              |
| `CATALOG_SEED`    | `false`            | Start with three sample products                                                  |

## Try it

With `bun run dev` running (development credentials of [`.env.development`](.env.development)):

```sh
API=http://localhost:3000
CATALOG='x-api-key: dev-catalog-key'
ADMIN='x-api-key: dev-admin-key'
ALICE='authorization: Bearer dev-alice-token'
MUG=0d6f2c4e-5b1a-4c3e-9f8a-2b7d1e6a9c01

open $API/docs                                     # the API reference (Scalar)
curl -s $API/openapi.json | head                   # the document: the same bytes as openapi.json

# the public catalogue: coerced query parameters (repeated `tag`, `sort` is one of the ProductSort literals)
curl "$API/products?tag=gift&sort=price-asc&limit=10"
curl "$API/products?sort=cheap"                    # 400: Invalid query "sort": expected one of "name", "newest", ...
curl $API/products/$MUG
curl $API/products/42                              # 400 {"message":"Invalid param \"id\"","details":[{"path":"","message":"Invalid UUID"}]}

# the back office adds a product: the body is the Zod schema input (a price in euros, as a string)
curl -i -H "$CATALOG" -H 'content-type: application/json' -X POST $API/products \
  -d '{"sku":"cap-01","name":"Znight cap","category":"apparel","price":"19.90","tags":["Cap"]}'
# 201, location: /products/<id>, {"sku":"CAP-01","priceCents":1990,"tags":["cap"],...}
curl -H "$CATALOG" -H 'content-type: application/json' -X POST $API/products/validate \
  -d '{"sku":"pen-1","name":"Pen","category":"home","price":"2"}'
# 200: the schema output, nothing stored {"sku":"PEN-1","price":200,"stock":0,"tags":[],"description":null,...}

# images: multipart upload (≤ 1 MiB, PNG/JPEG/WebP, checked by content), public download
curl -H "$CATALOG" -X PUT -F image=@mug.png $API/products/$MUG/image
curl -i $API/products/$MUG/image                   # 200 image/png, etag, cache-control: public, max-age=300
curl -i -H 'range: bytes=0-3' $API/products/$MUG/image   # 206

# a customer: a cart, then an order paid by card (or {"method":"transfer"})
CART=$(curl -s -H "$ALICE" -X POST $API/carts | sed -E 's/.*"id":"([^"]+)".*/\1/')
curl -H "$ALICE" -H 'content-type: application/json' -X POST $API/carts/$CART/items -d "{\"productId\":\"$MUG\",\"quantity\":2}"
curl -i -H "$ALICE" -H 'content-type: application/json' -X POST $API/orders \
  -d "{\"cartId\":\"$CART\",\"payment\":{\"method\":\"card\",\"token\":\"tok_visa_4242\"}}"
# 201, location: /orders/<id>, {"status":"paid","payment":{"method":"card","last4":"4242",...},...}

# the back office
curl -H "$ADMIN" $API/orders/export                # one JSON order per line (application/x-ndjson)
curl -H "$ADMIN" $API/admin/stats
curl -H "$ALICE" $API/admin/stats                  # 403: a customer token is not a back-office key
curl -i $API/carts/$CART                           # 401, www-authenticate: Bearer realm="storefront"
```

| Method | Path                  | Access              | Documented security | Responses                                                    |
| ------ | --------------------- | ------------------- | ------------------- | ------------------------------------------------------------ |
| `GET`  | `/products`           | public              | none                | `200` page of summaries, `400`                               |
| `GET`  | `/products/:id`       | public              | none                | `200`, `400`, `404`                                          |
| `POST` | `/products`           | `catalog` (API key) | `apiKey`            | `201` + `location`, `400`, `401`, `403`, `409`, `413`        |
| `POST` | `/products/validate`  | `catalog`           | `apiKey`            | `200` the schema output, `400`, `401`, `403`, `413`          |
| `PUT`  | `/products/:id/image` | `catalog`           | `apiKey`            | `200`, `400`, `401`, `403`, `404`, `413`, `415`              |
| `GET`  | `/products/:id/image` | public              | none                | `200` / `206` the image, `304`, `400`, `404`                 |
| `POST` | `/carts`              | `customer` (token)  | `bearer` (default)  | `201` + `location`, `401`, `403`                             |
| `GET`  | `/carts/:id`          | `customer`          | `bearer`            | `200`, `400`, `401`, `403`, `404`                            |
| `POST` | `/carts/:id/items`    | `customer`          | `bearer`            | `200`, `400`, `401`, `403`, `404`, `409`, `413`              |
| `POST` | `/orders`             | `customer`          | `bearer`            | `201` + `location`, `400`, `401`, `403`, `404`, `409`, `413` |
| `GET`  | `/orders/:id`         | `customer`          | `bearer`            | `200`, `400`, `401`, `403`, `404`                            |
| `GET`  | `/orders/export`      | `admin` (API key)   | `apiKey`            | `200` NDJSON, `400`, `401`, `403`                            |
| `GET`  | `/admin/stats`        | `admin`             | `apiKey`            | `200`, `401`, `403`                                          |
| `GET`  | `/health`             | public              | not documented      | `200`                                                        |
| `GET`  | `/openapi.json`       | public              | —                   | `200` (strong `etag`), `304`                                 |
| `GET`  | `/docs`               | public              | —                   | `200` HTML (Scalar)                                          |

## How it is built

```txt
src/
├─ main.ts                   # Application.create(): observability, config, HTTP, OpenAPI; shutdown
├─ http.ts                   # HttpPlugin (Hono) and OpenApiPlugin options, shared with the tests
├─ api.ts                    # @OpenApiDocument, securityScheme('bearer'), securityScheme('apiKey')
├─ openapi.converters.ts     # schema converters given to every assembly of the document
├─ app.lifecycle.ts          # onReady / onStop hooks
├─ config/                   # @Config classes: server, auth (@Secret), catalogue
├─ auth/                     # @Public / @Roles, AuthGuard, Credentials, CurrentCustomer (request scope)
├─ catalog/                  # ProductController, CatalogService, Zod schemas, response types, seed
├─ carts/  orders/           # controllers, services, Valibot schemas, Order (discriminated payment)
├─ admin/  health/           # statistics (API key), liveness probe (@ApiExclude)
├─ shared/                   # Page<T>, Id, domain errors and their mapper, shared error responses
├─ client/                   # schema.d.ts (generated, committed) and client.ts (openapi-fetch)
└─ .znight/                  # generated container (git-ignored)
openapi.json                 # the document (generated, committed)
test/                        # bun test: unit, HTTP, contract, document, build checks, e2e
```

### Nothing written twice

Everything the document says comes from code that runs anyway. A handler is its own documentation:

```ts
/**
 * List products
 *
 * The public catalogue, one page at a time.
 * @param tags Only the products carrying every one of these labels (`?tag=mug&tag=gift`).
 * @param sort Order of the results.
 */
@Get()
list(
  @Query('tag') tags: string[] = [],
  @Query('sort') sort: ProductSort = 'name', // 'name' | 'newest' | 'price-asc' | 'price-desc'
  @Query('limit') limit = 20,
  // ...
): Page<ProductSummary> {
```

| From the code                                    | In the document                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `@Get()` on `@Controller('/products')`           | `GET /products`, operation id `product.list`                                                     |
| First line / rest of the JSDoc, `@param`         | `summary`, `description`, the description of each parameter                                      |
| `tags: string[] = []`                            | `{ type: 'array', items: { type: 'string' }, default: [] }`, `style: form`, `explode: true`      |
| `sort: ProductSort = 'name'`                     | `{ type: 'string', enum: ['name', 'newest', 'price-asc', 'price-desc'], default: 'name' }`       |
| `Page<ProductSummary>` (annotated)               | `200` → `#/components/schemas/Page_ProductSummary`, the interfaces and their JSDoc as components |
| Coerced or validated inputs                      | `400` → `ValidationErrorBody`, the standard error envelope                                       |
| `@Body(CreateProduct)` (Zod)                     | the request body, `413` (body limit)                                                             |
| `@UploadedFile('image', { maxSize, mimeTypes })` | `multipart/form-data`, `encoding.image.contentType`, `x-znight-max-size`, `413`, `415`           |
| `@Public()` on the controller                    | `security: []` through the `decisions` of `@OpenApiDocument`                                     |

The `@Api*` decorators only add what the code cannot say: an error status a service throws
(`@ApiResponse(404, ...)`), the API key of the back-office routes (`@ApiSecurity(ApiKey)`), the
media type of a streamed body. They do nothing at runtime: the compiler reads them and the build
strips them. Return types must be **annotated**: the compiler reads declarations, it does not run
the TypeScript checker.

### Schemas: what clients send, what the server answers

A Zod schema with transforms has two JSON Schemas: its **input** describes requests, its **output**
responses. [`CreateProduct`](src/catalog/product.schemas.ts) takes a price in euros as a string and
produces cents, trims and upper-cases the SKU, and has defaults:

| Component            | Used by                                     | `price`                                    | Required                              |
| -------------------- | ------------------------------------------- | ------------------------------------------ | ------------------------------------- |
| `CreateProductInput` | the bodies of `POST /products`, `/validate` | `{ type: 'string', pattern: '^\d{1,6}…' }` | `sku`, `name`, `category`, `price`    |
| `CreateProduct`      | the response of `POST /products/validate`   | `{ type: 'integer', minimum: 1 }`          | every property (defaults are applied) |

Zod converts its own schemas (Standard JSON Schema). Valibot does not, so `@znight/openapi` goes
through `@valibot/to-json-schema` (an optional peer, a dependency of this example). Conversion happens
when the document is assembled, never inside the compiler, which does not run application code.

### Discriminated unions

`Payment` (the response, [`order.ts`](src/orders/order.ts)) is a TypeScript union of two named
interfaces with a literal `method`: the compiler documents it as `oneOf` with a `discriminator` and a
complete `mapping`. The request side is a Valibot `v.variant('method', [...])`
([`order.schemas.ts`](src/orders/order.schemas.ts)), which `@valibot/to-json-schema` writes as a plain
`oneOf` of inline objects. [`openapi.converters.ts`](src/openapi.converters.ts) wraps the built-in
Valibot converter: options named with `v.title()` become components (`CardPaymentInput`,
`TransferPaymentInput`) and the `discriminator` is added. Generated clients get tagged unions on both
sides:

```ts
payment: components['schemas']['CardPaymentInput'] | components['schemas']['TransferPaymentInput'] // method: 'card' | 'transfer'
```

A converter runs wherever the document is assembled, so the module is given to all of them:
`OpenApiPlugin` ([`http.ts`](src/http.ts)), `openapi()` ([`vite.config.ts`](vite.config.ts)) and
`znight openapi --converters` ([`package.json`](package.json)). Forget one and the committed file no
longer matches the served document: the tests say so.

### Security

[`api.ts`](src/api.ts) declares the two schemes and the rules:

```ts
export const Bearer = securityScheme('bearer', { type: 'http', scheme: 'bearer' })
export const ApiKey = securityScheme('apiKey', { type: 'apiKey', in: 'header', name: 'x-api-key' })

@OpenApiDocument({
  security: [Bearer], // the default of every operation
  decisions: [{ when: Public, security: [] }], // @Public() routes need nothing
})
export class StorefrontApi {}
```

Back-office routes declare the key with `@ApiSecurity(ApiKey)`, on the controller (`AdminController`)
or on a route (`POST /products`): the route's wins, then the controller's, then the first matching
decision, then the default. The documentation and the enforcement are separate (`@Roles` is what
`AuthGuard` checks), so [`document.test.ts`](test/document.test.ts) checks that they agree: public
routes are documented without security, customer routes with the bearer token, back-office routes
with the API key. `401` and `403` are declared on the routes that need credentials, from the shared
constants of [`responses.ts`](src/shared/responses.ts).

### Serving the document

[`http.ts`](src/http.ts) configures `OpenApiPlugin`:

- `GET /openapi.json`: precomputed bytes with a strong `etag` (`304` on `if-none-match`, `HEAD`
  included), `cache-control: no-cache`;
- `GET /docs`: Scalar, with its own `content-security-policy` (the inline script allowed by its hash).
  Its script comes from `node_modules` once `@scalar/api-reference` is installed, from the jsDelivr
  build pinned by `@znight/openapi` with Subresource Integrity otherwise (this example installs
  nothing);
- `meta: [Public.meta()]`: the docs routes are plugin routes of `HttpPlugin`, behind the global
  `AuthGuard` like the controllers, so they need an access decision too;
- `DOCS=false` serves neither; in production `{ file }` serves `dist/openapi.json` ([`main.ts`](src/main.ts)).

### The committed document and the typed client

`openapi.json` is the contract. Committing it shows every API change in the pull request diff, and
lets clients be generated without starting anything.

- `bun run openapi` writes it, `bun run openapi:check` fails when it is stale (`bun run test` runs it
  first; run it in CI);
- `znight build` writes `dist/openapi.json`, served in production, and `openapi.json` too except in
  CI, where `openapi:check` checks it instead ([`vite.config.ts`](vite.config.ts));
- [`document.test.ts`](test/document.test.ts) checks that the served document is the committed file,
  byte for byte, and that it is valid OpenAPI 3.1 (`@seriousme/openapi-schema-validator`).

`bun run client:generate` turns it into [`src/client/schema.d.ts`](src/client/schema.d.ts)
(`openapi-typescript`, with `--default-non-nullable false` so that a property with a default stays
optional in request bodies), and [`client.ts`](src/client/client.ts) wraps `openapi-fetch`:

```ts
import { createStorefrontClient } from './src/client/client.js'

const shop = createStorefrontClient({ baseUrl: 'https://shop.example.com', token })
const { data, error, response } = await shop.POST('/orders', {
  body: { cartId, payment: { method: 'card', token: 'tok_visa_4242' } }, // checked against PlaceOrder
})
if (data?.payment.method === 'card')
  console.log(data.payment.last4) // a tagged union
else console.error(response.status, error?.message) // the error envelope is typed too
```

`tsconfig.json` includes `src/client` and the tests: a server change that breaks the contract (a
renamed field, a removed route) changes `openapi.json`, then `schema.d.ts`, and every caller relying
on it fails `bun run typecheck` — [`e2e.test.ts`](test/e2e.test.ts) first.

## Try breaking it

Mistakes that would make the documentation lie are build errors or warnings with a location, like
the mistakes of the dependency graph. [`build-check.test.ts`](test/build-check.test.ts) keeps this
list honest.

- **Remove a return annotation**: `get(@Param('id', Id) id: string) {` in `ProductController`.

  ```txt
  ⚠ ZNIGHT031: The 200 response of GET /products/:id (ProductController.get) cannot be documented: the handler has no return type annotation
    --> src/catalog/product.controller.ts:91:3
     = hint: Annotate the return type: Body
     = hint: Or declare it: @ApiResponse<Body>(200)
  ```

- **Return a `bigint`**: `readonly revenueCents: bigint` in `ShopStats`. `JSON.stringify` throws on
  it: the route would answer 500 on every call.

  ```txt
  ✗ ZNIGHT032: ShopStats.revenueCents is a bigint: JSON.stringify throws on bigint, so GET /admin/stats (AdminController.stats) would answer 500
    --> src/admin/admin.controller.ts:32:26
     = hint: Return a number or a string (String(total)), or give the type a toJSON() method
  ```

- **Add a second `ProductController`** (`src/admin/product.controller.ts`, `@Controller('/admin/products')`
  with a `list()` route): `ZNIGHT033: Duplicate operation id "product.list"`, with the hint to rename
  one or to set `@ApiOperation({ operationId })`.
- **Require a scope the scheme does not declare**: `@ApiSecurity({ scheme: OAuth, scopes: ['orders:export'] })`
  with an OAuth 2.0 scheme declaring `orders:read`: `ZNIGHT036: The scope "orders:export" is not
  declared by the flows of "oauth2"`.
- **Change a response without updating `openapi.json`**: rename `priceCents` in `ProductSummary`.
  `bun run test` fails at `openapi:check`; `bun run openapi && bun run client:generate`, then
  `bun run typecheck` points at every caller of the client that used `priceCents`.
- **Forget a documented status**: add `@ApiResponse(410, ...)` to a route.
  [`contract.http.test.ts`](test/contract.http.test.ts) fails: every documented response needs a
  test that obtains it.

## Tests

```sh
bun run test       # openapi:check, then unit, HTTP, contract, document and build-check tests: a few seconds
bun run test:e2e   # production build, the bundle on Node.js then Bun, emission on both runtimes
```

`bunfig.toml` preloads `@znight/compiler/bun`, which regenerates the container before the tests.

| File                                                      | Shows                                                                                                                                     |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [`auth.guard.test.ts`](test/auth.guard.test.ts)           | `TestBed`: the guard with real `Credentials`, `Lazy<CurrentCustomer>` mocked; challenges, roles, deny by default                          |
| [`catalog.service.test.ts`](test/catalog.service.test.ts) | `TestBed` with `@Config` values: seeding on start, the Zod output stored, images checked by content                                       |
| [`order.service.test.ts`](test/order.service.test.ts)     | `TestBed` with a real repository: card and transfer payments, the paged export                                                            |
| [`converters.test.ts`](test/converters.test.ts)           | the discriminator converter, and why every assembly needs it                                                                              |
| [`storefront.http.test.ts`](test/storefront.http.test.ts) | `TestApp`: the shop in memory (`app.inject()`, `app.injectStream()`), stock, uploads, ranges, the NDJSON export, authentication           |
| [`contract.http.test.ts`](test/contract.http.test.ts)     | every documented response of every operation obtained and checked with `validateResponse()`, and a check that none is missing             |
| [`document.test.ts`](test/document.test.ts)               | the served document is `openapi.json`, valid OpenAPI 3.1; the operations snapshot (ids, tags, security, access); references; client types |
| [`docs.http.test.ts`](test/docs.http.test.ts)             | `/openapi.json` (ETag, `304`, `HEAD`), `/docs` (CSP hash, pinned CDN with SRI), `DOCS=false`                                              |
| [`build-check.test.ts`](test/build-check.test.ts)         | "Try breaking it": ZNIGHT031, 032, 033 and 036 through `compile()`                                                                        |
| [`e2e.test.ts`](test/e2e.test.ts)                         | `ZNIGHT_E2E=1`: `znight build`, the bundle on Node.js then Bun through the typed client, SIGTERM during an upload (drained, exit code 0)  |
| [`emit.e2e.test.ts`](test/emit.e2e.test.ts)               | `ZNIGHT_E2E=1`: `znight openapi --check`, `--runtime node` and `--runtime bun` write the committed bytes, a stale file fails the check    |

## In this repository

The example is a workspace of the Znight monorepo, so a few settings exist only to use the framework
from its sources; a project created with `znight new` does not need them:

- `tsconfig.json`: `customConditions: ["@znight/source"]` and `allowImportingTsExtensions` make `tsc`
  check against the packages' TypeScript sources;
- `vite.config.ts`: `ssr.external` keeps the linked `@znight/*` packages out of the bundle;
- `test` scripts pass `--conditions=@znight/source` to `bun test`;
- the `dev` script sets `NODE_ENV=development` explicitly (see `examples/rest-api`);
- `client:generate` and `client:check` need the JavaScript API of TypeScript 5, which
  `openapi-typescript` 7 imports; the monorepo uses TypeScript 7, whose package has none, so they
  fail here. `schema.d.ts` was generated with TypeScript 5, and `document.test.ts` checks that it
  declares every path, operation and schema of `openapi.json`. In your project, install
  `typescript@5` next to `openapi-typescript`;
- `validateResponse()` needs the optional peer `@cfworker/json-schema`, found here through the
  `@znight/openapi` workspace: add it to your `devDependencies`.
