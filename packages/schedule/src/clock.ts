/**
 * Time source and timers of the scheduler (RFC 0004 §7.2). The system clock reads `Date.now()` and
 * uses `setTimeout`; tests use `createTestClock()` from `@znight/schedule/testing`.
 */

/** Time source and timers of the scheduler. */
export interface ScheduleClock {
  /** Current wall-clock time, epoch milliseconds. */
  now(): number
  /** Calls `fn` once after `ms` milliseconds (any non-negative delay). Returns a handle for {@link clearTimer}. */
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  /**
   * Receives the promise of every run the scheduler starts (optional). The test clock implements it
   * to wait for runs in `advance()`.
   */
  track?(run: Promise<unknown>): void
}

/** Largest delay `setTimeout` accepts (Node turns larger ones into 1 ms). */
export const MAX_TIMER_DELAY: number = 2 ** 31 - 1

interface SystemTimer {
  handle: ReturnType<typeof setTimeout> | undefined
}

/** The system clock: `Date.now()` and `setTimeout`, long delays split below 2^31 − 1 ms. */
export const systemClock: ScheduleClock = Object.freeze({
  now: (): number => Date.now(),
  setTimer(fn: () => void, ms: number): unknown {
    const timer: SystemTimer = { handle: undefined }
    const arm = (remaining: number): void => {
      if (remaining > MAX_TIMER_DELAY) {
        timer.handle = setTimeout(() => arm(remaining - MAX_TIMER_DELAY), MAX_TIMER_DELAY)
      } else {
        timer.handle = setTimeout(fn, Math.max(0, remaining))
      }
    }
    arm(Number.isFinite(ms) ? ms : MAX_TIMER_DELAY)
    return timer
  },
  clearTimer(handle: unknown): void {
    const timer = handle as SystemTimer | undefined
    if (timer?.handle !== undefined) clearTimeout(timer.handle)
    if (timer !== undefined) timer.handle = undefined
  },
})

/** Whether `value` has the shape of a {@link ScheduleClock}. */
export function isScheduleClock(value: unknown): value is ScheduleClock {
  if (value === null || typeof value !== 'object') return false
  const clock = value as Partial<ScheduleClock>
  return (
    typeof clock.now === 'function' &&
    typeof clock.setTimer === 'function' &&
    typeof clock.clearTimer === 'function' &&
    (clock.track === undefined || typeof clock.track === 'function')
  )
}
