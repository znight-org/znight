/**
 * Provider registry: the providers found by the core analysis, the extensions and the
 * auto-registration of helper classes, before binding.
 */
import type { Scope, Token } from '@znight/core'
import type { InjectionSpec } from '../binding/injection.ts'
import type { ClassInfo, CustomFactory, DecoratorInfo, LifecycleHookInfo, MethodInfo } from '../extensions/api.ts'
import type { ProviderKind } from '../graph/types.ts'
import type { Location, ReferenceType, StaticValue, TypeInfo } from '../project/index.ts'

import { compareStrings } from '../project/compare.ts'

/** A parameter (or custom factory dependency) to bind. */
export interface ParameterSite {
  readonly spec: InjectionSpec
  /** `parameter 'repo' of UserService`. */
  readonly label: string
  /** `parameter 'repo'` (first words of ZNIGHT010 messages). */
  readonly subject: string
  readonly location: Location | undefined
  /** Rest parameters cannot be injected (ZNIGHT010). */
  readonly rest: boolean
}

/** One interceptor of a method chain, before binding. */
export interface InterceptorLinkDraft {
  readonly token: Token
  readonly hasOptions: boolean
  readonly options: StaticValue
  /** The decorator (only identity, name and location are used: compiled libraries have no AST). */
  readonly decorator: Pick<DecoratorInfo, 'identity' | 'name' | 'location'>
}

/** Interceptor chain of one method, before binding. */
export interface InterceptedMethodDraft {
  /** The method (only name and async are used: compiled libraries have no AST). */
  readonly method: Pick<MethodInfo, 'name' | 'async'>
  readonly chain: readonly InterceptorLinkDraft[]
}

/** A provider before binding. */
export interface ProviderDraft {
  readonly token: Token
  readonly displayName: string
  readonly kind: ProviderKind
  /** `'core'`, `'auto'` or an extension name. */
  readonly registeredBy: string
  /** Provider class (`class`/`custom`) or `@Factory` class (`provides`). */
  readonly cls: ClassInfo
  /** `provides` providers: the method (only its name is used after the analysis). */
  readonly method: Pick<MethodInfo, 'name'> | undefined
  readonly providedType: TypeInfo
  /** Serialization of {@link providedType} (exact candidates of §4.7). */
  readonly exactKey: string
  readonly heritage: readonly ReferenceType[]
  readonly scope: Scope
  readonly name: string | undefined
  readonly primary: boolean
  readonly async: boolean
  readonly dispose: string | undefined
  /** Class name / method name. */
  readonly location: Location
  /** The decorator (or call) that registered the provider. */
  readonly registration: Location
  /** What registered it in messages (`@Injectable`, `@Controller`, `@UseGuard reference`). */
  readonly registeredWith: string
  readonly params: readonly ParameterSite[]
  readonly custom: CustomFactory | undefined
  readonly interceptors: readonly InterceptedMethodDraft[]
  readonly lifecycle: readonly LifecycleHookInfo[]
  /** `provides` providers: token of the `@Factory` class. */
  readonly factoryToken: Token | undefined
  /** Parameters are not bound (the provider itself is invalid: unbound generic...). */
  readonly skipBinding: boolean
}

/** Providers by token. */
export class ProviderRegistry {
  readonly #drafts = new Map<Token, ProviderDraft>()

  add(draft: ProviderDraft): void {
    this.#drafts.set(draft.token, draft)
  }

  get(token: Token): ProviderDraft | undefined {
    return this.#drafts.get(token)
  }

  has(token: Token): boolean {
    return this.#drafts.has(token)
  }

  get size(): number {
    return this.#drafts.size
  }

  /** Every provider, sorted by token. */
  all(): ProviderDraft[] {
    return [...this.#drafts.values()].sort((a, b) => compareStrings(a.token, b.token))
  }
}
