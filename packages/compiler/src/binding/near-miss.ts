/**
 * ZNIGHT001 near-miss analysis (§4.7): when no provider matches an injection point, look for the
 * usual mistakes and turn them into hints:
 *
 * 1. a class or interface with the same name but another identity (two declarations, wrong import,
 *    missing import resolving to a global);
 * 2. an undecorated class of the requested type (unless it is already provided: the qualifier or the
 *    type arguments are the problem; abstract and generic classes get a "concrete subclass" hint), or
 *    undecorated classes implementing it;
 * 3. the declaration of the type is excluded by `include`/`exclude` (or lives in a package that is
 *    not analysed from source);
 * 4. a provider whose name matches but without `implements`, or implementing the type with other
 *    type arguments;
 * 5. providers removed by the qualifier.
 */
import type { ClassAnalyzer } from '../analysis/class-analyzer.ts'
import type { ProviderDraft, ProviderRegistry } from '../analysis/registry.ts'
import type { Declaration, Location, Project, ReferenceType, RelatedInformation } from '../project/index.ts'

import { compareStrings } from '../project/compare.ts'
import { formatType, GLOBAL_IDENTITY_PREFIX, relativePath, serializeType } from '../project/index.ts'
import { declarationLocation, describeProvider, describeProviders, position } from './display.ts'

const MAX_LISTED = 5

/** Input of {@link NearMissAnalyzer.analyze}. */
export interface NearMissInput {
  readonly type: ReferenceType
  readonly qualifier: string | undefined
  /** Candidates before the qualifier filter (step 2 of §4.7). */
  readonly unqualified: readonly ProviderDraft[]
}

/** Hints and related locations of a ZNIGHT001. */
export interface NearMissResult {
  readonly hints: readonly string[]
  readonly related: readonly RelatedInformation[]
}

interface IndexedDeclaration {
  readonly identity: string
  readonly declaration: Declaration
  readonly location: Location
}

/** Near-miss analysis, with lazily built indexes (only paid when a ZNIGHT001 is reported). */
export class NearMissAnalyzer {
  readonly #project: Project
  readonly #analyzer: ClassAnalyzer
  readonly #registry: ProviderRegistry
  #byName: Map<string, IndexedDeclaration[]> | undefined

  constructor(project: Project, analyzer: ClassAnalyzer, registry: ProviderRegistry) {
    this.#project = project
    this.#analyzer = analyzer
    this.#registry = registry
  }

