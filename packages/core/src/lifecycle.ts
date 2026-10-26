import type { LifecycleHook } from './metadata.ts'

import { ErrorCode, ZnightError } from './errors.ts'

/**
 * Called by `app.start()` on every instantiated singleton, in resolution order (dependencies
 * first), before plugins start accepting traffic.
 */
export interface OnStart {
  onStart(): void | Promise<void>
}

/** Called by `app.start()` once every provider and plugin has started. */
export interface OnReady {
  onReady(): void | Promise<void>
}

/**
 * Called by `app.stop()` on every started singleton, in reverse resolution order, after plugins
 * stopped accepting traffic. Pairs with {@link OnStart}: resources acquired in a constructor or a
 * factory should be released by a dispose method (`@Provides({ dispose })`) or
 * `[Symbol.asyncDispose]()`, which run even when the application was never started.
 */
export interface OnStop {
  onStop(): void | Promise<void>
}

type Callable = (this: unknown) => unknown

function methodOf(instance: unknown, key: PropertyKey): Callable | undefined {
  if (instance === null || (typeof instance !== 'object' && typeof instance !== 'function')) return undefined
  const value: unknown = (instance as Record<PropertyKey, unknown>)[key]
  return typeof value === 'function' ? (value as Callable) : undefined
}

/** Whether `instance` implements `hook` (duck typing: a method with that name exists). */
export function hasLifecycleHook(instance: unknown, hook: LifecycleHook): boolean {
  return methodOf(instance, hook) !== undefined
}

/** Calls `hook` on `instance` when it implements it. Returns what the hook returned (or `undefined`). */
export function callLifecycleHook(instance: unknown, hook: LifecycleHook): unknown {
  const method = methodOf(instance, hook)
  return method === undefined ? undefined : method.call(instance)
}

/**
 * Whether {@link disposeInstance} has something to call: the `disposeMethod` when given, otherwise
 * `[Symbol.asyncDispose]` or `[Symbol.dispose]`.
 */
export function isDisposable(instance: unknown, disposeMethod?: string): boolean {
  if (disposeMethod !== undefined) return true
  return methodOf(instance, Symbol.asyncDispose) !== undefined || methodOf(instance, Symbol.dispose) !== undefined
}

/**
 * Releases `instance`: calls `disposeMethod` when given (`@Provides({ dispose: 'end' })`), otherwise
 * `[Symbol.asyncDispose]()`, otherwise `[Symbol.dispose]()`. Only the first applicable one is called.
 *
 * @throws ZnightError (ZNIGHT021) when `disposeMethod` is not a method of `instance`.
 */
export function disposeInstance(instance: unknown, disposeMethod?: string): unknown {
  if (disposeMethod !== undefined) {
    const method = methodOf(instance, disposeMethod)
    if (method === undefined) {
      throw new ZnightError(
        ErrorCode.LifecycleFailed,
        `Cannot dispose ${describeInstance(instance)}: it has no method "${disposeMethod}"`,
        { hints: ['Check the `dispose` option of the provider (@Provides({ dispose }))'] },
      )
    }
    return method.call(instance)
  }
  const asyncDispose = methodOf(instance, Symbol.asyncDispose)
  if (asyncDispose !== undefined) return asyncDispose.call(instance)
  const dispose = methodOf(instance, Symbol.dispose)
  if (dispose !== undefined) return dispose.call(instance)
  return undefined
}

function describeInstance(instance: unknown): string {
  if (instance === null || instance === undefined) return String(instance)
  const name = (instance as { constructor?: { name?: unknown } }).constructor?.name
  return typeof name === 'string' && name !== '' ? `an instance of ${name}` : `a ${typeof instance}`
}
