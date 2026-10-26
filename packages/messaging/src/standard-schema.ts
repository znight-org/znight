/**
 * Copy of the [Standard Schema v1](https://standardschema.dev) interface (MIT). Zod, Valibot, ArkType,
 * Effect Schema... implement it: `@Message(schema)` accepts any of them without depending on one.
 *
 * The upstream declaration uses a namespace; the types are flattened here (`erasableSyntaxOnly`) but
 * remain structurally identical, so any Standard Schema implementation is assignable.
 */

/** A schema implementing the Standard Schema v1 interface. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1Props<Input, Output>
}

/** The `~standard` property of a {@link StandardSchemaV1}. */
export interface StandardSchemaV1Props<Input = unknown, Output = Input> {
  /** Version of the Standard Schema specification. */
  readonly version: 1
  /** Library implementing the schema (`zod`, `valibot`...). */
  readonly vendor: string
  /** Validates an unknown value, synchronously or asynchronously. */
  readonly validate: (value: unknown) => StandardSchemaV1Result<Output> | Promise<StandardSchemaV1Result<Output>>
  /** Inferred types (type-level only). */
  readonly types?: StandardSchemaV1Types<Input, Output> | undefined
}

/** Result of {@link StandardSchemaV1Props.validate}. */
export type StandardSchemaV1Result<Output> = StandardSchemaV1SuccessResult<Output> | StandardSchemaV1FailureResult

/** Successful validation: `value` is the schema output (defaults, transforms applied). */
export interface StandardSchemaV1SuccessResult<Output> {
  readonly value: Output
  readonly issues?: undefined
}

/** Failed validation. */
export interface StandardSchemaV1FailureResult {
  readonly issues: readonly StandardSchemaV1Issue[]
}

/** One validation issue. */
export interface StandardSchemaV1Issue {
  readonly message: string
  readonly path?: readonly (PropertyKey | StandardSchemaV1PathSegment)[] | undefined
}

/** A segment of an issue path. */
export interface StandardSchemaV1PathSegment {
  readonly key: PropertyKey
}

/** Input and output types of a schema (type-level only). */
export interface StandardSchemaV1Types<Input = unknown, Output = Input> {
  readonly input: Input
  readonly output: Output
}

/** Input type of a Standard Schema. */
export type InferSchemaInput<Schema extends StandardSchemaV1> = NonNullable<Schema['~standard']['types']>['input']

/** Output type of a Standard Schema (what handlers receive). */
export type InferSchemaOutput<Schema extends StandardSchemaV1> = NonNullable<Schema['~standard']['types']>['output']

/** Whether `value` looks like a Standard Schema v1 (has a `~standard.validate` function). */
export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false
  const props = (value as { '~standard'?: unknown })['~standard']
  return props !== null && typeof props === 'object' && typeof (props as { validate?: unknown }).validate === 'function'
}
