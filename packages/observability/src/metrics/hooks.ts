import type { HookWrapper, HttpRequestEvent, MessageDeliveryEvent } from '@znight/core'
import type { MetricsRegistry } from './registry.ts'

import { invalidOption } from '../internal/errors.ts'
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

/** `type` label of deliveries that matched no handler (bounded cardinality: never the raw type). */
export const UNMATCHED_MESSAGE_TYPE = 'unmatched'

/** `type` label of the types a handler received beyond {@link MessagingMetricsOptions.maxTypesPerHandler}. */
export const OTHER_MESSAGE_TYPE = '_OTHER'

/** Default of {@link MessagingMetricsOptions.maxTypesPerHandler}. */
export const DEFAULT_MAX_TYPES_PER_HANDLER = 50

/** Options of {@link measureMessages}. */
export interface MessagingMetricsOptions {
  /** Buckets of `messaging_process_duration_seconds`. Default: {@link DEFAULT_MESSAGE_BUCKETS}. */
  readonly buckets?: readonly number[]
  /** Deliveries that are not measured. */
  readonly ignore?: (event: MessageDeliveryEvent) => boolean
  /**
   * Distinct `type` label values recorded per handler (a pattern or default `@OnMessage()` handler
   * receives whatever types producers send); later types are recorded as `_OTHER`. Default: 50.
   */
  readonly maxTypesPerHandler?: number
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
 * `outcome` is `ack`, `retry`, `dead-letter` or `error` (the pipeline threw). `type` is the message
 * type when a handler matched, `unmatched` otherwise (never the raw type: producers choose it), and
 * at most `maxTypesPerHandler` distinct types are recorded per handler (then `_OTHER`), so the
 * cardinality stays bounded.
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
  const typeLabel = boundedTypeLabel(options.maxTypesPerHandler)
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
          type: typeLabel(event),
          outcome: event.outcome ?? (failed ? 'error' : 'ack'),
        }
        total.inc(labels)
        duration.observe(labels, (now() - startOf(event.startTime, started)) / 1000)
      })
    }
  }
}

/**
 * The `type` label of a delivery: `unmatched` when no handler matched, otherwise the message type,
 * limited to `max` distinct values per handler (`_OTHER` beyond).
 */
function boundedTypeLabel(max: number = DEFAULT_MAX_TYPES_PER_HANDLER): (event: MessageDeliveryEvent) => string {
  if (!Number.isInteger(max) || max < 1) {
    throw invalidOption('metrics.messaging.maxTypesPerHandler', `expected a positive integer, got ${String(max)}`)
  }
  const seen = new Map<string, Set<string>>()
  return event => {
    if (event.handler === undefined) return UNMATCHED_MESSAGE_TYPE
    const type = event.type ?? ''
    // queue, consumer and handler come from the code: the key space is bounded
    const key = `${event.queue}\0${event.consumer}\0${event.handler}`
    let types = seen.get(key)
    if (types === undefined) {
      types = new Set()
      seen.set(key, types)
    }
    if (types.has(type)) return type
    if (types.size >= max) return OTHER_MESSAGE_TYPE
    types.add(type)
    return type
  }
}
