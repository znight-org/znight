# RFC 0008: Errors as data in `@znight/graphql`

|          |                                                                                                                                                                                                                                                                                                                                                                                                |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status   | Accepted (v0.2)                                                                                                                                                                                                                                                                                                                                                                                |
| Date     | 2026-11-03                                                                                                                                                                                                                                                                                                                                                                                     |
| Affects  | `@znight/graphql` (runtime only: a plugin option, a provider contract, the resolver pipeline); docs (`TestApp` creates the new providers through `initRoots()`, no change to `@znight/testing`). No compiler, metadata or generated code change. No new error code: ZNIGHT066 (boot) and ZNIGHT001 (a class that is not a provider) are reused                                                 |
| Decision | **Result mappers.** A field opts in through its TypeScript return type (a union holding the error types), a `GraphQLResultMapper` provider turns an error into a value of one of the types it declares (`static types`). At boot, only the fields whose union holds a declared type get a wrapper; every other field keeps its resolve function unchanged. Unmatched errors stay in `errors[]` |

## 1. Summary

Today every error of a resolver ends in `errors[]` (RFC 0005 §5.10, §8.8). Many GraphQL APIs model
the errors a client is expected to handle as **data**: the field returns a union, one member is the
result, the others describe the failures (`union BookResult = Book | NotFoundRejection`). The client
selects them with fragments and narrows on `__typename`, the compiler of its queries checks them, and
`errors[]` keeps the unexpected failures only.

Returning such a value from a resolver already works in Znight: a union is a TypeScript union, and
`return { __typename: 'NotFoundRejection', message }` resolves to its member. What is missing is the
other half: errors **thrown** before or inside the resolver (a guard, a Standard Schema of `@Args`, a
service deep in the call, a rejected promise) cannot become values. This RFC adds that half:

```ts
export interface NotFoundRejection {
  readonly __typename: 'NotFoundRejection'
  readonly message: string
}
export type BookResult = Book | NotFoundRejection

@Resolver()
export class BookResolver {
  @Query()
  book(@Args('id') id: ID): Promise<BookResult> {
    return this.books.get(id) // throws NotFoundException
  }
}

@Injectable()
export class Rejections implements GraphQLResultMapper {
  static readonly types = ['NotFoundRejection']

  toResult(error: unknown): NotFoundRejection | undefined {
    if (error instanceof NotFoundException) return { __typename: 'NotFoundRejection', message: error.message }
    return undefined
  }
}

GraphQLPlugin.configure({ resultMappers: [Rejections] })
```

`{ book(id: "7") { ... on Book { title } ... on NotFoundRejection { message } } }` answers
`{ "data": { "book": { "message": "No book 7" } } }`, without `errors`.

## 2. How the ecosystem does it

| Library / API                         | The field declares                                      | The mapping                                                                                                     | Unmatched errors |
| ------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------- |
| Pothos, errors plugin                 | `errors: { types: [NotFoundError] }` (+ `defaultTypes`) | `instanceof` of the error classes, which are object types; a generated `XxxSuccess` wrapper (or `directResult`) | `errors[]`       |
| Hot Chocolate, mutation conventions   | `[Error(typeof(UserNameTakenException))]`               | the exception itself, a static `CreateErrorFrom(ex)`, a constructor, or a DI factory                            | `errors[]`       |
| Shopify Admin, GitHub (payloads)      | `userErrors: [UserError!]!` on mutation payloads        | written by hand in every resolver                                                                               | `errors[]`       |
| "Result union" pattern (Apollo, Yelp) | `union UserResult = User \| Suspended \| NotFound`      | written by hand (`return`), errors interface optional                                                           | `errors[]`       |
| Envelop / Yoga plugin (the wishlist)  | nothing                                                 | `onExecuteDone` rewrites `data` from the first error                                                            | none             |

The common ground: **the schema of the field says which errors it can return**, one central mapping
turns errors into those types, and anything else is an unexpected error that stays in `errors[]`.
Pothos warns that turning input validation errors into data before authorization runs leaks
information (`unsafelyHandleInputErrors`); in Znight guards always run first (§4.4).

## 3. Goals and non-goals

Goals:

- typed errors as values for errors thrown by guards, the Standard Schema validation of `@Args`,
  `invoke` (synchronously or as a rejected promise), on root fields, field resolvers and root
  subscription fields;
- the field opts in through its TypeScript return type, nothing else per field (convention over
  configuration, principle 4);
- zero cost for every field that cannot carry such a value, decided at boot; synchronous resolvers
  stay synchronous (principle 1 of RFC 0005 §8.12);
- typos caught at boot (ZNIGHT066), not on the first failing request;
- unchanged behaviour for applications without `resultMappers`, and for `errorMappers`.

Non-goals (§9):

- generated success wrappers or payload types (`XxxSuccess`, `XxxPayload.errors`): the result types
  are the user's TypeScript types;
