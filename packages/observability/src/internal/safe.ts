import { errorMessage } from './errors.ts'

/**
 * Instrumentation must never change the outcome of the instrumented operation. `guard(label)`
 * returns a function running a recording step: a failure is reported once (process warning) and
 * swallowed, later failures of the same guard are swallowed silently.
 */
export function guard(label: string): (step: () => void) => void {
  let reported = false
  return step => {
    try {
      step()
    } catch (error) {
      if (reported) return
      reported = true
      warn(`${label} failed: ${errorMessage(error)} (further failures are not reported)`)
    }
  }
}

/** Emits a process warning (stderr), never throws. */
export function warn(message: string): void {
  try {
    const emit = globalThis.process?.emitWarning
    if (typeof emit === 'function') emit.call(globalThis.process, message, { code: 'ZNIGHT_OBSERVABILITY' })
    else console.warn(`[znight] ${message}`)
  } catch {
    // nothing else can be done
  }
}
