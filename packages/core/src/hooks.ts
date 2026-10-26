import type { CoreLogger } from './logger.ts'

import { isThenable } from './utils.ts'

/**
 * Typed registry of hook names and their event types. Feature packages augment it:
 *
 * ```ts
 * declare module '@znight/core' {
 *   interface ZnightHooks {
 *     'http:request': HttpRequestEvent
 *   }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmentation point for feature packages
export interface ZnightHooks {}

/** Name of a declared hook. */
export type HookName = keyof ZnightHooks

/** Event type of hook `K`. */
export type HookEvent<K extends HookName> = ZnightHooks[K]

/** Observer of a hook. Errors (thrown or rejected) are reported to the logger, never to the emitter. */
export type HookListener<K extends HookName> = (event: HookEvent<K>) => unknown

/**
 * Middleware around a hooked operation (`hooks.run()`). Must call `next()` to run the inner
 * wrappers and the operation; `next()` resolves with the operation's result. The value returned by
 * the wrapper itself is ignored.
 */
export type HookWrapper<K extends HookName> = (event: HookEvent<K>, next: () => Promise<unknown>) => Promise<unknown>

export interface HooksOptions {
  /** Receives listener failures. Default: the console. */
  readonly logger?: CoreLogger
}

type AnyListener = (event: unknown) => unknown
type AnyWrapper = (event: unknown, next: () => Promise<unknown>) => unknown

const EMPTY: readonly never[] = Object.freeze([])

/**
 * Lightweight, typed event bus used by plugins to observe (`on`/`emit`) and wrap (`wrap`/`run`)
 * framework operations (`http:request`, `messaging:message`...). Registration is copy-on-write, so
 * emitting allocates nothing.
 */
export class Hooks {
  readonly #listeners = new Map<PropertyKey, readonly AnyListener[]>()
  readonly #wrappers = new Map<PropertyKey, readonly AnyWrapper[]>()
  readonly #logger: CoreLogger | undefined

  constructor(options: HooksOptions = {}) {
    this.#logger = options.logger
  }

  /** Adds a listener. Returns a function removing it (idempotent). */
  on<K extends HookName>(name: K, listener: HookListener<K>): () => void {
    return add(this.#listeners, name, listener as AnyListener)
  }

  /**
   * Calls every listener of `name` synchronously, in registration order. A failing listener
   * (thrown error or rejected promise) is reported to the logger and does not affect the others.
   */
  emit<K extends HookName>(name: K, event: HookEvent<K>): void {
    const listeners = this.#listeners.get(name)
    if (listeners === undefined) return
    for (const listener of listeners) {
      try {
        const result = listener(event)
        if (isThenable(result)) result.then(undefined, error => this.#report(name, error))
      } catch (error) {
        this.#report(name, error)
      }
    }
  }

  /** Adds a wrapper around operations run with {@link run}. Returns a function removing it (idempotent). */
  wrap<K extends HookName>(name: K, wrapper: HookWrapper<K>): () => void {
    return add(this.#wrappers, name, wrapper as AnyWrapper)
  }

  /**
   * Runs `fn` through the wrappers of `name` (onion model: the first registered wrapper is the
   * outermost) and resolves with the result of `fn`. Without wrappers, `fn` is called directly.
   * If a wrapper does not call `next()`, `fn` does not run and the promise resolves with `undefined`.
   */
  run<K extends HookName, R>(name: K, event: HookEvent<K>, fn: () => Promise<R>): Promise<R> {
    const wrappers = this.#wrappers.get(name) ?? EMPTY
    if (wrappers.length === 0) {
      try {
        return Promise.resolve(fn())
      } catch (error) {
        return Promise.reject(error)
      }
    }
    let result: R | undefined
    const dispatch = async (index: number): Promise<unknown> => {
      if (index === wrappers.length) {
        result = await fn()
        return result
      }
      const wrapper = wrappers[index] as AnyWrapper
      await wrapper(event, () => dispatch(index + 1))
      return result
    }
    return dispatch(0).then(() => result as R)
  }

  /** Whether `name` has listeners (lets emitters skip building costly events). */
  hasListeners(name: HookName): boolean {
    return (this.#listeners.get(name)?.length ?? 0) > 0
  }

  /** Whether `name` has wrappers. */
  hasWrappers(name: HookName): boolean {
    return (this.#wrappers.get(name)?.length ?? 0) > 0
  }

  #report(name: PropertyKey, error: unknown): void {
    const message = `Hook listener for "${String(name)}" failed`
    if (this.#logger === undefined) console.error(`[znight] ${message}`, error)
    else this.#logger.error(message, { hook: String(name), err: error })
  }
}

function add<F>(registry: Map<PropertyKey, readonly F[]>, name: PropertyKey, fn: F): () => void {
  registry.set(name, [...(registry.get(name) ?? EMPTY), fn])
  let active = true
  return () => {
    if (!active) return
    active = false
    const current = registry.get(name) ?? EMPTY
    const index = current.indexOf(fn)
    if (index === -1) return
    const next = [...current.slice(0, index), ...current.slice(index + 1)]
    if (next.length === 0) registry.delete(name)
    else registry.set(name, next)
  }
}