- per-item errors in lists (Pothos `itemErrors`): a list field whose items are unions is not wrapped;
- errors of a subscription's source stream after it started;
- rewriting the whole `data` from one error (the Envelop pattern).

## 4. Design

### 4.1 User-facing API

```ts
/** `@znight/graphql` */
export interface GraphQLResultMapper {
  /**
   * The value of the field for `error`, an object of one of the declared types, or `undefined` to
   * leave the error to the next mapper (then `errors[]`). Synchronous.
   */
  toResult(error: unknown, ctx: ResolverContext): unknown
}

/** A class producing result mappers: `static types` lists the object types its values may have. */
export type GraphQLResultMapperClass = (abstract new (...args: never[]) => GraphQLResultMapper) & {
  readonly types: readonly string[]
}

/** A provider class, or an instance (its `types`, or its class's `static types`). */
export type GraphQLResultMapperRef = GraphQLResultMapperClass | (GraphQLResultMapper & { readonly types?: readonly string[] })

// GraphQLPluginOptions
readonly resultMappers?: readonly GraphQLResultMapperRef[]
```

- A mapper is a provider (any scope; request-scoped and transient ones are resolved per call in the
  current scope, like error mappers) or an instance.
- `types` is read once at boot: `static types` of a class ref; for an instance, its `types` property,
  else the `static types` of its class. It is the contract that makes the per-field decision possible
  at boot (§4.3) and catches typos (§4.6).
- `ctx` is the `ResolverContext` guards receive: the field's metadata and coordinate, the parent,
  the coerced arguments, `info`, the operation's `GraphQLContext`. A mapper may use it to choose
  between types, or to localise messages.
- The mapper sees the raw error: a `GraphQLException` included. A guard returning `false` is a
  `GraphQLException` with code `FORBIDDEN`; a Standard Schema failure of `@Args` is a
  `GraphQLException` with code `BAD_USER_INPUT` and `extensions.issues` (`[{ path, message }]`).
  `errorMappers` do not change: they still never receive a `GraphQLException`, and still run once the
  execution finished.

`toResult` is a separate contract rather than a new return type of `GraphQLErrorMapper.map()` (the
starting point of the design, see §10.1).

### 4.2 Which fields can carry a value

A resolver-backed field **carries results** when its type, without its non-null wrapper, is a union
(not a list) and one of its members is declared by at least one result mapper. The field's union is
its declaration, in TypeScript: `Promise<Book | NotFoundRejection>` or a named alias
(`Promise<BookResult>`), whatever the members are (interfaces with `__typename`, classes, a property
discriminator). Nothing else per field.

For such a field, the **applicable mappers** are the result mappers declaring one of its members, in
option order.

### 4.3 Boot (normative)

`onBootstrap`, after the schema is built:

1. each `resultMappers` ref is resolved like an error mapper (a class must be a provider, ZNIGHT001;
   it must have a `toResult()` method, ZNIGHT066);
2. its `types` must be a non-empty array of names of **object types of the schema**; anything else
   is ZNIGHT066 (`the result mapper Rejections declares NotFoundRejecton, which is not an object type
   of the schema`), every problem in one error;
3. for every resolver-backed field, the applicable mappers are computed. A field with none keeps the
   resolve function of RFC 0005 §8.5, byte for byte the same closure: **no wrapper, no extra call, no
   promise**. A field with some gets one wrapper (§4.4).

The number of fields that carry results is logged at `debug` with the schema.

### 4.4 Runtime (normative)

The wrapper surrounds the whole field pipeline of RFC 0005 §8.5 (resolver instance, guards, null
handling, `invoke`):

- a synchronous throw is caught synchronously; a synchronous value is returned as is (no promise);
- a promise result gets one rejection handler (`then(undefined, onRejected)`);
- on an error, the applicable mappers are called in order with `(error, ctx)`. The first value that
  is neither `undefined` nor `null` and **resolves to a member of the field's union** (the union's own
  type resolution: its discriminator, then `__typename`) becomes the field's value;
- a value of another object type of the schema (a member of another union) is skipped, logged at
  `debug`; a value that resolves to no object type is skipped, logged at `warn` (a mapper bug); a
  mapper that throws is skipped, logged at `error`. The next mapper is tried;
- when no mapper produces a member, the original error is rethrown unchanged: it ends in `errors[]`
  through the usual order (`GraphQLException`, `errorMappers`, `HttpException`, masking, logging).

Guards run before the Standard Schema validation (it is part of `invoke`), so a validation error is
only turned into data for a client allowed to call the field.

Only errors raised by the field's own pipeline are concerned. An error of a child field stays an
error of the child (and nulls its way up as graphql-js decides); it does not become a value of the
parent. Completion errors (a value graphql-js cannot serialise) are not caught either: they happen
after the resolve function returned.

### 4.5 Subscriptions

