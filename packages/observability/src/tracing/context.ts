import type { Context, ContextManager } from '@opentelemetry/api'

import { AsyncLocalStorage } from 'node:async_hooks'
import { createContextKey, context as otelContext, ROOT_CONTEXT } from '@opentelemetry/api'

/**
 * Minimal `AsyncLocalStorage` context manager, registered by {@link ensureContextManager} when the
 * application registered none (no OpenTelemetry SDK). Without one, the OpenTelemetry API's
 * `context.with()` is a no-op: the trace context of a request would never reach its logs nor the
 * messages it publishes.
 */
export class FallbackContextManager implements ContextManager {
  readonly #storage = new AsyncLocalStorage<Context>()

  active(): Context {
    return this.#storage.getStore() ?? ROOT_CONTEXT
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    context: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.#storage.run(context, () => fn.apply(thisArg, args) as ReturnType<F>)
  }

  bind<T>(context: Context, target: T): T {
    if (typeof target !== 'function') return target
    const manager = this
    const fn = target as unknown as (...args: unknown[]) => unknown
    return function (this: unknown, ...args: unknown[]) {
      return manager.with(context, () => fn.apply(this, args))
    } as unknown as T
  }

  enable(): this {
    return this
  }

  disable(): this {
    this.#storage.disable()
    return this
  }
}

const PROBE = ROOT_CONTEXT.setValue(createContextKey('@znight/observability probe'), true)
const isProbeActive = (): boolean => otelContext.active() === PROBE

/** Whether a context manager is registered (the API's no-op one never activates a context). */
function hasContextManager(): boolean {
  return otelContext.active() !== ROOT_CONTEXT || otelContext.with(PROBE, isProbeActive)
}

/**
 * Registers a {@link FallbackContextManager} as the global OpenTelemetry context manager when none
 * is registered. Called lazily, right before a context is activated (first request, delivery,
 * publish or span), so an SDK registered while the application boots keeps its own manager.
 */
export function ensureContextManager(): void {
  if (hasContextManager()) return
  const manager = new FallbackContextManager()
  if (!otelContext.setGlobalContextManager(manager)) manager.disable()
}
