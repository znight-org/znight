/**
 * Error codes shared by the compiler (build-time diagnostics) and the runtime (`ZnightError`).
 * Documented in docs/internals/architecture.md.
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
