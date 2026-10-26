import type { ExternalDefinition, ProviderClass, ProviderDefinition, Token, ZnightMetadata } from '@znight/core'

import { describeToken, displayName, ErrorCode, METADATA_VERSION, ZnightError } from '@znight/core'

/**
 * Read-only index over compiled metadata: provider definitions, aliases, externals and the key
 * lookups shared by `TestBed`, `mocks.get()` and the testing helpers (class, token, alias or display
 * name → canonical token). Internal.
 */
export class MetadataIndex {
  readonly metadata: ZnightMetadata
  readonly #providers = new Map<Token, ProviderDefinition>()
  readonly #aliases = new Map<Token, Token>()
  readonly #externals = new Map<Token, ExternalDefinition>()

  constructor(metadata: ZnightMetadata) {
    assertMetadata(metadata)
    this.metadata = metadata
    for (const [token, definition] of Object.entries(metadata.providers)) this.#providers.set(token, definition)
    for (const [alias, target] of Object.entries(metadata.aliases ?? {})) this.#aliases.set(alias, target)
    for (const external of metadata.externals ?? []) {
      if (typeof external?.token === 'string') this.#externals.set(external.token, external)
    }
  }

  /** Every provider token, in declaration order. */
  providerTokens(): IterableIterator<Token> {
    return this.#providers.keys()
  }

  definition(token: Token): ProviderDefinition | undefined {
    return this.#providers.get(token)
  }

  isProvider(token: Token): boolean {
    return this.#providers.has(token)
  }

  external(token: Token): ExternalDefinition | undefined {
    return this.#externals.get(token)
  }

  /** Whether `token` is a provider, an alias or an external of the metadata. */
  isKnown(token: Token): boolean {
    return this.#providers.has(token) || this.#aliases.has(token) || this.#externals.has(token)
  }

  /** Provider, alias and external tokens. */
  knownTokens(): Set<Token> {
    return new Set([...this.#providers.keys(), ...this.#aliases.keys(), ...this.#externals.keys()])
  }

  /** The class of a provider, when it is a class provider. */
  classOf(token: Token): ProviderClass | undefined {
    return this.#providers.get(token)?.class
  }

  /** Follows aliases (cycle-guarded) until a provider token; returns `token` itself otherwise. */
  canonical(token: Token): Token {
    let current = token
    const seen = new Set<Token>()
    while (!this.#providers.has(current) && this.#aliases.has(current) && !seen.has(current)) {
      seen.add(current)
      current = this.#aliases.get(current) as Token
    }
    return current
  }

  /** Alias entries (alias → target), for filtering and display. */
  aliases(): IterableIterator<[Token, Token]> {
    return this.#aliases.entries()
  }

  /**
   * Finds the canonical token designated by `key` among `universe`:
   * - a string: a token of `universe`, an alias resolving into it, or a unique display name
   *   (`'UserService'`) of a token or alias;
   * - a class: the token whose provider class is `key`, else the unique token whose class extends
   *   it, else a unique display name equal to the class name (externals, interfaces).
   *
   * @throws ZnightError ZNIGHT008 when a display name is ambiguous.
   */
  find(key: unknown, universe: ReadonlySet<Token>): Token | undefined {
    if (typeof key === 'string') {
      if (universe.has(key)) return key
      const canonical = this.canonical(key)
      if (universe.has(canonical)) return canonical
      return this.#findByName(key, universe, undefined)
    }
    if (typeof key !== 'function') return undefined
    const cls = key as ProviderClass
    const exact = [...universe].filter(token => this.classOf(token) === cls)
    if (exact.length > 0) return exact[0]
    const derived = [...universe].filter(token => extendsClass(this.classOf(token), cls))
    if (derived.length === 1) return derived[0]
    if (derived.length > 1) throw ambiguousError(cls.name, derived)
    const name = cls.name
    return typeof name === 'string' && name !== '' ? this.#findByName(name, universe, cls) : undefined
  }

  #findByName(name: string, universe: ReadonlySet<Token>, cls: ProviderClass | undefined): Token | undefined {
    // an alias and its provider designate the same thing: matches are compared by canonical token
    const matches = new Set<Token>()
    const add = (token: Token): void => {
      const canonical = this.canonical(token)
      if (universe.has(canonical)) matches.add(canonical)
      else if (universe.has(token)) matches.add(token)
    }
    for (const token of universe) if (displayName(token) === name) add(token)
    for (const [alias] of this.#aliases) if (displayName(alias) === name) add(alias)
    const candidates = [...matches].filter(token => {
      if (cls === undefined) return true
      const own = this.classOf(token)
      return own === undefined || own === cls || extendsClass(own, cls)
    })
    if (candidates.length === 1) return candidates[0]
    if (candidates.length > 1) throw ambiguousError(name, candidates)
    return undefined
  }
}

function extendsClass(candidate: ProviderClass | undefined, base: ProviderClass): boolean {
  if (candidate === undefined || candidate === base) return false
  const prototype: unknown = base.prototype
  return typeof prototype === 'object' && prototype !== null && candidate.prototype instanceof base
}

function ambiguousError(name: string, tokens: readonly Token[]): ZnightError {
  return new ZnightError(
    ErrorCode.AmbiguousInjection,
    `"${name}" is ambiguous: it matches ${tokens.map(describeToken).join(', ')}`,
    { hints: ['Use the full token (or the class) instead of the display name'] },
  )
}

function assertMetadata(metadata: ZnightMetadata): void {
  if (
    metadata === null ||
    typeof metadata !== 'object' ||
    metadata.providers === null ||
    typeof metadata.providers !== 'object'
  ) {
    throw new ZnightError(
      ErrorCode.MissingProvider,
      'No compiled metadata: expected the generated __ZNIGHT_METADATA__',
      {
        hints: [
          'Pass { metadata: __ZNIGHT_METADATA__ } imported from src/.znight/container.generated.ts',
          'Generate it before running tests: `znight generate`, the Bun preload `@znight/compiler/bun` or the Vite plugin under Vitest',
        ],
      },
    )
  }
  if (metadata.version !== METADATA_VERSION) {
    throw new ZnightError(
      ErrorCode.VersionMismatch,
      `Unsupported metadata version ${String(metadata.version)} (expected ${METADATA_VERSION})`,
      { hints: ['Regenerate the metadata with the @znight/compiler version matching @znight/testing'] },
    )
  }
}
