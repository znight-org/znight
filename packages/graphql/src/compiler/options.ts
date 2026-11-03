/**
 * Options of the compiler extension (RFC 0005 §6.7, RFC 0007 §4.1), given with
 * `graphql.configure({ ... })` in `znight.config.ts`. Import-free.
 */

/** Options of `graphql.configure()`. */
export interface GraphQLCompilerOptions {
  /**
   * Path of the SDL artifact, relative to the project root (`'schema.graphql'`), written next to the
   * generated module and checked by `znight generate --check`. Default `false`: no file.
   */
  readonly sdl?: string | false
  /** GraphQL type of `number`. Default `'Float'`; `'Int'` suits counts and identifiers. Code-first only. */
  readonly number?: 'Float' | 'Int'
  /**
   * Schema-first mode (RFC 0007): globs of the `.graphql` files that define the schema, relative to
   * the project root (`'src/**\/*.graphql'`, `!` negations allowed). Resolvers are bound to their
   * fields by name and checked against the SDL. Default `false`: code-first.
   */
  readonly schema?: string | readonly string[] | false
}

/** {@link GraphQLCompilerOptions} with their defaults. */
export interface ResolvedGraphQLCompilerOptions {
  readonly sdl: string | false
  readonly number: 'Float' | 'Int'
  /** The schema-first globs; `false`: code-first. */
  readonly schema: readonly string[] | false
}

/** The defaults. */
export const DEFAULT_OPTIONS: ResolvedGraphQLCompilerOptions = Object.freeze({
  sdl: false,
  number: 'Float',
  schema: false,
})

const KNOWN = new Set(['sdl', 'number', 'schema'])

/**
 * Merges `options` onto `base`. Throws a `TypeError` naming the option on an invalid value: options
 * are written in `znight.config.ts`, the error surfaces when the configuration is loaded.
 */
export function resolveOptions(
  base: ResolvedGraphQLCompilerOptions,
  options: GraphQLCompilerOptions,
): ResolvedGraphQLCompilerOptions {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError('[znight] graphql.configure() expects an options object: { sdl?, number?, schema? }')
  }
  for (const key of Object.keys(options)) {
    if (!KNOWN.has(key))
      throw new TypeError(`[znight] graphql.configure(): unknown option "${key}" (options: sdl, number, schema)`)
  }
  const sdl = options.sdl === undefined ? base.sdl : options.sdl
  if (sdl !== false && (typeof sdl !== 'string' || sdl.trim() === '')) {
    throw new TypeError(
      '[znight] graphql.configure(): "sdl" must be a path relative to the project root (\'schema.graphql\') or false',
    )
  }
  const number = options.number === undefined ? base.number : options.number
  if (number !== 'Float' && number !== 'Int') {
    throw new TypeError(`[znight] graphql.configure(): "number" must be 'Float' or 'Int'`)
  }
  return Object.freeze({ sdl, number, schema: resolveSchema(base.schema, options.schema) })
}

function resolveSchema(
  base: readonly string[] | false,
  schema: GraphQLCompilerOptions['schema'],
): readonly string[] | false {
  if (schema === undefined) return base
  if (schema === false) return false
  const globs = typeof schema === 'string' ? [schema] : schema
  if (
    !Array.isArray(globs) ||
    globs.length === 0 ||
    globs.some(glob => typeof glob !== 'string' || glob.trim() === '')
  ) {
    throw new TypeError(
      '[znight] graphql.configure(): "schema" must be a glob or a non-empty list of globs relative to the project root (\'src/**/*.graphql\'), or false',
    )
  }
  return Object.freeze([...globs])
}
