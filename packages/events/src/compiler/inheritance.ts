/**
 * Listeners of an abstract class (RFC 0011 §5.4) run on the concrete class providers that inherit
 * the method. Inheritance follows the `extends` chain only, like the prototype chain the runtime
 * walks (`implements` copies no method), and the most-derived declaration of a method wins: a class
 * between the provider and the abstract host that declares a member with the same name replaces the
 * inherited listener (with its own `@OnEvent`, or with none).
 *
 * `validate` computes the providers of each such listener on the bound graph ({@link inheritorsOf});
 * `generate`, which has no class analysis, reads them back ({@link recordedInheritors}).
 */
import type { ClassInfo, ProviderNode } from '@znight/compiler'
import type { ListenerData } from './data.ts'

/** Class analysis by identity (`ctx.classInfo`). */
export type ClassLookup = (identity: string) => ClassInfo | undefined

/** A concrete class provider inheriting a listener of an abstract class. */
export interface Inheritor {
  readonly token: string
  /** Identity of the provider class: the type of the instance in the generated `invoke`. */
  readonly classIdentity: string
}

/** `cls`, then its base classes through `extends` (a cycle or a base that cannot be analysed ends it). */
export function extendsChain(cls: ClassInfo, classInfo: ClassLookup): ClassInfo[] {
  const chain: ClassInfo[] = []
  const seen = new Set<string>()
  let current: ClassInfo | undefined = cls
  while (current !== undefined && !seen.has(current.identity)) {
    seen.add(current.identity)
    chain.push(current)
    const base: string | undefined = current.superClass?.identity
    current = base === undefined ? undefined : classInfo(base)
  }
  return chain
}

/** `true` when `cls` extends, directly or not, the class `identity`. */
export function extendsClass(cls: ClassInfo, identity: string, classInfo: ClassLookup): boolean {
  return extendsChain(cls, classInfo).some((ancestor, index) => index > 0 && ancestor.identity === identity)
}

/**
 * `true` when `cls` inherits `method` from the class `host`: `host` is on its `extends` chain and no
 * class before it (`cls` included) declares an instance member named `method`.
 */
export function inheritsMethod(cls: ClassInfo, host: string, method: string, classInfo: ClassLookup): boolean {
  if (cls.identity === host) return false
  for (const ancestor of extendsChain(cls, classInfo)) {
    if (ancestor.identity === host) return true
    if (declares(ancestor, method)) return false
  }
  return false
}

/** An instance member named `method` declared by the class itself: it shadows the inherited one. */
function declares(cls: ClassInfo, method: string): boolean {
  const named = (member: { readonly static: boolean; readonly privateName: boolean; readonly name: string }) =>
    !member.static && !member.privateName && member.name === method
  return cls.methods.some(named) || cls.properties.some(member => !member.declare && named(member))
}

/** The concrete class providers of the bound graph, with their class analysis. */
export interface ProviderClasses {
  readonly list: readonly { readonly provider: ProviderNode; readonly cls: ClassInfo }[]
  readonly classInfo: ClassLookup
}

/** Concrete class providers whose class can be analysed. */
export function providerClasses(ctx: {
  readonly graph: { readonly providers: readonly ProviderNode[] }
  classInfo(identity: string): ClassInfo | undefined
}): ProviderClasses {
  const list: { provider: ProviderNode; cls: ClassInfo }[] = []
  for (const provider of ctx.graph.providers) {
    if (provider.kind !== 'class') continue
    const cls = ctx.classInfo(provider.classIdentity)
    if (cls !== undefined && !cls.abstract) list.push({ provider, cls })
  }
  return { list, classInfo: identity => ctx.classInfo(identity) }
}

/** `true` when a provider extends the class `host` (whether or not it overrides its listeners). */
export function isExtended(host: ClassInfo, providers: ProviderClasses): boolean {
  return providers.list.some(({ cls }) => extendsClass(cls, host.identity, providers.classInfo))
}

const RECORDED = new WeakMap<ListenerData, readonly Inheritor[]>()

/**
 * The providers running a listener of the abstract class `listener.host`: those inheriting its
 * method. Recorded for `generate` ({@link recordedInheritors}).
 */
export function inheritorsOf(listener: ListenerData, providers: ProviderClasses): readonly Inheritor[] {
  let found = RECORDED.get(listener)
  if (found === undefined) {
    found = providers.list
      .filter(({ cls }) => inheritsMethod(cls, listener.host.identity, listener.method, providers.classInfo))
      .map(({ provider }) => ({ token: provider.token, classIdentity: provider.classIdentity }))
    RECORDED.set(listener, found)
  }
  return found
}

/**
 * The inheritors `validate` computed for a listener of an abstract class. The compiler always runs
 * `validate` before `generate`, on the same stored data.
 */
export function recordedInheritors(listener: ListenerData): readonly Inheritor[] {
  return RECORDED.get(listener) ?? []
}
