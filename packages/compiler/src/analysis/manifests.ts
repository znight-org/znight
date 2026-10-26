/**
 * Package manifests (§7) as seen by the analysis: externals (`provides` + `options.externals`) and
 * interceptor decorators (`interceptors`).
 */
import type { Scope } from '@znight/core'
import type { InterceptorDeclaration, PackageInfo, PackageManifest, Project } from '../project/index.ts'

import { displayNameOf, packageNameOf, splitIdentity } from '../project/index.ts'

/** A token supplied at runtime. */
export interface ExternalInfo {
  readonly token: string
  readonly scope: Scope
  readonly providedBy: string | undefined
  readonly optional: boolean
  readonly origin: 'manifest' | 'option'
}

/** Lookups in the manifests of the packages the application uses (memoized for one compile). */
export class ManifestIndex {
  readonly #project: Project
  readonly #options: ReadonlyMap<string, ExternalInfo>
  readonly #externals = new Map<string, ExternalInfo | null>()
  readonly #manifests = new Map<string, PackageManifest | null>()

  constructor(project: Project) {
    this.#project = project
    const options = new Map<string, ExternalInfo>()
    for (const token of project.options.externals) {
      options.set(token, { token, scope: 'singleton', providedBy: undefined, optional: false, origin: 'option' })
    }
    this.#options = options
  }

  /**
   * External declared for an identity: `options.externals` first, then the `provides` of the
   * manifest of the package declaring the identity.
   */
  external(identity: string): ExternalInfo | undefined {
    const fromOptions = this.#options.get(identity)
    if (fromOptions) {
      return fromOptions
    }
    let cached = this.#externals.get(identity)
    if (cached === undefined) {
      const provided = this.manifestOfIdentity(identity)?.provides.find(entry => entry.identity === identity)
      cached = provided
        ? {
            token: provided.identity,
            scope: provided.scope,
            providedBy: provided.plugin,
            optional: provided.optional,
            origin: 'manifest',
          }
        : null
      this.#externals.set(identity, cached)
    }
    return cached ?? undefined
  }

  /** The interceptor declared for a decorator identity by the manifest of the package declaring it. */
  interceptorOf(decoratorIdentity: string, declaringFile: string | undefined): InterceptorDeclaration | undefined {
    const manifest =
      declaringFile === undefined ? this.manifestOfIdentity(decoratorIdentity) : this.manifestOfFile(declaringFile)
    return manifest?.interceptors.find(entry => entry.decoratorIdentity === decoratorIdentity)
  }

  /** Manifest of the package owning a file (`undefined` for application files). */
  manifestOfFile(file: string): PackageManifest | undefined {
    const owner = this.#project.ownerOf(file)
    return owner.kind === 'package' ? this.#manifestOf(owner.package) : undefined
  }

  /** Manifest of the package an identity belongs to (`undefined` for application identities). */
  manifestOfIdentity(identity: string): PackageManifest | undefined {
    const parts = splitIdentity(identity)
    if (!parts || parts.owner === 'globalThis') {
      return undefined
    }
    const symbol = this.#project.lookupIdentity(identity)
    if (symbol.kind === 'declaration') {
      return this.manifestOfFile(symbol.declaration.file)
    }
    if (symbol.kind === 'external' && !symbol.specifier.startsWith('node:')) {
      const info = this.#project.packages.findInstalled(packageNameOf(symbol.specifier), this.#project.root)
      return info ? this.#manifestOf(info) : undefined
    }
    return undefined
  }

  /** Display name of a token (`Logger`). */
  displayName(token: string): string {
    return displayNameOf(token)
  }

  #manifestOf(info: PackageInfo): PackageManifest | undefined {
    let cached = this.#manifests.get(info.dir)
    if (cached === undefined) {
      cached = this.#project.manifestOf(info) ?? null
      this.#manifests.set(info.dir, cached)
    }
    return cached ?? undefined
  }
}