A root subscription field carries results when its event type is a union holding a declared type.
Its guards and its method run once, when the subscription starts (RFC 0005 §8.5): an error there
mapped to a value gives a source stream of that single event. The client receives one `next` with
the value, then `complete` (SSE), or a stream of one result (`plugin.subscribe()`). Errors of the
source stream after the start are not mapped (non-goal).

### 4.6 Build time, boot, runtime

| What                                                     | When                                   |
| -------------------------------------------------------- | -------------------------------------- |
| The union of the field, its members, their discriminator | build (compiler, RFC 0005; unchanged)  |
| The mapper is a provider with `toResult()`               | boot (ZNIGHT001, ZNIGHT066)            |
| `types` names object types of the schema                 | boot (ZNIGHT066)                       |
| Which fields get a wrapper, which mappers apply          | boot                                   |
| The produced value is a member of the field's union      | runtime (skipped with a log otherwise) |

The compiler does not know the mappers (plugin options are runtime values, possibly a function of the
container), so no build-time check is possible without a new marker; the boot check covers typos.

### 4.7 Masking, logging, `exposeErrors`

A value is data chosen by the application: it is never masked, and `exposeErrors` does not apply.
An error turned into a value is not logged above `debug` (`GraphQL: error resolved as
NotFoundRejection in Query.book`, with the request id and the path): it is an expected outcome. A
mapper that turns unexpected errors into values (a catch-all `InternalErrorRejection`) must log them
itself (inject `Logger`); the guides recommend leaving unexpected errors in `errors[]`.

### 4.8 The `graphql:operation` hook, observability, transports

The hook (core) does not change. Its `outcome` and `errors` describe the response: a field resolved
to a value is data, so an operation whose only failure became a value is a `success`, with no entry
in `errors`. Spans and metrics of `@znight/observability` follow. GraphQL over HTTP, SSE and
`plugin.execute()` serialise the result as any other: nothing transport-specific.

## 5. Performance

- fields that carry no result: unchanged closure, so unchanged cost (measured with
  `test/bench/http.bench.ts` and `test/bench/execute.bench.ts` before and after, with result mappers
  configured);
- fields that carry results, without error: one extra call frame, plus one rejection handler for a
  promise result;
- on an error: the applicable mappers, one `ResolverContext`, the union's type resolution.

## 6. Error codes

None. ZNIGHT066 covers the invalid option and `types`; ZNIGHT001 a class ref that is not a provider.

## 7. Testing

`packages/graphql/test/results.test.ts`: guards (`false` and a thrown `UnauthorizedException`),
Standard Schema validation, `invoke` errors (sync and async), unions with and without the produced
member, fallback to `errors[]` (no mapper, another union's member, no type, a throwing mapper),
non-null fields, nested field resolvers, masking and logging, the hook outcome, SSE and
`plugin.subscribe()`, request-scoped mappers, the boot checks, and that fields without results keep
their resolve function.

## 8. Documentation

Specification §9.7 (option, contract, boot and runtime rules), the package README (Errors section),
`docs/guide/graphql.md` (a recipe), `docs/guide/migrating-from-nestjs.md` (an Envelop/Yoga plugin
rewriting errors into data).

## 9. Out of scope, possible follow-ups

- **List items** (Pothos `itemErrors`): a union per item, errors of a `loadMany`.
- **Source stream errors** of subscriptions after the start.
- **A hook signal**: counting errors resolved as data in metrics (Pothos `onResolvedError`).
- **Build-time checks**: a marker on result types would let the compiler check unions, at the cost
  of a new metadata field.

## 10. Alternatives considered

### 10.1 `GraphQLErrorMapper.map()` returning a value (`GraphQLResult.value(...)`)

The starting point. Rejected: error mappers run once the execution finished, when a value can no
longer be placed in `data`; running them inside resolvers would change what existing mappers receive
(a catch-all mapper would start re-mapping the `FORBIDDEN` and `BAD_USER_INPUT` exceptions of the
framework), and a mapper's possible values are unknown at boot, so every union field would pay a
wrapper. A separate contract keeps `errorMappers` as they are and gives the boot what it needs.

### 10.2 Thrown members as values (Pothos style)

"An error thrown by a resolver that is an instance of a member of the field's union becomes the
value." Implicit (a class becomes data because it is thrown), and it covers user-thrown errors only,
not guards or validation. It is a three-line result mapper on top of this RFC
(`toResult: error => error instanceof NotFoundError ? error : undefined`, `types: ['NotFoundError']`).

### 10.3 Per-field declarations (Hot Chocolate `[Error]`)

A decorator listing the error types of a field duplicates its return type, which already says it in
TypeScript.

### 10.4 Rewriting `data` after execution (Envelop `onExecuteDone`)

Loses partial results, is not typed per field (the root field of the first error becomes the
rejection, whatever its type), and needs result access in the hook. Rejected.
