import { ErrorCode, ZnightError } from './errors.ts'
import { isThenable } from './utils.ts'

/** Signals the application can listen to for a graceful shutdown. */
export type ShutdownSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGQUIT' | 'SIGBREAK' | 'SIGUSR1' | 'SIGUSR2'

/**
 * The parts of `process` used by the application (signals, exit code, forced exit). Injectable for
 * tests through `Application.create({ shutdown: { process } })`.
 */
export interface ProcessLike {
  on(event: string, listener: (signal: string) => void): unknown
  off(event: string, listener: (signal: string) => void): unknown
  exit(code?: number): unknown
  exitCode?: number | string | null | undefined
}

/** The global `process`, when the runtime has one. */
export function defaultProcess(): ProcessLike | undefined {
  const candidate: unknown = (globalThis as { process?: unknown }).process
  if (candidate === null || typeof candidate !== 'object') return undefined
  const proc = candidate as Partial<ProcessLike>
  return typeof proc.on === 'function' && typeof proc.off === 'function' && typeof proc.exit === 'function'
    ? (proc as ProcessLike)
    : undefined
}

/** ZNIGHT021 raised when a lifecycle step exceeds its time budget. */
export class StepTimeoutError extends ZnightError {
  constructor(step: string, ms: number) {
    super(ErrorCode.LifecycleFailed, `${step} timed out after ${Math.round(ms)}ms`)
  }
}

/**
 * Runs `step` and resolves when it completes, or rejects with a {@link StepTimeoutError} after `ms`.
 * A synchronous step (or one resolving within the current tick of microtasks) always completes,
 * even with a zero budget. A step completing after its timeout is ignored.
 */
export function runWithTimeout(label: string, step: () => unknown, ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let result: unknown
    try {
      result = step()
    } catch (error) {
      reject(error)
      return
    }
    if (!isThenable(result)) {
      resolve()
      return
    }
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new StepTimeoutError(label, ms))
    }, ms)
    result.then(
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
