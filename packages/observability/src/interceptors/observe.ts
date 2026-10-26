/** Completion callbacks of an intercepted call. They must not throw (wrap them with `guard`). */
export interface CallObserver {
  success(value: unknown): void
  failure(error: unknown): void
}

/**
 * Runs `call` (which calls `invocation.proceed()`) and reports its completion to `observer`,
 * respecting the method kind:
 *
 * - async method (`invocation.isAsync`): returns a promise settling like the method's;
 * - sync method: returns the method's value as is (never a promise wrapper). A sync method that
 *   happens to return a promise is reported when it returns, not when the promise settles: the
 *   promise is passed through untouched (attaching handlers would hide unhandled rejections).
 */
export function observeCall(isAsync: boolean, call: () => unknown, observer: CallObserver): unknown {
  if (isAsync) return observeAsync(call, observer)
  let value: unknown
  try {
    value = call()
  } catch (error) {
    observer.failure(error)
    throw error
  }
  observer.success(value)
  return value
}

async function observeAsync(call: () => unknown, observer: CallObserver): Promise<unknown> {
  let value: unknown
  try {
    value = await call()
  } catch (error) {
    observer.failure(error)
    throw error
  }
  observer.success(value)
  return value
}
