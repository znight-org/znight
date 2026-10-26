import type { HookWrapper, HttpRequestEvent, MessageDeliveryEvent } from '@znight/core'
import type { LogEntryLevel } from './levels.ts'
import type { Logger } from './logger.ts'

import { guard } from '../internal/safe.ts'
import { elapsedMs, now, startOf } from '../internal/time.ts'
import { parseEntryLevel } from './levels.ts'

/** Options of {@link logHttpRequests}. */
export interface HttpRequestLogOptions {
  /** Level of successful requests (4xx are `warn`, 5xx `error`). Default: `info`. */
  readonly level?: LogEntryLevel
  /** Requests that are not logged (health checks...). */
  readonly ignore?: (event: HttpRequestEvent) => boolean
}

/** Options of {@link logMessages}. */
export interface MessageLogOptions {
  /** Level of acknowledged messages (retries are `warn`, dead letters `error`). Default: `info`. */
  readonly level?: LogEntryLevel
  /** Deliveries that are not logged. */
  readonly ignore?: (event: MessageDeliveryEvent) => boolean
}

/**
 * `http:request` hook wrapper writing one entry per request once it completed: `method`, `path`,
 * `route`, `status`, `durationMs`, `requestId` (and `err` for 5xx).
 *
 * ```ts
 * app.hooks.wrap('http:request', logHttpRequests(logger))
 * ```
 */
export function logHttpRequests(logger: Logger, options: HttpRequestLogOptions = {}): HookWrapper<'http:request'> {
  const level = options.level === undefined ? 'info' : parseEntryLevel(options.level, 'logging.requests.level')
  const ignore = options.ignore
  const record = guard('Logging an HTTP request')
  return async (event, next) => {
    if (ignore?.(event) === true) return next()
    const started = now()
    let thrown: unknown
    let failed = false
    try {
      return await next()
    } catch (error) {
      failed = true
      thrown = error
      throw error
    } finally {
      record(() => {
        const status = event.status ?? (failed ? 500 : 200)
        const severity = httpSeverity(status, level)
        if (logger.isLevelEnabled(severity)) {
          const entry: Record<string, unknown> = {
            method: event.method,
            path: event.path,
            route: event.route,
            status,
            durationMs: elapsedMs(startOf(event.startTime, started)),
            requestId: event.requestId,
          }
          const error = event.error ?? thrown
          if (status >= 500 && error !== undefined) entry['err'] = error
          logger.log(severity, status >= 500 ? 'request failed' : 'request completed', entry)
        }
      })
    }
  }
}

/**
 * `messaging:message` hook wrapper writing one entry per delivery once it settled: `queue`, `type`,
 * `messageId`, `attempt`, `consumer`, `handler`, `outcome`, `durationMs` (and `err` on failure).
 */
export function logMessages(logger: Logger, options: MessageLogOptions = {}): HookWrapper<'messaging:message'> {
  const level = options.level === undefined ? 'info' : parseEntryLevel(options.level, 'logging.messages.level')
  const ignore = options.ignore
  const record = guard('Logging a message delivery')
  return async (event, next) => {
    if (ignore?.(event) === true) return next()
    const started = now()
    let thrown: unknown
    let failed = false
    try {
      return await next()
    } catch (error) {
      failed = true
      thrown = error
      throw error
    } finally {
      record(() => {
        const outcome = event.outcome ?? (failed ? 'error' : 'ack')
        const severity = messageSeverity(outcome, level)
        if (logger.isLevelEnabled(severity)) {
          const entry: Record<string, unknown> = {
            queue: event.queue,
            type: event.type,
            messageId: event.messageId,
            attempt: event.attempt,
            consumer: event.consumer,
            handler: event.handler,
            outcome,
            durationMs: elapsedMs(startOf(event.startTime, started)),
          }
          const error = event.error ?? thrown
          if (outcome !== 'ack' && error !== undefined) entry['err'] = error
          logger.log(severity, MESSAGES[outcome] ?? 'message failed', entry)
        }
      })
    }
  }
}

const MESSAGES: Readonly<Record<string, string>> = {
  ack: 'message processed',
  retry: 'message failed, will be retried',
  'dead-letter': 'message dead-lettered',
}

function httpSeverity(status: number, success: LogEntryLevel): LogEntryLevel {
  if (status >= 500) return 'error'
  if (status >= 400) return 'warn'
  return success
}

function messageSeverity(outcome: string, success: LogEntryLevel): LogEntryLevel {
  if (outcome === 'ack') return success
  if (outcome === 'retry') return 'warn'
  return 'error'
}
