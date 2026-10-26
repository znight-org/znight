/**
 * The binding algorithm (§4.7, normative).
 *
 * For an injection point with type `T`, qualifier `q` and the optional / multi / lazy flags:
 *
 * 1. `C = exact(T) ∪ assignable(T)`: providers whose provided type is `T`, and providers whose
 *    heritage closure contains `T` (types compared by canonical serialization);
 * 2. with a qualifier, `C = C ∩ named(q)`;
 * 3. multi (`T[]`): every candidate, ordered by token — never fails;
 * 4. single: the unique exact candidate, else the unique `@Primary`, else the unique candidate;
 *    several candidates all providing the exact same type → ZNIGHT004, otherwise ZNIGHT008;
 * 5. no candidate: a type declared in a manifest `provides` (or `options.externals`) is an
 *    external; an optional point binds `{ token, optional: true }` (`undefined` is injected, see
 *    `Binder#unboundToken`); otherwise ZNIGHT001 with the near-miss analysis;
 * 6. primitive/opaque types require a qualifier and are matched by `(qualifier, kind)`; a qualifier
 *    match of another kind is ZNIGHT010;
 * 7. `Lazy<T>` binds `T` with the same rules and emits `{ lazy: token }`.
 */
import type { DependencyRef, Token } from '@znight/core'
import type { Reporter } from '../analysis/arguments.ts'
import type { ExternalInfo, ManifestIndex } from '../analysis/manifests.ts'
import type { ProviderDraft, ProviderRegistry } from '../analysis/registry.ts'
import type { EdgeKind } from '../graph/types.ts'
import type { Location, Project, ReferenceType, TypeInfo } from '../project/index.ts'
import type { InjectionSpec, NormalizedInjection } from './injection.ts'
import type { NearMissAnalyzer } from './near-miss.ts'

import { ErrorCode } from '@znight/core'

import { compareStrings } from '../project/compare.ts'
import { formatType, serializeType } from '../project/index.ts'
import { describeProviders } from './display.ts'
import { kindsCompatible, normalizeInjection, valueKind } from './injection.ts'

/** An injection point to bind. */
export interface BindSite {
  /** Display name of the dependent provider (`UserService`), for "required by". */
  readonly owner: string
  /** `parameter 'repo' of UserService`. */
  readonly label: string
  /** Capitalized label, first words of ZNIGHT010 messages. */
  readonly subject: string
  readonly location: Location | undefined
  readonly spec: InjectionSpec
  readonly rest: boolean
}

/** A provider or external a binding points to (graph edge target). */
export interface BindTarget {
  readonly token: Token
  readonly kind: EdgeKind
  readonly external: ExternalInfo | undefined
}

/** A successful binding. */
export interface BindOutcome {
  readonly ref: DependencyRef
  readonly targets: readonly BindTarget[]
  /** The bound type (after unwrapping). */
  readonly type: TypeInfo
}

/** Binds injection points against the registered providers. */
export class Binder {
  readonly #project: Project
  readonly #manifests: ManifestIndex
  readonly #nearMiss: NearMissAnalyzer
  readonly #report: Reporter
  readonly #exact = new Map<string, ProviderDraft[]>()
  readonly #assignable = new Map<string, ProviderDraft[]>()
  readonly #named = new Map<string, ProviderDraft[]>()
  readonly #externals = new Map<Token, ExternalInfo>()

