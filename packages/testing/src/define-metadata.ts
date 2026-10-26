import type {
  ClassKey,
  DependencyRef,
  ExternalDefinition,
  MethodInterception,
  ProviderClass,
  ProviderDefinition,
  ProviderFactory,
  Scope,
  SourceLocation,
  Token,
  ZnightExtensionsMetadata,
  ZnightMetadata,
} from '@znight/core'

import { describeToken, ErrorCode, isProviderDefinition, METADATA_VERSION, ZnightError } from '@znight/core'

import { entriesOf } from './utils.ts'

/** Options of {@link createMetadata}. */
export interface CreateMetadataOptions {
  readonly aliases?: Readonly<Record<Token, Token>>
  /** Externals, as tokens or full definitions (`{ token, scope, providedBy }`). */
  readonly externals?: readonly (Token | ExternalDefinition)[]
  readonly extensions?: ZnightExtensionsMetadata
  /** Default: a deterministic topological order (dependencies first, declaration order otherwise). */
  readonly resolutionOrder?: readonly Token[]
}

/**
 * Hand-written metadata with the exact shape the compiler generates (version, resolution order...),
 * for tests that do not run the compiler (plugins, libraries, edge cases).
 *
 * ```ts
 * const metadata = createMetadata({
 *   'src/clock.ts#Clock': { scope: 'singleton', class: Clock, deps: [], factory: () => new Clock() },
 * })
 * ```
 *
 * @throws ZnightError ZNIGHT005 for a malformed provider definition.
 */
export function createMetadata(
  providers: Readonly<Record<Token, ProviderDefinition>>,
  options: CreateMetadataOptions = {},
): ZnightMetadata {
  if (providers === null || typeof providers !== 'object') {
    throw new TypeError('[znight] createMetadata() expects a record of provider definitions')
  }
  for (const [token, definition] of Object.entries(providers)) {
    if (!isProviderDefinition(definition)) {
      throw new ZnightError(
        ErrorCode.InvalidDecorator,
        `Invalid provider definition for ${describeToken(token)}: expected { scope, deps, factory }`,
      )
    }
  }
  const externals = options.externals?.map(external =>
    typeof external === 'string' ? ({ token: external } satisfies ExternalDefinition) : external,
  )
  return {
    version: METADATA_VERSION,
    providers,
    resolutionOrder: options.resolutionOrder ?? topologicalOrder(providers),
    ...(options.aliases === undefined ? {} : { aliases: options.aliases }),
    ...(externals === undefined ? {} : { externals }),
    ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
  }
}

/** A provider class or a token, in {@link defineTestMetadata}. */
export type TestKey = Token | ProviderClass | ClassKey

/** A dependency in {@link defineTestMetadata}: like `DependencyRef`, with classes allowed in place of tokens. */
export type TestDependency =
  | TestKey
  | { readonly token: TestKey; readonly optional: true }
  | { readonly multi: readonly TestKey[] }
  | { readonly lazy: TestKey }

/** A provider in {@link defineTestMetadata}. */
export interface TestProvider<T = unknown> {
  /** Default: `test#<ClassName>` (see `tokenPrefix`). Required without `class`. */
  readonly token?: Token
  readonly class?: ProviderClass<T>
  /** Default: `'singleton'`. */
  readonly scope?: Scope
  /** Constructor (or factory) dependencies, in parameter order. */
  readonly deps?: readonly TestDependency[]
  /** Default: `deps => new Class(...deps)`. Required without `class`. */
  readonly factory?: ProviderFactory<T>
  readonly async?: boolean
  readonly interceptors?: Readonly<Record<string, MethodInterception>>
  readonly dispose?: string
  /** `@Named` qualifier. */
  readonly name?: string
  readonly primary?: boolean
  readonly source?: SourceLocation
}

/** Input of {@link defineTestMetadata}. */
export interface TestMetadataSpec {
  /** Providers: classes (no dependency) or {@link TestProvider}s. */
  readonly providers?: readonly (TestProvider | ProviderClass)[]
  /** Alias → provider pairs (`[UserRepository, PgUserRepository]`), or a record of tokens. */
  readonly aliases?: Iterable<readonly [TestKey, TestKey]> | Readonly<Record<Token, TestKey>>
  readonly externals?: readonly (Token | ExternalDefinition)[]
  /** Feature metadata (`http`, `messaging`, `config`), tokens written with {@link testToken}. */
  readonly extensions?: ZnightExtensionsMetadata
  readonly resolutionOrder?: readonly Token[]
  /** Prefix of the tokens derived from class names. Default: `'test'` (`test#UserService`). */
  readonly tokenPrefix?: string
}

const DEFAULT_PREFIX = 'test'

/** The token {@link defineTestMetadata} derives from a class: `<prefix>#<ClassName>`. */
export function testToken(cls: ProviderClass | ClassKey, prefix: string = DEFAULT_PREFIX): Token {
  const name = typeof cls === 'function' ? (cls as { name?: unknown }).name : undefined
  if (typeof name !== 'string' || name === '') {
    throw new TypeError('[znight] testToken(): expected a named class')
  }
  return `${prefix}#${name}`
}

/**
 * Class-first hand-written metadata: tokens are derived from class names (`test#UserService`),
 * dependencies may be classes, factories default to `new Class(...deps)` and the resolution order
 * is computed.
 *
 * ```ts
 * const metadata = defineTestMetadata({
 *   providers: [
 *     PgUserRepository,
 *     { class: UserService, deps: [PgUserRepository, '@znight/observability#Logger'] },
 *   ],
 *   aliases: [[UserRepository, PgUserRepository]],
 *   externals: ['@znight/observability#Logger'],
 * })
 * ```
 *
 * @throws ZnightError ZNIGHT004 for duplicate tokens; TypeError for a provider without class nor
 *   token/factory.
 */
