/**
 * Error codes shared by the compiler (build-time diagnostics) and the runtime (`ZnightError`).
 * Documented in docs/internals/architecture.md (§4.8) and docs/reference/error-codes.md.
 *
 * Ranges (the catalogue is closed: third-party packages get no `ZNIGHT` code):
 * - `ZNIGHT001`–`ZNIGHT029`: the core, the compiler and the features shipped in 0.1 (http,
 *   messaging, config, observability).
 * - From `ZNIGHT030`, each first-party package reserves a block of ten: `ZNIGHT030`–`039`
 *   `@znight/openapi`, `ZNIGHT040`–`049` `@znight/schedule`, `ZNIGHT050`–`059` `@znight/websocket`
 *   (reserved), `ZNIGHT060`–`069` `@znight/graphql`, `ZNIGHT070`–`079` `@znight/events`.
 *
 * Within a range, codes are allocated in order without gaps. A package uses its block for its own
 * failure modes, with one catch-all code for invalid usage and options, and reuses a lower code
 * when the meaning is the same (a decorator on the wrong target is always `ZNIGHT005`). Codes never
 * change meaning.
 */
export const ErrorCode = {
  /** Missing provider for a required dependency. */
  MissingProvider: 'ZNIGHT001',
  /** Circular dependency in the provider graph. */
  CircularDependency: 'ZNIGHT002',
  /** A singleton depends (directly or through transient providers) on a request-scoped provider. */
  ScopeMismatch: 'ZNIGHT003',
  /** Several providers for the exact same type without qualifier or `@Primary`. */
  DuplicateProvider: 'ZNIGHT004',
  /** Invalid decorator usage. */
  InvalidDecorator: 'ZNIGHT005',
  /** Missing required configuration value. */
  MissingConfig: 'ZNIGHT006',
  /** Invalid route definition. */
  InvalidRoute: 'ZNIGHT007',
  /** Several candidates for an interface or base type without `@Primary`. */
  AmbiguousInjection: 'ZNIGHT008',
  /** Invalid lifecycle hook. */
  InvalidLifecycleHook: 'ZNIGHT009',
  /** The type of an injection point cannot be resolved. */
  UnresolvableType: 'ZNIGHT010',
  /** Invalid message consumer definition. */
  InvalidConsumer: 'ZNIGHT011',
  /** Invalid config property. */
  InvalidConfig: 'ZNIGHT012',
  /** Request-scoped provider resolved outside of a request scope. */
  NoActiveScope: 'ZNIGHT013',
  /** Async factory on a non-singleton provider. */
  AsyncNonSingleton: 'ZNIGHT014',
  /** A provider factory threw or rejected. */
  InstantiationFailed: 'ZNIGHT015',
  /** The container was modified after `init()`. */
  ContainerSealed: 'ZNIGHT016',
  /** Non-primitive input injected without a validation schema. */
  UnvalidatedInput: 'ZNIGHT017',
  /** Incompatible versions (metadata format, packages, compiler extension API). */
  VersionMismatch: 'ZNIGHT018',
  /** Provider unreachable from any root. */
  UnusedProvider: 'ZNIGHT019',
  /** The generated module is imported by a provider module (ESM cycle). */
  GeneratedModuleCycle: 'ZNIGHT020',
  /** A lifecycle hook or shutdown step failed or timed out. */
  LifecycleFailed: 'ZNIGHT021',
  /** A source file could not be parsed. */
  SyntaxError: 'ZNIGHT022',
  /**
   * A route has no decision of a required route decorator group (build time), or a decision that
   * no guard of its chain enforces (boot). `@znight/http`, RFC 0001.
   */
  MissingRouteDecision: 'ZNIGHT023',

  // ZNIGHT030–039: @znight/openapi (RFC 0002)
  /**
   * Invalid OpenAPI definition: `@OpenApiDocument` options, `@Api*` usage, static values,
   * `securityScheme()`; at runtime, `OpenApiPlugin` options, missing metadata, stale prebuilt file.
   */
  InvalidOpenApiDefinition: 'ZNIGHT030',
  /** The success response of a route cannot be documented and no `@ApiResponse` covers it. */
  UndocumentedResponse: 'ZNIGHT031',
  /** A documented type has no JSON Schema, or does not serialise as declared. */
  UnrepresentableType: 'ZNIGHT032',
  /** Two OpenAPI operations have the same id. */
  DuplicateOperationId: 'ZNIGHT033',
  /** Two different declarations or schemas for one OpenAPI component name. */
  SchemaNameConflict: 'ZNIGHT034',
  /** The OpenAPI documentation of a route contradicts the route. */
  InconsistentOperation: 'ZNIGHT035',
  /** Invalid OpenAPI security requirement or security decision. */
  InvalidSecurityRequirement: 'ZNIGHT036',
  /** A schema could not be converted to JSON Schema while the OpenAPI document was assembled. */
  SchemaConversionFailed: 'ZNIGHT037',

  // ZNIGHT040–049: @znight/schedule (RFC 0004)
  /**
   * Invalid schedule: cron expression, duration, time zone, job options or method signature; at
   * runtime, `SchedulePlugin` options, job overrides, metadata, `parseCron` / `registry.add*`.
   */
  InvalidSchedule: 'ZNIGHT040',
  /** Two jobs share a name. */
  DuplicateJob: 'ZNIGHT041',
  /** No job has this name (job override, `registry.trigger` / `remove`). */
  UnknownJob: 'ZNIGHT042',
  /** A job requires a lock but `SchedulePlugin` has no lock store. */
  MissingLockStore: 'ZNIGHT043',
  /** A scheduled run was aborted (`ctx.signal.reason`, `JobAbortedError`); never thrown by the framework. */
  JobAborted: 'ZNIGHT044',

  // ZNIGHT060–069: @znight/graphql (RFC 0005, RFC 0007)
  /** A TypeScript type cannot be mapped to a GraphQL type, or a resolver lacks the annotation it needs. */
  InvalidGraphQLType: 'ZNIGHT060',
  /** Two declarations or root fields share a GraphQL name, or a name is invalid or reserved. */
  GraphQLNameConflict: 'ZNIGHT061',
  /**
   * Invalid resolver structure: `@ResolveField` without `@Parent()`, a subscription not returning an
   * async iterable, no `@Query`, inherited handlers, resolvers in a compiled library.
   */
  InvalidResolver: 'ZNIGHT062',
  /**
   * Invalid input position: a type used as input and output, a getter, a union, a cycle of non-null
   * input fields, a default value not matching its type.
   */
  InvalidGraphQLInput: 'ZNIGHT063',
  /** The members of a GraphQL union (or the implementations of an interface) cannot be told apart at runtime. */
  UnresolvableAbstractType: 'ZNIGHT064',
  /**
   * Invalid loader: `@Loader()` on a type that is not `Loader<L>`, `L` not a `BatchLoad`; at runtime,
   * a batch function returning another number of values than keys.
   */
  InvalidLoader: 'ZNIGHT065',
  /**
   * Invalid GraphQL setup at boot: malformed or version-skewed metadata, invalid schema, invalid
   * `GraphQLPlugin` options, missing `HttpPlugin`, scalar name mismatch.
   */
  InvalidGraphQLSetup: 'ZNIGHT066',
  /**
   * Invalid schema-first SDL (RFC 0007): no `.graphql` file matches, a syntax error, a graphql-js
   * schema validation error, a scalar without `scalar()` definition, an unsupported construct.
   */
  InvalidGraphQLSdl: 'ZNIGHT067',
  /**
   * Schema-first resolvers do not match the SDL (RFC 0007): a field without resolver, a resolver,
   * type or argument the SDL does not declare, a signature that does not conform to the SDL types.
   */
  GraphQLSchemaMismatch: 'ZNIGHT068',

  // ZNIGHT070–079: @znight/events (RFC 0011)
  /**
   * Invalid event listener: an `@OnEvent` method whose parameter is not a class (or a union of
   * classes), a generic or optional event, an event class the generated module cannot import, invalid
   * options, the NestJS string form, a detached listener depending on a request-scoped external.
   */
  InvalidEventListener: 'ZNIGHT070',
} as const

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

