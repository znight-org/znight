/**
 * Compile-time validation and normalization of `@Retry` options. Mirrors the runtime
 * `normalizeRetry()` (same rules and defaults) so that invalid policies fail the build instead of the
 * boot; it also rejects unknown options (typos) and warns about options without effect.
 */
import type { AnalyzeContext, DecoratorInfo, StaticValue } from '@znight/compiler'
import type { MessagingData, RetryPolicyData } from './data.ts'

import {
  DEFAULT_BACKOFF,
  DEFAULT_RETRY_DELAY_MS,
  INVALID_CONSUMER,
  INVALID_DECORATOR,
  MAX_RETRY_ATTEMPTS,
} from './constants.ts'
import { closest, describeValue, isRecord, propertyLocation } from './values.ts'

const RETRY_OPTIONS: readonly string[] = ['attempts', 'backoff', 'delay', 'maxDelay']

/**
 * Validates the argument of a `@Retry` decorator and fills the runtime defaults. Returns `undefined`
 * (after reporting the problems) when the options are invalid.
 *
 * @param where the handler (`OrderConsumer.placed()`), used in messages
 */
export function normalizeRetryDecorator(
  decorator: DecoratorInfo,
  where: string,
  ctx: AnalyzeContext<MessagingData>,
): RetryPolicyData | undefined {
  if (!decorator.called) return undefined // `@Retry` without call: already reported
  const arg = decorator.args[0]
  if (arg === undefined) {
    ctx.report({
      code: INVALID_DECORATOR,
      severity: 'error',
      message: `@Retry on ${where} requires options: @Retry({ attempts: 3 })`,
      location: decorator.location,
      hints: ['attempts counts the first delivery: { attempts: 3 } means 1 delivery + 2 retries'],
    })
    return undefined
  }
  if (!arg.evaluated) return undefined // not statically evaluable: already reported
  const options = arg.value
  if (!isRecord(options)) {
    ctx.report({
      code: INVALID_DECORATOR,
      severity: 'error',
      message: `@Retry on ${where} expects an options object ({ attempts, backoff?, delay?, maxDelay? }), got ${describeValue(options)}`,
      location: arg.location,
    })
    return undefined
  }

  let valid = true
  const fail = (key: string, message: string, hints?: readonly string[]): void => {
    valid = false
    ctx.report({
      code: INVALID_CONSUMER,
      severity: 'error',
      message: `@Retry on ${where}: ${message}`,
      location: propertyLocation(ctx.project, arg, key),
      ...(hints === undefined ? {} : { hints }),
    })
  }

  for (const key of Object.keys(options)) {
    if (RETRY_OPTIONS.includes(key)) continue
    const suggestion = closest(key, RETRY_OPTIONS)
    fail(key, `unknown option "${key}"`, [
      suggestion === undefined
        ? `Valid options: ${RETRY_OPTIONS.join(', ')}`
        : `Did you mean "${suggestion}"? Valid options: ${RETRY_OPTIONS.join(', ')}`,
    ])
  }

  const attempts = options['attempts']
  if (attempts === undefined) {
    fail('attempts', '"attempts" is required', [
      'attempts counts the first delivery: { attempts: 3 } means 1 delivery + 2 retries',
    ])
  } else if (!isInteger(attempts) || attempts < 1 || attempts > MAX_RETRY_ATTEMPTS) {
    fail(
      'attempts',
      `"attempts" must be an integer between 1 and ${MAX_RETRY_ATTEMPTS}, got ${describeValue(attempts)}`,
      ['attempts counts the first delivery: { attempts: 3 } means 1 delivery + 2 retries'],
    )
  }

  const rawBackoff = options['backoff']
  const backoff = rawBackoff === undefined ? DEFAULT_BACKOFF : rawBackoff
  if (backoff !== 'fixed' && backoff !== 'exponential') {
    fail('backoff', `"backoff" must be 'fixed' or 'exponential', got ${describeValue(backoff)}`)
  }

  const rawDelay = options['delay']
  const delay = rawDelay === undefined ? DEFAULT_RETRY_DELAY_MS : rawDelay
  const delayValid = isDuration(delay)
  if (!delayValid) {
    fail('delay', `"delay" must be a finite number of milliseconds >= 0, got ${describeValue(delay)}`)
  }

  const maxDelay = options['maxDelay']
  if (maxDelay !== undefined) {
    if (!isDuration(maxDelay) || (delayValid && maxDelay < delay)) {
      fail(
        'maxDelay',
        `"maxDelay" must be a finite number of milliseconds >= delay${delayValid ? ` (${delay})` : ''}, got ${describeValue(maxDelay)}`,
      )
    } else if (backoff === 'fixed') {
      ctx.report({
        code: INVALID_CONSUMER,
        severity: 'warning',
        message: `@Retry on ${where}: "maxDelay" has no effect with backoff 'fixed' (every retry waits "delay")`,
        location: propertyLocation(ctx.project, arg, 'maxDelay'),
        hints: ["Remove maxDelay, or use backoff: 'exponential'"],
      })
    }
  }

  if (!valid || !isInteger(attempts) || (backoff !== 'fixed' && backoff !== 'exponential') || !isDuration(delay)) {
    return undefined
  }
  const policy: RetryPolicyData = isDuration(maxDelay)
    ? { attempts, backoff, delay, maxDelay }
    : { attempts, backoff, delay }
  return Object.freeze(policy)
}

function isInteger(value: StaticValue): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

function isDuration(value: StaticValue): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