  constructor(
    project: Project,
    registry: ProviderRegistry,
    manifests: ManifestIndex,
    nearMiss: NearMissAnalyzer,
    report: Reporter,
  ) {
    this.#project = project
    this.#manifests = manifests
    this.#nearMiss = nearMiss
    this.#report = report
    for (const draft of registry.all()) {
      push(this.#exact, draft.exactKey, draft)
      for (const heritage of draft.heritage) {
        const key = serializeType(heritage)
        if (key !== draft.exactKey) {
          push(this.#assignable, key, draft)
        }
      }
      if (draft.name !== undefined) {
        push(this.#named, draft.name, draft)
      }
    }
  }

  /** Externals referenced by at least one binding, sorted by token. */
  usedExternals(): ExternalInfo[] {
    return [...this.#externals.values()].sort((a, b) => compareStrings(a.token, b.token))
  }

  /** Binds an injection point; `undefined` when it fails (the diagnostic is reported). */
  bind(site: BindSite): BindOutcome | undefined {
    if (site.rest) {
      this.#problem(site, `${site.subject} is a rest parameter: rest parameters cannot be injected`, [
        'Inject an array type (`items: Item[]`) to receive every provider of a type',
      ])
      return undefined
    }
    const normalized = normalizeInjection(site.spec, site.subject)
    if (!normalized.ok) {
      this.#problem(site, normalized.message, normalized.hints)
      return undefined
    }
    const injection = normalized.injection
    return injection.valueLike ? this.#bindValue(site, injection) : this.#bindReference(site, injection)
  }

  #bindReference(site: BindSite, injection: NormalizedInjection): BindOutcome | undefined {
    const type = injection.type as ReferenceType
    const key = serializeType(type)
    const exact = this.#exact.get(key) ?? []
    const unqualified = unique([...exact, ...(this.#assignable.get(key) ?? [])])
    const qualifier = injection.qualifier
    const candidates = qualifier === undefined ? unqualified : unqualified.filter(draft => draft.name === qualifier)

    if (injection.multi) {
      const tokens = candidates.map(draft => draft.token)
      return {
        ref: { multi: tokens },
        targets: tokens.map(token => ({ token, kind: 'multi', external: undefined })),
        type,
      }
    }
    if (candidates.length === 0) {
      const external = qualifier === undefined ? this.#manifests.external(type.identity) : undefined
      if (external) {
        this.#externals.set(external.token, external)
        const kind: EdgeKind = injection.lazy ? 'lazy' : 'dependency'
        return {
          ref: this.#ref(external.token, injection, external),
          targets: [{ token: external.token, kind, external }],
          type,
        }
      }
      if (injection.optional) {
        return { ref: { token: this.#unboundToken(type, qualifier), optional: true }, targets: [], type }
      }
      const nearMiss = this.#nearMiss.analyze({ type, qualifier, unqualified })
      const qualified = qualifier === undefined ? '' : ` (qualifier '${qualifier}')`
      this.#report({
        code: ErrorCode.MissingProvider,
        severity: 'error',
        message: `Missing provider for '${formatType(type)}'${qualified} required by ${site.owner}`,
        ...this.#location(site),
        hints: nearMiss.hints,
        ...(nearMiss.related.length > 0 ? { related: nearMiss.related } : {}),
      })
      return undefined
    }
    const selected = this.#select(site, injection.type, candidates, key)
    if (!selected) {
      return undefined
    }
    return {
      ref: this.#ref(selected.token, injection, undefined),
      targets: [{ token: selected.token, kind: edgeKind(injection), external: undefined }],
      type,
    }
  }

  #bindValue(site: BindSite, injection: NormalizedInjection): BindOutcome | undefined {
    const qualifier = injection.qualifier as string
    const named = this.#named.get(qualifier) ?? []
    const requested = valueKind(injection.type)
    const candidates = named.filter(draft => kindsCompatible(valueKind(draft.providedType), requested))
    if (named.length > 0 && candidates.length === 0) {
      this.#problem(
        site,
        `${site.subject}: the qualifier '${qualifier}' matches ${describeProviders(this.#project, named)}, which provide${named.length === 1 ? 's' : ''} ${named.map(draft => `'${formatType(draft.providedType)}'`).join(', ')} instead of '${formatType(injection.type)}'`,
        ['Fix the parameter type or the qualifier'],
      )
      return undefined
    }
    if (candidates.length === 0) {
      if (injection.optional) {
        return { ref: { token: qualifier, optional: true }, targets: [], type: injection.type }
      }
      this.#report({
        code: ErrorCode.MissingProvider,
        severity: 'error',
        message: `Missing provider for '${qualifier}' (${formatType(injection.type)}) required by ${site.owner}`,
        ...this.#location(site),
        hints: [
          `Provide it from a @Factory class: \`@Provides({ name: '${qualifier}' }) ${safeName(qualifier)}(): ${formatType(injection.type)}\``,
        ],
      })
      return undefined
    }
    const selected = this.#select(site, injection.type, candidates, undefined)
    if (!selected) {
      return undefined
    }
    return {
      ref: this.#ref(selected.token, injection, undefined),
      targets: [{ token: selected.token, kind: edgeKind(injection), external: undefined }],
      type: injection.type,
    }
  }