export function defineTestMetadata(spec: TestMetadataSpec = {}): ZnightMetadata {
  const prefix = spec.tokenPrefix ?? DEFAULT_PREFIX
  const providers = (spec.providers ?? []).map(entry =>
    typeof entry === 'function' ? ({ class: entry } satisfies TestProvider) : entry,
  )
  const classTokens = new Map<unknown, Token>()
  const tokens = providers.map(provider => {
    if (provider === null || typeof provider !== 'object') {
      throw new TypeError(
        '[znight] defineTestMetadata(): a provider must be a class or { class?, token?, deps?, factory? }',
      )
    }
    const token = provider.token ?? (provider.class === undefined ? undefined : testToken(provider.class, prefix))
    if (token === undefined) throw new TypeError('[znight] defineTestMetadata(): a provider needs a class or a token')
    if (provider.class !== undefined && !classTokens.has(provider.class)) classTokens.set(provider.class, token)
    return token
  })
  const toToken = (key: TestKey): Token => {
    if (typeof key === 'string') return key
    return classTokens.get(key) ?? testToken(key, prefix)
  }

  const definitions = new Map<Token, ProviderDefinition>()
  providers.forEach((provider, position) => {
    const token = tokens[position] as Token
    if (definitions.has(token)) {
      throw new ZnightError(
        ErrorCode.DuplicateProvider,
        `defineTestMetadata(): duplicate provider ${describeToken(token)}`,
        {
          hints: ['Give one of them an explicit token'],
        },
      )
    }
    definitions.set(token, toDefinition(token, provider, toToken))
  })

  let aliases: Record<Token, Token> | undefined
  if (spec.aliases !== undefined) {
    const pairs = entriesOf<TestKey, TestKey>(spec.aliases).map(([alias, target]): [Token, Token] => [
      toToken(alias),
      toToken(target),
    ])
    aliases = Object.fromEntries(pairs)
  }
  return createMetadata(Object.fromEntries(definitions), {
    ...(aliases === undefined ? {} : { aliases }),
    ...(spec.externals === undefined ? {} : { externals: spec.externals }),
    ...(spec.extensions === undefined ? {} : { extensions: spec.extensions }),
    ...(spec.resolutionOrder === undefined ? {} : { resolutionOrder: spec.resolutionOrder }),
  })
}

function toDefinition(token: Token, provider: TestProvider, toToken: (key: TestKey) => Token): ProviderDefinition {
  const cls = provider.class
  let factory = provider.factory
  if (factory === undefined) {
    if (cls === undefined) throw new TypeError(`[znight] defineTestMetadata(): ${token} needs a class or a factory`)
    const constructible = cls as unknown as new (...args: unknown[]) => unknown
    factory = (deps: unknown[]) => new constructible(...deps)
  }
  const deps = (provider.deps ?? []).map(dep => toDependency(dep, toToken))
  return {
    scope: provider.scope ?? 'singleton',
    deps,
    factory,
    ...(cls === undefined ? {} : { class: cls }),
    ...(provider.async === undefined ? {} : { async: provider.async }),
    ...(provider.interceptors === undefined ? {} : { interceptors: provider.interceptors }),
    ...(provider.dispose === undefined ? {} : { dispose: provider.dispose }),
    ...(provider.name === undefined ? {} : { name: provider.name }),
    ...(provider.primary === undefined ? {} : { primary: provider.primary }),
    ...(provider.source === undefined ? {} : { source: provider.source }),
  }
}

function toDependency(dep: TestDependency, toToken: (key: TestKey) => Token): DependencyRef {
  if (typeof dep === 'string' || typeof dep === 'function') return toToken(dep)
  if (dep !== null && typeof dep === 'object') {
    if ('multi' in dep && Array.isArray(dep.multi)) return { multi: dep.multi.map(toToken) }
    if ('lazy' in dep && dep.lazy !== undefined) return { lazy: toToken(dep.lazy) }
    if ('token' in dep && dep.optional === true) return { token: toToken(dep.token), optional: true }
    if ('prototype' in dep) return toToken(dep as ClassKey)
  }
  throw new TypeError(`[znight] defineTestMetadata(): invalid dependency ${String(dep)}`)
}

/** Hard dependencies of a definition (lazy ones excluded: they never constrain the order). */
function hardDependencies(definition: ProviderDefinition): Token[] {
  const tokens: Token[] = []
  for (const ref of definition.deps) {
    if (typeof ref === 'string') tokens.push(ref)
    else if ('multi' in ref) tokens.push(...ref.multi)
    else if ('token' in ref) tokens.push(ref.token)
  }
  return tokens
}

/** Deterministic topological order (dependencies first). Cycles are left for the container to report. */
function topologicalOrder(providers: Readonly<Record<Token, ProviderDefinition>>): Token[] {
  const order: Token[] = []
  const state = new Map<Token, 'visiting' | 'done'>()
  const visit = (token: Token): void => {
    if (state.has(token) || !Object.hasOwn(providers, token)) return
    state.set(token, 'visiting')
    for (const dep of hardDependencies(providers[token] as ProviderDefinition)) visit(dep)
    state.set(token, 'done')
    order.push(token)
  }
  for (const token of Object.keys(providers)) visit(token)
  return order
}
