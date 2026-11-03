/**
 * Options of the compiler extension (RFC 0005 §6.7), given with `graphql.configure({ ... })` in
 * `znight.config.ts`. Import-free.
 */

/** Options of `graphql.configure()`. */
export interface GraphQLCompilerOptions {
  /**
   * Path of the SDL artifact, relative to the project root (`'schema.graphql'`), written next to the
   * generated module and checked by `znight generate --check`. Default `false`: no file.
   */
  readonly sdl?: string | false
  /** GraphQL type of `number`. Default `'Float'`; `'Int'` suits counts and identifiers. */
  readonly number?: 'Float' | 'Int'
}

/** {@link GraphQLCompilerOptions} with their defaults. */
export interface ResolvedGraphQLCompilerOptions {
  readonly sdl: string | false
  readonly number: 'Float' | 'Int'
}

/** The defaults. */
export const DEFAULT_OPTIONS: ResolvedGraphQLCompilerOptions = Object.freeze({ sdl: false, number: 'Float' })

const KNOWN = new Set(['sdl', 'number'])

/**
 * Merges `options` onto `base`. Throws a `TypeError` naming the option on an invalid value: options
 * are written in `znight.config.ts`, the error surfaces when the configuration is loaded.
 */
export function resolveOptions(
  base: ResolvedGraphQLCompilerOptions,
  options: GraphQLCompilerOptions,
): ResolvedGraphQLCompilerOptions {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError('[znight] graphql.configure() expects an options object: { sdl?, number? }')
  }
  for (const key of Object.keys(options)) {
    if (!KNOWN.has(key))
      throw new TypeError(`[znight] graphql.configure(): unknown option "${key}" (options: sdl, number)`)
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
  return Object.freeze({ sdl, number })
}
