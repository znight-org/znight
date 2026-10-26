/**
 * A copy of the [Standard Schema v1](https://standardschema.dev) interface, flattened (no namespace,
 * so the file stays erasable). Every compliant library (Zod, Valibot, ArkType, Effect Schema...)
 * produces values assignable to {@link StandardSchemaV1}: no adapter and no dependency are needed.
 */

/** A schema implementing the Standard Schema v1 interface. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  /** The Standard Schema properties. */
  readonly '~standard': StandardSchemaV1Props<Input, Output>
}

/** The Standard Schema properties. */
export interface StandardSchemaV1Props<Input = unknown, Output = Input> {
  /** The version number of the standard. */
  readonly version: 1
  /** The vendor name of the schema library. */
  readonly vendor: string
  /** Validates an unknown input value (synchronously or not). */
  readonly validate: (
    value: unknown,
    options?: StandardSchemaV1Options | undefined,
  ) => StandardSchemaV1Result<Output> | Promise<StandardSchemaV1Result<Output>>
  /** Inferred types associated with the schema. */
  readonly types?: StandardSchemaV1Types<Input, Output> | undefined
}

/** Options of {@link StandardSchemaV1Props.validate}. */
export interface StandardSchemaV1Options {
  /** Vendor-specific parameters. */
  readonly libraryOptions?: Record<string, unknown> | undefined
}

/** Result of {@link StandardSchemaV1Props.validate}. */
export type StandardSchemaV1Result<Output> = StandardSchemaV1SuccessResult<Output> | StandardSchemaV1FailureResult

/** Successful validation: the (possibly transformed) output value. */
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

/** A path segment of an issue. */
export interface StandardSchemaV1PathSegment {
  readonly key: PropertyKey
}

/** Input and output types of a schema. */
export interface StandardSchemaV1Types<Input = unknown, Output = Input> {
  readonly input: Input
  readonly output: Output
}

/** The input type of a schema. */
export type InferSchemaInput<S extends StandardSchemaV1> = NonNullable<S['~standard']['types']>['input']

/** The output type of a schema (what handlers receive). */
export type InferSchemaOutput<S extends StandardSchemaV1> = NonNullable<S['~standard']['types']>['output']

/** Whether `value` looks like a Standard Schema v1 (has a `~standard` object with a `validate` function). */
export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false
  const props = (value as { '~standard'?: unknown })['~standard']
  return (
    props !== null &&
    typeof props === 'object' &&
    (props as { version?: unknown }).version === 1 &&
    typeof (props as { validate?: unknown }).validate === 'function'
  )
}
