/**
 * The listener registry of a running application (RFC 0011 §5.6): built once at boot from
 * `metadata.extensions.events`, keyed by the prototype of each listened class. The listeners of a
 * published class are computed at its first publication (its prototype chain, merged and ordered)
 * and memoised per prototype: every later publication of that class is one `Map` lookup.
 */
import type { Container, Token, ZnightMetadata } from '@znight/core'

import { displayName, ErrorCode, ZnightError } from '@znight/core'

import { describe, invalidEvents } from './errors.ts'

/** A listener ready to be invoked. */
export interface Listener {
  readonly token: Token
  readonly method: string
  readonly order: number
  readonly detached: boolean
  readonly invoke: (host: unknown, event: object) => unknown
  /** `Class.method` (logs, hooks, `onError`). */
  readonly name: string
  /** The host is request-scoped: an inline call outside any scope opens one. */
  readonly requestScoped: boolean
}

/** What one publication of a class runs. */
export interface DispatchPlan {
  /** Class name of the published object. */
  readonly eventName: string
  /** In order. */
  readonly inline: readonly Listener[]
  /** In start order. */
  readonly detached: readonly Listener[]
  /** An inline listener is request-scoped. */
  readonly inlineScoped: boolean
}

/** The plan of every class without listener. */
export const EMPTY_PLAN: DispatchPlan = Object.freeze({
  eventName: '',
  inline: Object.freeze([]),
  detached: Object.freeze([]),
  inlineScoped: false,
})

/** The listeners of the metadata, by listened prototype. */
export class ListenerRegistry {
  readonly #byPrototype: ReadonlyMap<object, readonly Listener[]>
  readonly #plans = new Map<object, DispatchPlan>()
  /** Number of listener entries. */
  readonly size: number

  constructor(byPrototype: ReadonlyMap<object, readonly Listener[]>, size: number) {
    this.#byPrototype = byPrototype
    this.size = size
  }

  /** The plan of the events whose prototype is `prototype` (a class instance's, checked by the caller). */
  planOf(prototype: object): DispatchPlan {
    return this.#plans.get(prototype) ?? this.#plan(prototype)
  }

  #plan(prototype: object): DispatchPlan {
    let found: Listener[] | undefined
    for (let current: object | null = prototype; current !== null; current = Object.getPrototypeOf(current)) {
      if (current === Object.prototype) break
      const listeners = this.#byPrototype.get(current)
      if (listeners === undefined) continue
      found ??= []
      for (const listener of listeners) {
        // one invocation per method and publication, whatever the classes it is registered for
        if (!found.some(other => other.token === listener.token && other.method === listener.method)) {
          found.push(listener)
        }
      }
    }
    let plan = EMPTY_PLAN
    if (found !== undefined) {
      found.sort(compareListeners)
      const inline = found.filter(listener => !listener.detached)
      plan = Object.freeze({
        eventName: eventNameOf(prototype),
        inline: Object.freeze(inline),
        detached: Object.freeze(found.filter(listener => listener.detached)),
        inlineScoped: inline.some(listener => listener.requestScoped),
      })
    }
    this.#plans.set(prototype, plan)
    return plan
  }
}

/**
 * Builds the registry from `metadata.extensions.events` (absent: an empty registry). Malformed
 * entries are ZNIGHT070; a host without provider is ZNIGHT001.
 */
export function buildRegistry(metadata: ZnightMetadata, container: Container): ListenerRegistry {
  const section: unknown = metadata.extensions?.events
  const byPrototype = new Map<object, Listener[]>()
  if (section === undefined) return new ListenerRegistry(byPrototype, 0)
  const where = 'metadata.extensions.events'
  if (!isRecord(section) || !Array.isArray(section['listeners'])) {
    throw invalidEvents(`${where} must be { listeners: [...] }, got ${describe(section)}`, [
      'Regenerate the module with @znight/compiler (znight generate), or fix the hand-written metadata',
    ])
  }
  const listeners = section['listeners'] as readonly unknown[]
  for (const [index, entry] of listeners.entries()) {
    const at = `${where}.listeners[${index}]`
    if (!isRecord(entry)) throw invalidEvents(`${at} must be an object, got ${describe(entry)}`)
    const event = entry['event']
    const token = entry['token']
    const method = entry['method']
    const order = entry['order'] ?? 0
    const detached = entry['detached'] ?? false
    const invoke = entry['invoke']
    if (typeof event !== 'function' || !isRecord(event.prototype)) {
      throw invalidEvents(`${at}.event must be a class, got ${describe(event)}`)
    }
    if (typeof token !== 'string' || token === '') throw invalidEvents(`${at}.token must be a provider token`)
    if (typeof method !== 'string' || method === '') throw invalidEvents(`${at}.method must be a method name`)
    if (typeof order !== 'number' || !Number.isInteger(order)) throw invalidEvents(`${at}.order must be an integer`)
    if (typeof detached !== 'boolean') throw invalidEvents(`${at}.detached must be a boolean`)
    if (typeof invoke !== 'function') throw invalidEvents(`${at}.invoke must be a function`)
    if (!container.has(token)) {
      throw new ZnightError(
        ErrorCode.MissingProvider,
        `No provider for the event listener host '${token}' (${displayName(token)}.${method})`,
        { hints: ['Regenerate the module with @znight/compiler: listener hosts are providers'] },
      )
    }
    const listener: Listener = Object.freeze({
      token,
      method,
      order,
      detached,
      invoke: invoke as Listener['invoke'],
      name: `${displayName(token)}.${method}`,
      requestScoped: metadata.providers[token]?.scope === 'request',
    })
    const prototype = event.prototype as object
    let list = byPrototype.get(prototype)
    if (list === undefined) {
      list = []
      byPrototype.set(prototype, list)
    }
    list.push(listener)
  }
  return new ListenerRegistry(byPrototype, listeners.length)
}

/** `(order, token, method)`, ordinal string comparison (deterministic, never `localeCompare`). */
function compareListeners(a: Listener, b: Listener): number {
  return a.order - b.order || compareStrings(a.token, b.token) || compareStrings(a.method, b.method)
}

function compareStrings(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** Class name of the instances of `prototype`. */
export function eventNameOf(prototype: object): string {
  const ctor: unknown = Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value
  return typeof ctor === 'function' && ctor.name !== '' ? ctor.name : 'anonymous event'
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}
