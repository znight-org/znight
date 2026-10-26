/** Monotonic clock in milliseconds (`performance.now()`). */
export function now(): number {
  return performance.now()
}

/** Milliseconds elapsed since `start` (a `performance.now()` value), rounded to the microsecond. */
export function elapsedMs(start: number, end: number = performance.now()): number {
  return Math.round((end - start) * 1000) / 1000
}

/**
 * Start of an instrumented operation: the producer's `startTime` (a `performance.now()` value) when
 * it is valid, otherwise `fallback`.
 */
export function startOf(startTime: unknown, fallback: number): number {
  return typeof startTime === 'number' && Number.isFinite(startTime) && startTime <= fallback ? startTime : fallback
}