  /** Step 4 of §4.7. `exactKey` is `undefined` for value types (no exact/assignable distinction). */
  #select(
    site: BindSite,
    type: TypeInfo,
    candidates: readonly ProviderDraft[],
    exactKey: string | undefined,
  ): ProviderDraft | undefined {
    if (exactKey !== undefined) {
      const exact = candidates.filter(draft => draft.exactKey === exactKey)
      if (exact.length === 1) {
        return exact[0]
      }
    }
    const primaries = candidates.filter(draft => draft.primary)
    if (primaries.length === 1) {
      return primaries[0]
    }
    if (candidates.length === 1) {
      return candidates[0]
    }
    const listed = primaries.length > 1 ? primaries : candidates
    const sameType = new Set(listed.map(draft => draft.exactKey)).size === 1
    const severalPrimaries = primaries.length > 1 ? ', several of them @Primary' : ''
    const hints =
      primaries.length > 1
        ? [`Keep a single @Primary() among ${listed.map(draft => draft.displayName).join(', ')}`]
        : ['Mark the provider to inject by default with @Primary()']
    hints.push("Or name the providers with @Named('...') and choose one with @Inject('...')")
    if (!sameType) {
      hints.push('Or inject a more specific type')
    }
    this.#report({
      code: sameType ? ErrorCode.DuplicateProvider : ErrorCode.AmbiguousInjection,
      severity: 'error',
      message: sameType
        ? `Duplicate providers for '${formatType(type)}' required by ${site.owner}: ${describeProviders(this.#project, listed)}${severalPrimaries}`
        : `Ambiguous injection of '${formatType(type)}' required by ${site.owner}: ${listed.length} candidates (${describeProviders(this.#project, listed)})${severalPrimaries}`,
      ...this.#location(site),
      hints,
      related: listed.map(draft => ({ message: `candidate ${draft.displayName}`, location: draft.location })),
    })
    return undefined
  }

  /**
   * Token of an optional reference injection bound to nothing (§4.7 steps 5 and 7): the runtime
   * injects `undefined` unless something is registered under it. It must never be a provider token
   * or an alias key, which the runtime would resolve to a provider that does not match the request:
   *
   * - the type identity for an unqualified injection of a public, non-generic type (an alias of
   *   that identity would be a candidate; a plugin may register a value under it);
   * - the qualifier for a qualified injection (like a qualified value type);
   * - otherwise (type arguments, package-internal type) the display of the type (`Repository<User>`):
   *   independent of the package layout, so sources and `dist` give the same output.
   */
  #unboundToken(type: ReferenceType, qualifier: string | undefined): Token {
    if (qualifier !== undefined) {
      return qualifier
    }
    if (type.typeArgs.length === 0 && this.#project.identities.isPublic(type.identity)) {
      return type.identity
    }
    return formatType(type)
  }

  #ref(token: Token, injection: NormalizedInjection, external: ExternalInfo | undefined): DependencyRef {
    if (injection.lazy) {
      return { lazy: token }
    }
    if (external && (injection.optional || external.optional)) {
      return { token, optional: true }
    }
    return token
  }

  #problem(site: BindSite, message: string, hints: readonly string[]): void {
    this.#report({ code: ErrorCode.UnresolvableType, severity: 'error', message, ...this.#location(site), hints })
  }

  #location(site: BindSite): { location?: Location } {
    return site.location ? { location: site.location } : {}
  }
}

function edgeKind(injection: NormalizedInjection): EdgeKind {
  if (injection.lazy) {
    return 'lazy'
  }
  return injection.optional ? 'optional' : 'dependency'
}

function push(map: Map<string, ProviderDraft[]>, key: string, draft: ProviderDraft): void {
  const list = map.get(key)
  if (list) {
    list.push(draft)
  } else {
    map.set(key, [draft])
  }
}

function unique(drafts: readonly ProviderDraft[]): ProviderDraft[] {
  const byToken = new Map<Token, ProviderDraft>()
  for (const draft of drafts) {
    byToken.set(draft.token, draft)
  }
  return [...byToken.values()].sort((a, b) => compareStrings(a.token, b.token))
}

function safeName(name: string): string {
  const cleaned = name.replace(/[^\w$]/g, '_')
  return /^[A-Za-z_$]/.test(cleaned) ? cleaned : `_${cleaned}`
}
