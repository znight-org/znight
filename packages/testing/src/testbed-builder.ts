import type { DependencyRef, ProviderDefinition, ProviderValues, Token, ZnightMetadata } from '@znight/core'
import type { ConfigClassInfo } from './extensions.ts'
import type { AopMode, TestBedOptions, TestBedResult } from './testbed.ts'
import type { MockFnFactory } from './types.ts'

import {
  applyInterceptors,
  Container,
  describeToken,
  displayName,
  ErrorCode,
  formatPath,
  InstantiationError,
  isProviderDefinition,
  METADATA_VERSION,
  ZnightError,
} from '@znight/core'

import { buildConfigInstance, normalizeConfigValues } from './config.ts'
import { readConfigClasses } from './extensions.ts'
import { MetadataIndex } from './metadata-index.ts'
import { mockObject } from './mock.ts'
import { resolveMockFn } from './mock-fn.ts'
import { type InjectionKind, TestMocks } from './mock-registry.ts'
import { describeKey, entriesOf, isThenable } from './utils.ts'

const AOP_MODES: ReadonlySet<AopMode | undefined> = new Set([undefined, 'none', 'real'])

/**
 * Builds the target of `TestBed.create()`: resolves keys, injects auto-mocks / provided values /
 * configuration instances, runs the factory and assembles the result container. Internal.
 */
export class Builder {
  readonly #index: MetadataIndex
  readonly #options: TestBedOptions
  readonly #mockFn: MockFnFactory
  readonly #configs: ReadonlyMap<Token, ConfigClassInfo>
  readonly #configValues: ReadonlyMap<Token, Record<string, unknown>>
  readonly #provided: ReadonlyMap<Token, unknown>
  readonly #overrides: ReadonlyMap<Token, unknown>
  /** Values injected into the target (and into built dependencies), by canonical token. */
  readonly #values = new Map<Token, unknown>()
  /** Real interceptors (aop: 'real'), by canonical token. */
  readonly #interceptors = new Map<Token, unknown>()
  readonly #kinds = new Map<Token, InjectionKind>()
  readonly #mocks = new Map<Token, object>()
  /** Providers being built (cycle guard). */
  readonly #building = new Set<Token>()
  #known: Set<Token> | undefined

