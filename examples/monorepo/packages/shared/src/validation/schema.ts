/**
 * A deliberately tiny [Standard Schema](https://standardschema.dev) toolkit for the DTOs of this
 * library.
 *
 * `@Body(schema)`, `@Query(schema)` (`@znight/http`) and `@Message(schema)` (`@znight/messaging`)
 * accept any object implementing Standard Schema v1: Zod, Valibot, ArkType... or this file. The
 * shared package keeps a single runtime dependency (`@znight/core`) so that every service can use
 * its schemas whatever validation library it picked itself (`users-api` also uses Zod for its own
 * query parameters). In your own monorepo, sharing Zod schemas works the same way: add `zod` to the
 * dependencies of the shared package.
 */

/** One validation problem: a message and the path of the offending value (`['email']`). */
export interface Issue {
  readonly message: string
  readonly path?: readonly PropertyKey[] | undefined
}

/** Result of {@link Schema} validation: the (normalised) value, or the issues. */
export type ValidationResult<T> =
  | { readonly value: T; readonly issues?: undefined }
  | { readonly issues: readonly Issue[] }

/** A Standard Schema v1 whose output type is `T`. */
export interface Schema<T> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) => ValidationResult<T>
    /** Type-level only: lets `@Body(schema)` infer the handler parameter type. */
    readonly types?: { readonly input: unknown; readonly output: T } | undefined
  }
}

/** Validates one field. Problems are pushed to `issues` (the returned value is then ignored). */
export interface Field<T> {
  check(value: unknown, path: readonly PropertyKey[], issues: Issue[]): T
}

/** Options of {@link text}. */
export interface TextOptions {
  /** Minimum length, after trimming. Default 1 (blank strings are refused). */
  readonly min?: number
  /** Maximum length, after trimming. */
  readonly max?: number
}

/** A string, trimmed. */
export function text(options: TextOptions = {}): Field<string> {
  const { min = 1, max = Number.POSITIVE_INFINITY } = options
  return {
    check(value, path, issues) {
      if (typeof value !== 'string') {
        issues.push({ message: value === undefined ? 'Required' : 'Expected a string', path })
        return ''
      }
      const trimmed = value.trim()
      if (trimmed.length < min) issues.push({ message: `Must contain at least ${min} character(s)`, path })
      if (trimmed.length > max) issues.push({ message: `Must contain at most ${max} character(s)`, path })
      return trimmed
    },
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** An email address, trimmed and lower-cased (`Ada@Example.com` and `ada@example.com` are equal). */
export function email(): Field<string> {
  const base = text({ max: 254 })
  return {
    check(value, path, issues) {
      const count = issues.length
      const address = base.check(value, path, issues).toLowerCase()
      if (issues.length === count && !EMAIL.test(address)) issues.push({ message: 'Invalid email address', path })
      return address
    },
  }
}

/** An ISO 8601 date-time string, normalised to `Date#toISOString()` (UTC, milliseconds). */
export function timestamp(): Field<string> {
  return {
    check(value, path, issues) {
      const date = typeof value === 'string' ? new Date(value) : undefined
      if (date === undefined || Number.isNaN(date.getTime())) {
        issues.push({ message: value === undefined ? 'Required' : 'Expected an ISO 8601 date-time', path })
        return ''
      }
      return date.toISOString()
    },
  }
}

/** Makes a field optional: `undefined` (absent) is accepted. */
export function optional<T>(field: Field<T>): Field<T | undefined> {
  return {
    check: (value, path, issues) => (value === undefined ? undefined : field.check(value, path, issues)),
  }
}

/**
 * An object schema. The shape lists a field for every property of `T` (checked by TypeScript);
 * unknown properties are stripped, absent optional properties are omitted.
 *
 * ```ts
 * export interface CreateUserInput { readonly email: string; readonly name: string }
 * export const CreateUserInput = object<CreateUserInput>({ email: email(), name: text({ max: 100 }) })
 * ```
 */
export function object<T extends object>(shape: { readonly [K in keyof T]-?: Field<T[K]> }): Schema<T> & Field<T> {
  const entries = Object.entries(shape) as [string, Field<unknown>][]
  const check = (value: unknown, path: readonly PropertyKey[], issues: Issue[]): T => {
    const output: Record<string, unknown> = {}
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      issues.push({ message: value === undefined ? 'Required' : 'Expected an object', path })
      return output as T
    }
    const input = value as Record<string, unknown>
    for (const [key, field] of entries) {
      const result = field.check(input[key], [...path, key], issues)
      if (result !== undefined) output[key] = result
    }
    return output as T
  }
  return {
    check,
    '~standard': {
      version: 1,
      vendor: 'znight-examples',
      validate(value) {
        const issues: Issue[] = []
        const result = check(value, [], issues)
        return issues.length > 0 ? { issues } : { value: result }
      },
    },
  }
}
