import type { HookWrapper, HttpRequestEvent, MessageDeliveryEvent } from '@znight/core'
import type { MetricsRegistry } from './registry.ts'

import { normalizeMethod } from '../internal/hooks.ts'
import { guard } from '../internal/safe.ts'
import { now, startOf } from '../internal/time.ts'

/** Default buckets of request durations, in seconds (OpenTelemetry's recommendation for HTTP servers). */
export const DEFAULT_DURATION_BUCKETS: readonly number[] = Object.freeze([
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
])

/** Default buckets of message processing durations, in seconds. */
export const DEFAULT_MESSAGE_BUCKETS: readonly number[] = Object.freeze([
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
])

/** `route` label of requests that matched no route (bounded cardinality: never the raw path). */
export const UNMATCHED_ROUTE = 'unmatched'

/** Options of {@link measureHttpRequests}. */
export interface HttpMetricsOptions {
  /** Buckets of `http_server_request_duration_seconds`. Default: {@link DEFAULT_DURATION_BUCKETS}. */
  readonly buckets?: readonly number[]
  /** Requests that are not measured (health checks, the metrics endpoint itself...). */
  readonly ignore?: (event: HttpRequestEvent) => boolean
}

/** Options of {@link measureMessages}. */
export interface MessagingMetricsOptions {
  /** Buckets of `messaging_process_duration_seconds`. Default: {@link DEFAULT_MESSAGE_BUCKETS}. */
  readonly buckets?: readonly number[]
  /** Deliveries that are not measured. */
  readonly ignore?: (event: MessageDeliveryEvent) => boolean
}

/**
 * `http:request` hook wrapper recording RED metrics (names are prefixed with the registry prefix):
 *
 * | Metric | Type | Labels |
 * | --- | --- | --- |
 * | `http_server_requests_total` | counter | `method`, `route`, `status` |
 * | `http_server_request_duration_seconds` | histogram | `method`, `route`, `status` |
 * | `http_server_active_requests` | gauge | `method` |
 *
 * `route` is the route pattern (`/users/:id`), never the raw path; `method` is normalised (unknown
 * methods become `_OTHER`), so the cardinality stays bounded.
 */
export function measureHttpRequests(
  registry: MetricsRegistry,
  options: HttpMetricsOptions = {},
): HookWrapper<'http:request'> {
  const labelNames = ['method', 'route', 'status']
  const total = registry.counter('http_server_requests_total', { help: 'Number of HTTP requests handled', labelNames })
  const duration = registry.histogram('http_server_request_duration_seconds', {
    help: 'Duration of HTTP requests, in seconds',
    labelNames,
    buckets: options.buckets ?? DEFAULT_DURATION_BUCKETS,
  })
  const active = registry.gauge('http_server_active_requests', {
    help: 'Number of HTTP requests in flight',
    labelNames: ['method'],
  })
  const ignore = options.ignore
  const record = guard('Recording HTTP metrics')
  return async (event, next) => {
    if (ignore?.(event) === true) return next()
    const started = now()
    const method = normalizeMethod(event.method)
    record(() => active.inc({ method }))
    let failed = false
    try {
      return await next()
    } catch (error) {
      failed = true
      throw error
    } finally {
      record(() => {
        active.dec({ method })
        const labels = {
          method,
          route: event.route ?? UNMATCHED_ROUTE,
          status: String(event.status ?? (failed ? 500 : 200)),
        }
        total.inc(labels)
        duration.observe(labels, (now() - startOf(event.startTime, started)) / 1000)
      })
    }
  }
}

/**
 * `messaging:message` hook wrapper recording consumer metrics (prefixed with the registry prefix):
 *
 * | Metric | Type | Labels |
 * | --- | --- | --- |
 * | `messaging_messages_processed_total` | counter | `queue`, `consumer`, `type`, `outcome` |
 * | `messaging_process_duration_seconds` | histogram | `queue`, `consumer`, `type`, `outcome` |
 * | `messaging_active_messages` | gauge | `queue` |
 *
 * `outcome` is `ack`, `retry`, `dead-letter` or `error` (the pipeline threw).
 */
export function measureMessages(
  registry: MetricsRegistry,
  options: MessagingMetricsOptions = {},
): HookWrapper<'messaging:message'> {
  const labelNames = ['queue', 'consumer', 'type', 'outcome']
  const total = registry.counter('messaging_messages_processed_total', {
    help: 'Number of messages processed',
    labelNames,
  })
  const duration = registry.histogram('messaging_process_duration_seconds', {
    help: 'Duration of message processing, in seconds',
    labelNames,
    buckets: options.buckets ?? DEFAULT_MESSAGE_BUCKETS,
  })
  const active = registry.gauge('messaging_active_messages', {
    help: 'Number of messages being processed',
    labelNames: ['queue'],
  })
  const ignore = options.ignore
  const record = guard('Recording messaging metrics')
  return async (event, next) => {
    if (ignore?.(event) === true) return next()
    const started = now()
    const queue = event.queue
    record(() => active.inc({ queue }))
    let failed = false
    try {
      return await next()
    } catch (error) {
      failed = true
      throw error
    } finally {
      record(() => {
        active.dec({ queue })
        const labels = {
          queue,
          consumer: event.consumer,
          type: event.type ?? '',
          outcome: event.outcome ?? (failed ? 'error' : 'ack'),
        }
        total.inc(labels)
        duration.observe(labels, (now() - startOf(event.startTime, started)) / 1000)
      })
    }
  }
}
