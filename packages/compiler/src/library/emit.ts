/**
 * Library mode (`library: true`, §6.4): emits `dist/znight.providers.json`, the compiled metadata of
 * a provider library. Every identity of the library's own declarations is translated to the public
 * export of its package (`src/jwt.service.ts#JwtService` → `@acme/auth#JwtService`), so that the
 * application compiler merges the fragment exactly like providers analysed from source.
 */
import type { AnalysisResult } from '../analyze.ts'
import type { ProviderNode } from '../graph/types.ts'
import type { Diagnostic, PackageInfo, Project, PublicExport, TypeInfo, ValueRef } from '../project/index.ts'
import type {
  EncodedValue,
  LibraryBinding,
  LibraryEdge,
  LibraryInjection,
  LibraryInterceptedMethod,
  LibraryProvider,
  ProvidersFile,
} from './schema.ts'

import { ErrorCode } from '@znight/core'

import { isBindingHandle } from '../extensions/contexts.ts'
import { compareStrings } from '../project/compare.ts'
import { declarationKey, relativePath, splitIdentity } from '../project/index.ts'
import { EncodeError, encodeValue, PROVIDERS_FILE, PROVIDERS_SCHEMA_VERSION } from './schema.ts'

/** The `znight.providers.json` file of a compiled provider library. */
export interface LibraryOutput {
  /** Absolute path (`<root>/dist/znight.providers.json`). */
  readonly file: string
  readonly content: string
  readonly data: ProvidersFile
}

/** Inputs of {@link emitLibrary}. */
export interface EmitLibraryInput {
  readonly project: Project
  readonly analysis: AnalysisResult
  readonly version: string
}

/** Result of {@link emitLibrary}. */
export interface EmitLibraryResult {
  readonly output: LibraryOutput | undefined
  readonly diagnostics: readonly Diagnostic[]
}

/** Path of the fragment of a library rooted at `root`. */
export function providersFileOf(root: string): string {
  return `${root}/dist/${PROVIDERS_FILE}`
}