  constructor(options: TestBedOptions) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('[znight] TestBed.create(target, { metadata }) requires options with the generated metadata')
    }
    if (!AOP_MODES.has(options.aop)) {
      throw new TypeError(`[znight] TestBed.create(): aop must be 'none' or 'real', got ${String(options.aop)}`)
    }
    this.#options = options
    this.#index = new MetadataIndex(options.metadata)
    this.#mockFn = resolveMockFn(options.mockFn).create
    this.#configs = readConfigClasses(options.metadata)
    this.#configValues = normalizeConfigValues(options.config, this.#index, this.#configs)
    this.#provided = this.#normalize(options.provide, 'provide')
    this.#overrides = this.#normalize(options.overrides, 'overrides')
  }

  async build(target: unknown): Promise<TestBedResult<unknown>> {
    const token = this.#resolveTarget(target)
    let definition = this.#index.definition(token) as ProviderDefinition
    if (this.#overrides.has(token)) {
      const replacement = this.#overrides.get(token)
      if (!isProviderDefinition(replacement)) {
        throw new ZnightError(
          ErrorCode.InvalidDecorator,
          `overrides: the target ${displayName(token)} can only be replaced by a provider definition { scope, deps, factory }`,
        )
      }
      definition = replacement
    }
    const instance = await this.#construct(token, definition, [token])
    const container = await this.#createContainer(token, definition, instance)
    const others = new Map(this.#kinds)
    return {
      instance,
      mocks: new TestMocks(this.#mocks, others, this.#index, token),
      container,
    }
  }

  // -----------------------------------------------------------------------------------------------
  // Keys
  // -----------------------------------------------------------------------------------------------

  #resolveTarget(target: unknown): Token {
    const token = this.#index.find(target, new Set(this.#index.providerTokens()))
    if (token !== undefined) return token
    throw new ZnightError(
      ErrorCode.MissingProvider,
      `TestBed: ${describeKey(target)} is not a provider of the metadata`,
      {
        hints: [
          'Check that the class is decorated (@Injectable(), @Controller()...) and exported',
          'Regenerate the metadata before running tests: `znight generate`, the Bun preload `@znight/compiler/bun` or the Vite plugin',
        ],
      },
    )
  }

  /** Every token a `provide`/`overrides` key may designate (canonical). */
  #knownTokens(): Set<Token> {
    if (this.#known !== undefined) return this.#known
    const index = this.#index
    const known = new Set<Token>()
    const add = (token: unknown): void => {
      if (typeof token === 'string') known.add(index.canonical(token))
    }
    for (const token of index.providerTokens()) {
      known.add(token)
      for (const ref of (index.definition(token) as ProviderDefinition).deps) {
        for (const dep of tokensOfRef(ref)) add(dep)
      }
    }
    for (const external of index.metadata.externals ?? []) add(external?.token)
    for (const [alias] of index.aliases()) add(alias)
    this.#known = known
    return known
  }

  #normalize(values: ProviderValues | undefined, option: 'provide' | 'overrides'): Map<Token, unknown> {
    const result = new Map<Token, unknown>()
    if (values === undefined) return result
    const known = this.#knownTokens()
    for (const [key, value] of entriesOf<unknown, unknown>(values)) {
      const token = this.#index.find(key, known)
      if (token === undefined) {
        throw new ZnightError(
          ErrorCode.MissingProvider,
          `${option}: ${describeKey(key)} matches no provider, external or dependency of the metadata`,
          { hints: ['Use a class, a token, an alias or a unique display name (e.g. "UserRepository")'] },
        )
      }
      if (result.has(token)) {
        throw new ZnightError(ErrorCode.DuplicateProvider, `${option}: several values for ${describeToken(token)}`)
      }
      result.set(token, value)
    }
    return result
  }

  #isExplicit(token: Token): boolean {
    const canonical = this.#index.canonical(token)
    return this.#overrides.has(canonical) || this.#provided.has(canonical)
  }

  // -----------------------------------------------------------------------------------------------
  // Construction
  // -----------------------------------------------------------------------------------------------

  async #construct(token: Token, definition: ProviderDefinition, path: readonly Token[]): Promise<unknown> {
    if (this.#building.has(token)) {
      throw new ZnightError(ErrorCode.CircularDependency, `Circular dependency: ${formatPath([...path])}`)
    }
    this.#building.add(token)
    try {
      const interceptorDeps = interceptorIndices(definition)
      const deps: unknown[] = new Array(definition.deps.length)
      for (let index = 0; index < definition.deps.length; index++) {
        const ref = definition.deps[index] as DependencyRef
        if (!interceptorDeps.has(index)) deps[index] = await this.#resolve(ref, path)
        else if (this.#options.aop === 'real') deps[index] = await this.#interceptor(ref, path)
        else for (const dep of tokensOfRef(ref)) this.#record(this.#index.canonical(dep), 'interceptor')
      }
      let instance: unknown
      try {
        instance = definition.factory(deps)
        if (isThenable(instance)) instance = await instance
      } catch (error) {
        throw new InstantiationError(token, path, error, definition.source)
      }
      if (this.#options.aop === 'real' && definition.interceptors !== undefined) {
        try {
          applyInterceptors(instance as object, definition.interceptors, deps, displayName(token))
        } catch (error) {
          throw new InstantiationError(token, path, error, definition.source)
        }
      }
      return instance
    } finally {
      this.#building.delete(token)
    }
  }

  async #resolve(ref: DependencyRef, path: readonly Token[]): Promise<unknown> {
    if (typeof ref === 'string') return this.#value(ref, path)
    if (ref !== null && typeof ref === 'object') {
      if ('multi' in ref && Array.isArray(ref.multi)) {
        const values: unknown[] = []
        for (const token of ref.multi as readonly Token[]) {
          if (this.#isExplicit(token)) values.push(await this.#value(token, path))
        }
        return values
      }
      if ('lazy' in ref && typeof ref.lazy === 'string') {
        const value = await this.#value(ref.lazy, path)
        return { get: (): unknown => value }
      }
      if ('token' in ref && typeof ref.token === 'string') {
        if (this.#isExplicit(ref.token)) return this.#value(ref.token, path)
        this.#record(this.#index.canonical(ref.token), 'optional')
        return undefined
      }
    }
    throw new ZnightError(
      ErrorCode.InvalidDecorator,
      `Invalid dependency of ${displayName(path[path.length - 1] as Token)}: ${safeJson(ref)}`,
      { hints: ['Expected a token, { token, optional: true }, { multi: [...] } or { lazy: token }'] },
    )
  }

  /** The value injected for `token` (cached: the same dependency always gets the same value). */
  async #value(token: Token, path: readonly Token[]): Promise<unknown> {
    const canonical = this.#index.canonical(token)
    if (this.#values.has(canonical)) return this.#values.get(canonical)
    let value: unknown
    if (this.#overrides.has(canonical)) {
      value = await this.#explicit(canonical, this.#overrides.get(canonical), path)
      this.#record(canonical, 'override')
    } else if (this.#provided.has(canonical)) {
      value = this.#provided.get(canonical)
      this.#record(canonical, 'provided')
    } else if (this.#configs.has(canonical)) {
      const info = this.#configs.get(canonical) as ConfigClassInfo
      value = buildConfigInstance(info, this.#index.classOf(canonical), this.#configValues.get(canonical))
      this.#record(canonical, 'config')
    } else {
      value = this.#autoMock(canonical, path)
    }
    this.#values.set(canonical, value)
    return value
  }

  /** An override (a value, or a definition built with its dependencies resolved like the target's). */
  #explicit(token: Token, value: unknown, path: readonly Token[]): Promise<unknown> | unknown {
    return isProviderDefinition(value) ? this.#construct(token, value, [...path, token]) : value
  }

  #autoMock(token: Token, path: readonly Token[]): object {
    const definition = this.#index.definition(token)
    if (definition !== undefined && definition.class === undefined && definition.name !== undefined) {
      throw qualifiedValueError(token, definition.name, path)
    }
    const mock = mockObject(definition?.class, undefined, {
      name: displayName(token),
      deep: this.#options.deep === true,
      mockFn: this.#mockFn,
    })
    this.#mocks.set(token, mock)
    this.#kinds.delete(token)
    return mock
  }

  /** A real interceptor (aop: 'real'): explicit value, or built from its compiled definition. */
  async #interceptor(ref: DependencyRef, path: readonly Token[]): Promise<unknown> {
    if (typeof ref !== 'string') return this.#resolve(ref, path)
    const token = this.#index.canonical(ref)
    if (this.#interceptors.has(token)) return this.#interceptors.get(token)
    let value: unknown
    if (this.#overrides.has(token)) {
      value = await this.#explicit(token, this.#overrides.get(token), path)
      this.#record(token, 'override')
    } else if (this.#provided.has(token)) {
      value = this.#provided.get(token)
      this.#record(token, 'provided')
    } else {
      const definition = this.#index.definition(token)
      if (definition === undefined) {
        const providedBy = this.#index.external(token)?.providedBy
        throw new ZnightError(
          ErrorCode.MissingProvider,
          `aop: 'real' needs the interceptor ${describeToken(token)}, supplied at runtime by ${providedBy ?? 'a plugin'}`,
          { hints: [`Pass an instance: provide: [[${JSON.stringify(token)}, interceptor]]`] },
        )
      }
      value = await this.#construct(token, definition, [...path, token])
      this.#record(token, 'real')
    }
    this.#interceptors.set(token, value)
    return value
  }

  #record(token: Token, kind: InjectionKind): void {
    if (!this.#mocks.has(token)) this.#kinds.set(token, kind)
  }

  // -----------------------------------------------------------------------------------------------
  // Result container
  // -----------------------------------------------------------------------------------------------

  async #createContainer(target: Token, definition: ProviderDefinition, instance: unknown): Promise<Container> {
    const bound = new Map<Token, unknown>([[target, instance]])
    for (const [token, value] of this.#values) if (value !== undefined && !bound.has(token)) bound.set(token, value)
    for (const [token, value] of this.#interceptors) {
      if (value !== undefined && !bound.has(token)) bound.set(token, value)
    }
    const providers = [...bound.keys()].map((token): [Token, ProviderDefinition] => {
      const cls = token === target ? (definition.class ?? this.#index.classOf(token)) : this.#index.classOf(token)
      // placeholder definitions: they register the classes for lookups, the values are bound below
      return [
        token,
        { scope: 'singleton', deps: [], factory: () => undefined, ...(cls === undefined ? {} : { class: cls }) },
      ]
    })
    const aliases: [Token, Token][] = []
    for (const [alias] of this.#index.aliases()) {
      const canonical = this.#index.canonical(alias)
      if (bound.has(canonical) && !bound.has(alias)) aliases.push([alias, canonical])
    }
    const metadata: ZnightMetadata = {
      version: METADATA_VERSION,
      providers: Object.fromEntries(providers),
      resolutionOrder: [...bound.keys()],
      aliases: Object.fromEntries(aliases),
    }
    const container = Container.create(metadata)
    for (const [token, value] of bound) container.provide(token, value)
    await container.init()
    return container
  }
}