  analyze(input: NearMissInput): NearMissResult {
    const { type, qualifier, unqualified } = input
    const hints: string[] = []
    const related: RelatedInformation[] = []
    const project = this.#project

    // 5. candidates removed by the qualifier
    if (qualifier !== undefined && unqualified.length > 0) {
      hints.push(
        `${unqualified.length} provider${unqualified.length === 1 ? '' : 's'} of ${formatType(type)} exist${unqualified.length === 1 ? 's' : ''} but none is named '${qualifier}': ${describeProviders(project, unqualified.slice(0, MAX_LISTED))}`,
      )
    }

    // 1. same name, different identity
    const declared = declarationLocation(project, type.identity)
    const sameName = this.#index()
      .get(type.name)
      ?.filter(entry => entry.identity !== type.identity)
    if (sameName && sameName.length > 0) {
      for (const entry of sameName.slice(0, MAX_LISTED)) {
        const provider = this.#registry.has(entry.identity) ? ' (a provider)' : ''
        if (type.identity.startsWith(GLOBAL_IDENTITY_PREFIX)) {
          hints.push(
            `'${type.name}' is not imported where it is injected (it resolves to a global); ${type.name}${provider} is declared in ${position(project, entry.location)}: import it`,
          )
        } else {
          hints.push(
            `Another '${type.name}'${provider} is declared in ${position(project, entry.location)}, but this injection refers to the one in ${declared ? position(project, declared) : type.identity}: check the import`,
          )
        }
        related.push({ message: `'${type.name}' declared here`, location: entry.location })
      }
    }

    const symbol = project.lookupIdentity(type.identity)
    const declaration = symbol.kind === 'declaration' ? symbol.declaration : undefined

    // 3. excluded or not analysed
    if (declaration && !project.isScanned(declaration.file)) {
      const owner = project.ownerOf(declaration.file)
      if (owner.kind === 'application') {
        hints.push(
          `${type.name} is declared in ${relativePath(project.root, declaration.file)}, which is not analysed: the file is excluded by the "include"/"exclude" options`,
        )
      } else if (declaration.kind === 'class') {
        hints.push(
          `${type.name} is declared in the package ${owner.package.publicName ?? owner.package.dir}, which is not analysed from source: provide it with a @Factory/@Provides method, add the package to the "libraries" option, or declare '${type.identity}' in "externals" if a plugin provides it at runtime`,
        )
      }
    }

    // 2. undecorated class of the type, undecorated implementations
    const key = serializeType(type)
    if (declaration?.kind === 'class' && project.isScanned(declaration.file) && !this.#isProvided(type, key)) {
      const location = declarationLocation(project, type.identity)
      const where = `${type.name}${location ? ` (${position(project, location)})` : ''}`
      const info = this.#analyzer.infoOf(declaration)
      if (info.abstract || info.typeParameters.length > 0) {
        // `@Injectable()` on an abstract or generic class is itself an error (ZNIGHT005)
        hints.push(
          `${where} is ${info.abstract ? 'abstract' : 'generic'}: it cannot be a provider itself; decorate a concrete subclass of ${formatType(type)} with @Injectable(), or provide ${formatType(type)} with a @Provides method`,
        )
      } else {
        hints.push(`${where} is not a provider: add @Injectable()`)
      }
    }
    const implementations: IndexedDeclaration[] = []
    for (const entries of this.#index().values()) {
      for (const entry of entries) {
        if (entry.declaration.kind !== 'class' || this.#registry.has(entry.identity)) {
          continue
        }
        if (this.#analyzer.heritageOf(entry.declaration).some(heritage => serializeType(heritage) === key)) {
          implementations.push(entry)
        }
      }
    }
    implementations.sort((a, b) => compareStrings(a.identity, b.identity))
    for (const entry of implementations.slice(0, MAX_LISTED)) {
      hints.push(
        `${entry.declaration.name} (${position(project, entry.location)}) implements ${formatType(type)} but is not a provider: add @Injectable()`,
      )
    }

    // 4. matching name without `implements`, or other type arguments
    const names = [type.name.toLowerCase()]
    if (/^I[A-Z]/.test(type.name)) {
      names.push(type.name.slice(1).toLowerCase())
    }
    for (const draft of this.#registry.all()) {
      if (draft.kind === 'provides' && draft.providedType.kind !== 'reference') {
        continue
      }
      const sameIdentity = draft.heritage.find(heritage => heritage.identity === type.identity)
      if (sameIdentity && serializeType(sameIdentity) !== key) {
        hints.push(
          `${describeProvider(project, draft)} implements ${formatType(sameIdentity)}, not ${formatType(type)}`,
        )
        continue
      }
      const lowered = draft.displayName.toLowerCase()
      if (
        !sameIdentity &&
        draft.token !== type.identity &&
        draft.displayName !== type.name &&
        names.some(name => lowered.includes(name)) &&
        draft.exactKey !== key
      ) {
        hints.push(
          `${describeProvider(project, draft)} looks like an implementation of ${type.name} but does not declare \`implements ${type.name}\``,
        )
      }
    }

    if (hints.length === 0) {
      hints.push(...this.#fallback(type, declaration))
    }
    return { hints: hints.slice(0, MAX_LISTED * 2), related: related.slice(0, MAX_LISTED) }
  }

  /**
   * `true` when the class itself is a provider, or a provider supplies exactly this type (`@Provides`):
   * the miss comes from the qualifier or the type arguments, not from a missing decorator.
   */
  #isProvided(type: ReferenceType, key: string): boolean {
    return this.#registry.has(type.identity) || this.#registry.all().some(draft => draft.exactKey === key)
  }

  #fallback(type: ReferenceType, declaration: Declaration | undefined): string[] {
    if (declaration?.kind === 'interface' || declaration?.kind === 'type') {
      return [`Implement ${type.name} with a class decorated with @Injectable()`]
    }
    if (type.identity.startsWith(GLOBAL_IDENTITY_PREFIX)) {
      return [`'${type.name}' is not declared or imported: import the type of the dependency`]
    }
    return [
      `Provide it with a @Factory class: \`@Provides() create${type.name.replace(/\W/g, '')}(): ${type.name}\``,
      `If a plugin provides it at runtime, add '${type.identity}' to the "externals" option`,
    ]
  }

  /** Classes and interfaces of the scanned files, by local name. */
  #index(): Map<string, IndexedDeclaration[]> {
    if (this.#byName) {
      return this.#byName
    }
    const index = new Map<string, IndexedDeclaration[]>()
    for (const file of this.#project.files()) {
      for (const [name, declarations] of file.facts.declarations) {
        const declaration =
          declarations.find(candidate => candidate.kind === 'class') ??
          declarations.find(candidate => candidate.kind === 'interface')
        if (!declaration) {
          continue
        }
        const identity = this.#project.identityOf(declaration)?.identity
        if (identity === undefined) {
          continue
        }
        const entry = { identity, declaration, location: file.location(declaration.span) }
        const list = index.get(name)
        if (list) {
          list.push(entry)
        } else {
          index.set(name, [entry])
        }
      }
    }
    this.#byName = index
    return index
  }
}