/** Builds the compiled providers fragment of the project (a library). */
export function emitLibrary(input: EmitLibraryInput): EmitLibraryResult {
  const { project, analysis } = input
  const diagnostics: Diagnostic[] = []
  const rootPackage = project.rootPackage
  const rootName = rootPackage?.name
  if (rootPackage === undefined || rootName === undefined) {
    diagnostics.push({
      code: ErrorCode.VersionMismatch,
      severity: 'error',
      message: 'Library mode needs a package.json with a "name": providers are identified by package exports',
      hints: ['Add a "name" to the package.json of the library'],
    })
    return { output: undefined, diagnostics }
  }
  const root = { ...rootPackage, name: rootName }
  const translator = new IdentityTranslator(project, root)
  const error = (message: string, location: Diagnostic['location'], hints: readonly string[] = []): void => {
    diagnostics.push({
      code: ErrorCode.InvalidDecorator,
      severity: 'error',
      message,
      ...(location ? { location } : {}),
      ...(hints.length > 0 ? { hints } : {}),
    })
  }
  const publicIdentity = (identity: string, what: string, location: Diagnostic['location']): string => {
    const translated = translator.public(identity)
    if (translated === undefined) {
      error(
        `${what} is not exported by a public entry of ${root.name}: the providers of a compiled library and the values they reference must be part of its public API`,
        location,
        [`Export it from the package entry point (package.json "exports")`],
      )
      return identity
    }
    return translated
  }
  const hooks = {
    ref: (value: object): string | undefined => {
      const ref = value as ValueRef
      return ref.identity === undefined ? undefined : publicIdentity(ref.identity, `'${ref.text}'`, ref.location)
    },
    classInfo: (value: object): string | undefined => {
      const candidate = value as { identity?: unknown; declaration?: unknown; ctor?: unknown; methods?: unknown }
      if (typeof candidate.identity !== 'string' || !candidate.declaration || !candidate.ctor || !candidate.methods) {
        return undefined
      }
      return publicIdentity(candidate.identity, `Class ${splitIdentity(candidate.identity)?.name}`, undefined)
    },
    binding: (value: object): number | undefined => (isBindingHandle(value) ? value.id : undefined),
    location: (value: object): string | undefined => {
      const keys = Object.keys(value).sort(compareStrings).join(',')
      const file = (value as { file?: unknown }).file
      if (keys !== 'column,end,endColumn,endLine,file,line,start' || typeof file !== 'string') {
        return undefined
      }
      return relativePath(root.dir, file)
    },
  }
  const encode = (value: unknown, what: string, location: Diagnostic['location']): EncodedValue => {
    try {
      return encodeValue(value, hooks)
    } catch (caught) {
      if (!(caught instanceof EncodeError)) {
        throw caught
      }
      error(`${what} cannot be stored in a compiled provider library: ${caught.message}`, location)
      return null
    }
  }
  const type = (value: TypeInfo): EncodedValue => encodeValue(translator.type(value), hooks)
  const injection = (
    request: { readonly type: TypeInfo; readonly qualifier: string | undefined; readonly optional: boolean },
    label: string,
  ): LibraryInjection => ({
    type: type(request.type),
    ...(request.qualifier === undefined ? {} : { qualifier: request.qualifier }),
    ...(request.optional ? { optional: true as const } : {}),
    label,
  })

  const providers: LibraryProvider[] = []
  for (const provider of analysis.graph.providers) {
    if (provider.kind === 'custom') {
      error(
        `${provider.displayName} has a custom factory (registered by compiler extension '${provider.registeredBy}'): compiled provider libraries cannot contain custom factories`,
        provider.location,
        ['Publish the library from source instead: "znight": { "library": "source" } in its package.json'],
      )
      continue
    }
    const cls = publicIdentity(provider.classIdentity, `Class ${provider.displayName}`, provider.location)
    const token = provider.kind === 'provides' ? `${cls}.${provider.method ?? ''}` : cls
    providers.push({
      token,
      kind: provider.kind,
      class: cls,
      importRoute: routeOf(cls),
      ...(provider.method === undefined ? {} : { method: provider.method }),
      providedType: type(provider.providedType),
      heritage: provider.heritage.map(heritage => type(heritage)),
      scope: provider.scope,
      ...(provider.name === undefined ? {} : { name: provider.name }),
      ...(provider.primary ? { primary: true as const } : {}),
      ...(provider.async ? { async: true as const } : {}),
      ...(provider.dispose === undefined ? {} : { dispose: provider.dispose }),
      registeredBy: provider.registeredBy,
      lifecycle: [...new Set(provider.lifecycle.map(hook => hook.member))].sort(compareStrings),
      params: provider.deps.flatMap(dep =>
        dep.role === 'parameter' && dep.request ? [injection(dep.request, dep.label)] : [],
      ),
      interceptors: interceptorsOf(provider, translator, encode),
    })
  }

  const edges: LibraryEdge[] = analysis.graph.edges
    .filter(edge => edge.kind === 'extension')
    .map(edge => ({ from: translator.token(edge.from), to: translator.token(edge.to), reason: edge.label }))

  const bindings: LibraryBinding[] = [...analysis.graph.bindingRequests]
    .sort(([a], [b]) => a - b)
    .map(([id, entry]) => ({
      id,
      ...injection(entry.request, entry.label),
      ...(entry.from === undefined ? {} : { from: translator.token(entry.from) }),
    }))

  const extensions: Record<string, EncodedValue[]> = {}
  for (const entry of analysis.graph.extensions) {
    if (entry.stored.length > 0) {
      extensions[entry.name] = entry.stored.map(data =>
        encode(data, `Data stored by compiler extension '${entry.name}'`, undefined),
      )
    }
  }

  const data: ProvidersFile = {
    schemaVersion: PROVIDERS_SCHEMA_VERSION,
    package: root.name,
    compiler: input.version,
    providers: providers.sort((a, b) => compareStrings(a.token, b.token)),
    edges,
    bindings,
    extensions,
  }
  if (diagnostics.length > 0) {
    return { output: undefined, diagnostics }
  }
  return {
    output: { file: providersFileOf(project.root), content: `${JSON.stringify(data, null, 2)}\n`, data },
    diagnostics,
  }
}