/** Indices of `definition.deps` used only by interceptor chains. */
function interceptorIndices(definition: ProviderDefinition): Set<number> {
  const indices = new Set<number>()
  for (const interception of Object.values(definition.interceptors ?? {})) {
    for (const binding of interception.chain) indices.add(binding.dep)
  }
  return indices
}

function tokensOfRef(ref: DependencyRef): readonly Token[] {
  if (typeof ref === 'string') return [ref]
  if (ref === null || typeof ref !== 'object') return []
  if ('multi' in ref && Array.isArray(ref.multi)) return ref.multi
  if ('lazy' in ref && typeof ref.lazy === 'string') return [ref.lazy]
  if ('token' in ref && typeof ref.token === 'string') return [ref.token]
  return []
}

function qualifiedValueError(token: Token, name: string, path: readonly Token[]): ZnightError {
  const owner = displayName(path[path.length - 1] as Token)
  const key = displayName(token)
  return new ZnightError(
    ErrorCode.MissingProvider,
    `TestBed cannot auto-mock ${describeToken(token)}, the value named "${name}" injected into ${owner}: ` +
      'qualified values may be primitives, provide one',
    { hints: [`TestBed.create(${owner}, { metadata, provide: { ${JSON.stringify(key)}: value } })`] },
  )
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