/** Short human readable description of every error code. */
export const ERROR_DESCRIPTIONS: Readonly<Record<ErrorCode, string>> = {
  ZNIGHT001: 'Missing provider: a required dependency has no provider',
  ZNIGHT002: 'Circular dependency detected in the provider graph',
  ZNIGHT003: 'Scope mismatch: a singleton cannot depend on a request-scoped provider',
  ZNIGHT004: 'Duplicate provider: several providers for the same type without qualifier or @Primary',
  ZNIGHT005: 'Invalid decorator usage',
  ZNIGHT006: 'Missing required configuration value',
  ZNIGHT007: 'Invalid route definition',
  ZNIGHT008: 'Ambiguous injection: several candidates without @Primary',
  ZNIGHT009: 'Invalid lifecycle hook',
  ZNIGHT010: 'Unresolvable injection type',
  ZNIGHT011: 'Invalid message consumer definition',
  ZNIGHT012: 'Invalid config property',
  ZNIGHT013: 'Request-scoped provider resolved outside of a request scope',
  ZNIGHT014: 'Async factory on a non-singleton provider',
  ZNIGHT015: 'Provider instantiation failed',
  ZNIGHT016: 'Container sealed: providers cannot be registered or overridden after init()',
  ZNIGHT017: 'Unvalidated input: non-primitive input injected without a schema',
  ZNIGHT018: 'Version mismatch',
  ZNIGHT019: 'Unused provider: unreachable from any root',
  ZNIGHT020: 'The generated module is imported by a provider module (ESM cycle)',
  ZNIGHT021: 'Lifecycle hook or shutdown step failed or timed out',
  ZNIGHT022: 'Syntax error: a source file could not be parsed',
  ZNIGHT023: 'Missing route decision: a route has no decision of a required group, or no guard enforces it',
  ZNIGHT030: 'Invalid OpenAPI definition',
  ZNIGHT031: 'Undocumented response: the success response of a route cannot be documented',
  ZNIGHT032: 'Unrepresentable type: a documented type has no JSON Schema or does not serialise as declared',
  ZNIGHT033: 'Duplicate OpenAPI operation id',
  ZNIGHT034: 'Schema name conflict: two different schemas for one OpenAPI component name',
  ZNIGHT035: 'Inconsistent operation: the OpenAPI documentation contradicts the route',
  ZNIGHT036: 'Invalid OpenAPI security requirement',
  ZNIGHT037: 'Schema conversion failed: a schema could not be converted to JSON Schema',
  ZNIGHT040: 'Invalid schedule: cron expression, duration, time zone, options or job signature',
  ZNIGHT041: 'Duplicate job: two jobs share a name',
  ZNIGHT042: 'Unknown job: no job has this name',
  ZNIGHT043: 'Missing lock store: a job requires a lock but SchedulePlugin has no store',
  ZNIGHT044: 'Job aborted: a scheduled run was aborted (timeout, lost lock, removal or shutdown)',
  ZNIGHT060: 'Invalid GraphQL type: a TypeScript type cannot be mapped to a GraphQL type',
  ZNIGHT061: 'GraphQL name conflict: two types or root fields share a name, or a name is invalid or reserved',
  ZNIGHT062: 'Invalid resolver: the structure of a GraphQL resolver is invalid',
  ZNIGHT063: 'Invalid GraphQL input: a type cannot be used in an input position',
  ZNIGHT064: 'Unresolvable abstract type: the members of a GraphQL union or interface cannot be told apart at runtime',
  ZNIGHT065: 'Invalid loader: not a Loader of a BatchLoad provider, or a batch returning the wrong number of values',
  ZNIGHT066: 'Invalid GraphQL setup: metadata, schema, GraphQLPlugin options, driver or HttpPlugin missing',
  ZNIGHT067: 'Invalid GraphQL SDL: the schema-first .graphql files cannot be read, parsed or validated',
  ZNIGHT068: 'GraphQL schema mismatch: schema-first resolvers do not cover or conform to the SDL',
  ZNIGHT070: 'Invalid event listener: an @OnEvent method does not listen to a class, or its options are invalid',
}

export interface ZnightErrorOptions extends ErrorOptions {
  /** Suggestions displayed under the error message. */
  readonly hints?: readonly string[]
}

/** Base class of every error thrown by Znight at runtime. */
export class ZnightError extends Error {
  readonly code: ErrorCode
  readonly hints: readonly string[]

  constructor(code: ErrorCode, message: string, options: ZnightErrorOptions = {}) {
    super(`${code}: ${message}`, options)
    this.name = 'ZnightError'
    this.code = code
    this.hints = options.hints ?? []
  }
}
