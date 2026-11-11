---
description: Validate inputs with any Standard Schema library (Zod, Valibot, ArkType) - HTTP bodies, queries and parameters, message payloads, WebSocket events and GraphQL arguments, the error format, unvalidated inputs reported at build time, and schemas reused by OpenAPI.
---

# Validation

Znight validates inputs with **schemas**, not with DTO classes and decorators: pass any library
implementing [Standard Schema](https://standardschema.dev) (Zod 3.24+ / 4, Valibot 1, ArkType 2,
Effect Schema...) where the input enters, and the handler receives the validated, typed **output**.
There is no adapter to install and no global pipe to configure: the compiler sees which schema goes
with which parameter and generates the call.

## Validate an HTTP request {#http}

Pass the schema to `@Body()`, `@Query()` or `@Param()`, or put `@Validate(schema)` on the method as
sugar for `@Body(schema)`:

```ts
import { Body, Controller, Post, Query, Get } from '@znight/http'
import { z } from 'zod'

export const CreateUser = z.object({
  email: z.email(),
  name: z.string().min(2),
  role: z.enum(['admin', 'member']).default('member'),
})
export type CreateUser = z.output<typeof CreateUser>

export const SearchQuery = z.object({ q: z.string(), limit: z.coerce.number().int().max(100).default(10) })

@Controller('/users')
export class UserController {
  @Post()
  create(@Body(CreateUser) input: CreateUser) {
    // input.role is 'member' when omitted: handlers receive the schema output
  }

  @Get('/search')
  search(@Query(SearchQuery) query: z.output<typeof SearchQuery>) {
    // query.limit is a number, unknown keys are stripped by the schema
  }
}
```

- Handlers receive the schema **output**: defaults, transforms, coercions, stripped keys. Async
  schemas (async refinements) work.
- Schemas must be **exported**: the generated module imports them.
- Simple parameters need no schema: `@Param('id') id: number` and `@Query('page') page = 1` are
  coerced from their declared type ([coercion](./http#parameters)). Add a schema for ranges,
  formats or structured inputs (`@Param('id', z.uuid())`).
- Body parsing runs after the guards: an unauthenticated request is refused before its body is read
  or validated.

## The error response {#errors}

A failure answers `400` with one entry per issue, the first 100 only (a large invalid array never
produces a response larger than the request):

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "Invalid body",
  "details": [{ "path": "user.emails.1", "message": "Invalid email address" }]
}
```

The error is a `ValidationException` (a `BadRequestException`) carrying `location` (`body`, `query`,
`param "id"`...) and the raw Standard Schema `issues`, all of them. To answer in your own format
(`422`, RFC 9457 problem details), map it with an [exception mapper](./http#exception-mappers):

```ts
import { Injectable } from '@znight/core'
import { type ExceptionMapper, type ExceptionMapperResult, HttpResponse, ValidationException } from '@znight/http'

@Injectable()
export class ValidationErrorMapper implements ExceptionMapper {
  map(error: unknown): ExceptionMapperResult {
    if (!(error instanceof ValidationException)) return undefined
    return new HttpResponse({ location: error.location, errors: error.issues }, { status: 422 })
  }
}
```

## Messages, WebSocket events and GraphQL {#other-transports}

The same schemas validate every other way data comes in:

| Transport                              | Where the schema goes                                      | On failure                                                                          |
| -------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [Messaging](./messaging#validation)    | `@Message(schema)` on the handler parameter                | `MessageValidationError`: dead-lettered at once, never retried                      |
| [WebSockets](./websockets)             | `@Payload(schema)` on a gateway event handler              | A `BAD_REQUEST` reply with `details: [{ path, message }]`; the handler does not run |
| [GraphQL](./graphql#arguments)         | A schema named after the input type, next to the interface | A `BAD_USER_INPUT` error listing the issues; the resolver does not run              |
| [Configuration](./configuration#types) | No schema: the declared property types are checked at boot | [`ZNIGHT006`](/reference/error-codes#znight006), every problem listed at once       |

A message handler validates its payload exactly like a route validates its body:

```ts
import { Consumer, Message, OnMessage } from '@znight/messaging'
import { z } from 'zod'

export const OrderCreatedSchema = z.object({ orderId: z.string(), total: z.number() })
export type OrderCreated = z.output<typeof OrderCreatedSchema>

@Consumer('orders')
export class OrderConsumer {
  @OnMessage('order.created')
  onCreated(@Message(OrderCreatedSchema) event: OrderCreated) {}
}
```

## Unvalidated inputs are reported {#unvalidated-inputs}

The compiler reports an input whose shape is not checked: a non-primitive `@Body()`, `@Query()`
(the whole query), `@Message()` or WebSocket `@Payload()` parameter without a schema is
[`ZNIGHT017`](/reference/error-codes#znight017). It is a warning by default; turn it into an error
for the whole application with the compiler option `strictValidation`, so that no route or consumer
ships without validation:

```ts [znight.config.ts]
import type { ZnightOptions } from '@znight/compiler'

export default { strictValidation: true } satisfies ZnightOptions
```

## Schemas in the API documentation {#openapi}

With [`@znight/openapi`](./openapi), the schemas of your routes are the documentation: the
**input** schema of `@Body(S)` becomes the request body, `z.output<typeof S>` in a return type the
response schema, converted by the schema library itself through Standard JSON Schema. Validation
and documentation never drift apart, and `validateResponse()` checks in tests that the responses
match what is documented ([OpenAPI testing](./openapi#testing)).

## Coming from `class-validator` {#class-validator}

DTO classes with `@IsEmail()` and a global `ValidationPipe` become one exported schema per input,
passed where the input is read. The [migration guide](./migrating-from-nestjs#validationpipe-schemas)
shows the conversion side by side.
