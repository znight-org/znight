/**
 * Internal model of the container: one {@link Slot} per canonical token. Not part of the public API.
 */
import type { ExternalDefinition, ProviderDefinition, SourceLocation, Token } from './metadata.ts'

import { displayName } from './tokens.ts'

// Binding modes
export const UNBOUND = 0
export const VALUE = 1
export const SINGLETON = 2
export const REQUEST = 3
export const TRANSIENT = 4

// Singleton states (values are always READY)
export const IDLE = 0
export const CREATING = 1
export const PENDING = 2
export const READY = 3
export const FAILED = 4
export const DISPOSED = 5

/**
 * Precedence levels of a binding (higher wins):
 * `override` > plugin `register`/`registerValue` > `Application.create({ providers })` > built-in > compiled.
 */
export const LEVEL_UNBOUND = -1
export const LEVEL_COMPILED = 0
export const LEVEL_BUILTIN = 1
export const LEVEL_APPLICATION = 2
export const LEVEL_PLUGIN = 3
export const LEVEL_OVERRIDE = 4

// Dependency kinds
export const DEP_REQUIRED = 0
export const DEP_OPTIONAL = 1
export const DEP_MULTI = 2
export const DEP_LAZY = 3

/** A resolved {@link import('./metadata.ts').DependencyRef}. */
export interface DepPlan {
  readonly kind: number
  /** Target (required, optional, lazy). */
  readonly slot: Slot | undefined
  /** Targets (multi). */
  readonly slots: readonly Slot[] | undefined
}

export class Slot {
  readonly token: Token
  readonly displayName: string
  /** Precedence level of the current binding. */
  level: number = LEVEL_UNBOUND
  mode: number = UNBOUND
  definition: ProviderDefinition | undefined = undefined
  /**
   * Class the token designates (class of its first provider definition, or of a built-in), kept when
   * a value replaces the binding: matches class keys looked up by name (see `Container#findByName`).
   */
  cls: object | undefined = undefined
  /** `true` when the token is a provider of the compiled metadata (even if replaced since). */
  compiled = false
  /** Source location of the compiled provider, when the metadata includes it. */
  compiledSource: SourceLocation | undefined = undefined
  external: ExternalDefinition | undefined = undefined
  /** Who bound the slot (for messages): `plugin "http"`, `Application providers`, `override`... */
  origin: string | undefined = undefined
  state: number = IDLE
  instance: unknown = undefined
  promise: Promise<void> | undefined = undefined
  /** Resolved dependencies, in definition order. */
  plan: readonly DepPlan[] | undefined = undefined
  /** Hard dependency edges (required, optional, multi; not lazy). */
  edges: readonly Slot[] = []
  /** Lazy dependency targets. */
  lazyEdges: readonly Slot[] = []
  /** Singletons that must be ready before this provider can be created (through transients). */
  waits: readonly Slot[] = []
  /** Position in the merged resolution order (-1 when not ordered). */
  order = -1
  /** DFS color during ordering (0 white, 1 gray, 2 black). */
  mark = 0
  /** Whether resolving this slot requires an active request scope. */
  needsScope = false

  constructor(token: Token) {
    this.token = token
    this.displayName = displayName(token)
  }

  /** Whether the slot has a definition the container instantiates. */
  get isProvider(): boolean {
    return this.mode >= SINGLETON
  }

  /** Whether an unbound slot can still be resolved (request external read from the scope, or optional external). */
  get isSatisfiedExternally(): boolean {
    const external = this.external
    return external !== undefined && (external.scope === 'request' || external.optional === true)
  }
}

/** Mode of a provider definition. */
export function modeOf(definition: ProviderDefinition): number {
  switch (definition.scope) {
    case 'request':
      return REQUEST
    case 'transient':
      return TRANSIENT
    default:
      return SINGLETON
  }
}
