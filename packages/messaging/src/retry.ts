import type { DriverCapabilities } from './driver.ts'

import { consumerError } from './errors.ts'

/** Backoff strategy between attempts. */
export type BackoffStrategy = 'fixed' | 'exponential'

/** Options of `@Retry()` and of the plugin's `defaults.retry`. */
export interface RetryOptions {
  /** Total number of attempts, including the first delivery (`1`: no retry). */
  readonly attempts: number
  /** `fixed`: always `delay`; `exponential`: `delay * 2^(attempt - 1)`, capped by `maxDelay`. Default: `exponential`. */
  readonly backoff?: BackoffStrategy
  /** Base delay between attempts, in milliseconds. Default: 1000. */
  readonly delay?: number
  /** Upper bound of exponential delays, in milliseconds. */
  readonly maxDelay?: number
}

/** A normalized retry policy, as stored in the metadata (`MessageHandlerDefinition.retry`). */
export interface RetryPolicy {
  readonly attempts: number
  readonly backoff: BackoffStrategy
  readonly delay: number
  readonly maxDelay?: number
}

/** Default base delay of a retry policy, in milliseconds. */
export const DEFAULT_RETRY_DELAY_MS = 1000

/** Default backoff strategy. */
export const DEFAULT_BACKOFF: BackoffStrategy = 'exponential'

/** Policy applied to handlers without `@Retry` when the plugin sets no `defaults.retry`. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  attempts: 3,
  backoff: 'exponential',
  delay: DEFAULT_RETRY_DELAY_MS,
  maxDelay: 30_000,
})

/** The policy of `retry: false` / `{ attempts: 1 }`. */
export const NO_RETRY_POLICY: RetryPolicy = Object.freeze({ attempts: 1, backoff: 'fixed', delay: 0 })

const MAX_ATTEMPTS = 10_000

/**
 * Validates retry options and fills defaults.
 *
 * @throws ZnightError ZNIGHT011 for invalid values (`where` names the handler in the message).
 */
export function normalizeRetry(options: RetryOptions | RetryPolicy, where = '@Retry()'): RetryPolicy {
  if (options === null || typeof options !== 'object') {
    throw consumerError(`${where}: retry options must be an object, got ${String(options)}`)
  }
  const { attempts, backoff = DEFAULT_BACKOFF, delay = DEFAULT_RETRY_DELAY_MS, maxDelay } = options
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > MAX_ATTEMPTS) {
    throw consumerError(
      `${where}: "attempts" must be an integer between 1 and ${MAX_ATTEMPTS}, got ${String(attempts)}`,
      ['attempts counts the first delivery: { attempts: 3 } means 1 delivery + 2 retries'],
    )
  }
  if (backoff !== 'fixed' && backoff !== 'exponential') {
    throw consumerError(`${where}: "backoff" must be 'fixed' or 'exponential', got ${String(backoff)}`)
  }
  if (!isDuration(delay)) {
    throw consumerError(`${where}: "delay" must be a finite number of milliseconds >= 0, got ${String(delay)}`)
  }
  if (maxDelay !== undefined && (!isDuration(maxDelay) || maxDelay < delay)) {
    throw consumerError(
      `${where}: "maxDelay" must be a finite number of milliseconds >= delay (${delay}), got ${String(maxDelay)}`,
    )
  }
  return maxDelay === undefined ? { attempts, backoff, delay } : { attempts, backoff, delay, maxDelay }
}

function isDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * Delay before the next attempt once `attempt` (1-based) failed: `delay` for `fixed`,
 * `delay * 2^(attempt - 1)` capped by `maxDelay` for `exponential`.
 */
export function computeRetryDelay(policy: RetryPolicy, attempt: number): number {
  if (policy.backoff === 'fixed') return policy.delay
  const exponent = Math.max(0, attempt - 1)
  const raw = policy.delay * 2 ** exponent
  return Math.min(raw, policy.maxDelay ?? Number.MAX_SAFE_INTEGER)
}

/** Every delay the policy may request (one per retry), in attempt order. */
export function retryDelays(policy: RetryPolicy): number[] {
  const delays: number[] = []
  for (let attempt = 1; attempt < policy.attempts; attempt++) delays.push(computeRetryDelay(policy, attempt))
  return delays
}

/** Whether a delay is waited in-process (`true`) or delegated to the broker (`false`). */
export function isInProcessDelay(delayMs: number, capabilities: DriverCapabilities): boolean {
  return delayMs <= capabilities.maxInProcessDelayMs
}

/**
 * Checks that the driver can honour every delay of `policy`.
 *
 * @throws ZnightError ZNIGHT011 naming `where` and the offending delay.
 */
export function assertRetrySupported(
  policy: RetryPolicy,
  capabilities: DriverCapabilities,
  driver: string,
  where: string,
): void {
  for (const delay of new Set(retryDelays(policy))) {
    if (isInProcessDelay(delay, capabilities)) continue
    if (capabilities.nativeDelay && delay <= capabilities.maxNativeDelayMs) continue
    const limits = capabilities.nativeDelay
      ? `in-process delays up to ${capabilities.maxInProcessDelayMs} ms and native delays up to ${capabilities.maxNativeDelayMs} ms`
      : `in-process delays up to ${capabilities.maxInProcessDelayMs} ms and no native delay`
    throw consumerError(
      `${where}: the ${driver} driver cannot wait ${delay} ms between attempts (it supports ${limits})`,
      [
        'Lower "delay"/"maxDelay" of the retry policy',
        'Or raise the driver budget (e.g. maxInProcessDelayMs) if holding messages that long is acceptable',
      ],
    )
  }
}