function interceptorsOf(
  provider: ProviderNode,
  translator: IdentityTranslator,
  encode: (value: unknown, what: string, location: Diagnostic['location']) => EncodedValue,
): LibraryInterceptedMethod[] {
  return provider.interceptors.map(method => ({
    method: method.method,
    async: method.async,
    chain: method.chain.map(link => ({
      token: translator.token(link.token),
      decorator: translator.token(link.decorator),
      ...(link.hasOptions
        ? {
            options: encode(
              link.options,
              `The options of the interceptor of ${provider.displayName}.${method.method}`,
              link.location,
            ),
          }
        : {}),
    })),
  }))
}

/** Import route of a public package identity (`@acme/auth/testing#tokens.Fake`). */
function routeOf(identity: string): { specifier: string; exportName: string; members: string[] } {
  const separator = identity.lastIndexOf('#')
  const [exportName = 'default', ...members] = identity.slice(separator + 1).split('.')
  return { specifier: identity.slice(0, separator), exportName, members }
}

/** Translates identities of the library's own declarations to package identities. */
class IdentityTranslator {
  readonly #project: Project
  readonly #root: PackageInfo & { readonly name: string }
  readonly #index: ReadonlyMap<string, PublicExport>
  readonly #cache = new Map<string, string | undefined>()

  constructor(project: Project, root: PackageInfo & { readonly name: string }) {
    this.#project = project
    this.#root = root
    this.#index = project.identities.publicIndex(root)
  }

  /** Public package identity, `undefined` when the declaration is not publicly exported. */
  public(identity: string): string | undefined {
    if (this.#cache.has(identity)) {
      return this.#cache.get(identity)
    }
    const result = this.#translate(identity)
    this.#cache.set(identity, result)
    return result
  }

  /** Public identity when there is one, else the package-internal identity (never fails). */
  token(identity: string): string {
    const translated = this.public(identity)
    if (translated !== undefined) {
      return translated
    }
    const member = this.#member(identity)
    if (member) {
      return `${this.token(member.base)}.${member.name}`
    }
    const parts = splitIdentity(identity)
    if (!parts || !this.#isApplication(identity)) {
      return identity
    }
    return `${this.#root.name}/${parts.owner}#${parts.name}`
  }

  /** A type with every identity translated. */
  type(type: TypeInfo): TypeInfo {
    switch (type.kind) {
      case 'reference':
        return { ...type, identity: this.token(type.identity), typeArgs: type.typeArgs.map(arg => this.type(arg)) }
      case 'array':
        return { ...type, element: this.type(type.element) }
      case 'promise':
        return { ...type, inner: this.type(type.inner) }
      case 'union':
      case 'intersection':
        return { ...type, types: type.types.map(member => this.type(member)) }
      case 'tuple':
        return { ...type, elements: type.elements.map(element => ({ ...element, type: this.type(element.type) })) }
      default:
        return type
    }
  }

  #translate(identity: string): string | undefined {
    const symbol = this.#project.lookupIdentity(identity)
    if (symbol.kind !== 'declaration') {
      const member = this.#member(identity)
      if (member) {
        const base = this.public(member.base)
        return base === undefined ? undefined : `${base}.${member.name}`
      }
      return this.#isApplication(identity) ? undefined : identity
    }
    if (this.#project.ownerOf(symbol.declaration.file).kind !== 'application') {
      return identity
    }
    for (const declaration of symbol.declarations) {
      const found = this.#index.get(declarationKey(declaration))
      if (found) {
        return `${found.entry.specifier}#${found.path.join('.')}`
      }
    }
    return undefined
  }

  /** `src/a.ts#Factory.method` (a `@Provides` token) → base `src/a.ts#Factory`, name `method`. */
  #member(identity: string): { readonly base: string; readonly name: string } | undefined {
    const parts = splitIdentity(identity)
    const dot = parts?.name.lastIndexOf('.') ?? -1
    if (!parts || dot <= 0) {
      return undefined
    }
    const base = `${parts.owner}#${parts.name.slice(0, dot)}`
    return this.#project.lookupIdentity(base).kind === 'declaration'
      ? { base, name: parts.name.slice(dot + 1) }
      : undefined
  }

  #isApplication(identity: string): boolean {
    const parts = splitIdentity(identity)
    if (!parts || parts.owner === 'globalThis' || parts.owner.startsWith('@') || parts.owner.startsWith('node:')) {
      return false
    }
    return /\.[cm]?[jt]sx?$/.test(parts.owner)
  }
}
