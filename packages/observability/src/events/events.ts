/**
 * Instrumentation of the `events:publish` and `events:listener` hooks of `@znight/events` (RFC 0011
 * §5.12): spans, metrics and logs of application events. `@znight/events` produces both only for
 * publications with listeners, and only when they are observed. Read structurally: no dependency on
 * `@znight/events`.
 */
import type { HookWrapper } from '@znight/core'
import type { Logger } from '../logging/logger.ts'
import type { MetricsRegistry } from '../metrics/registry.ts'
import type { Tracer } from '../tracing/tracer.ts'

import { context as otelContext, SpanKind, trace } from '@opentelemetry/api'

import { guard } from '../internal/safe.ts'
import { elapsedMs, now, startOf } from '../internal/time.ts'
import { ensureContextManager } from '../tracing/context.ts'
import { SemanticAttributes as Attr } from '../tracing/semconv.ts'
import { recordSpanError } from '../tracing/tracer.ts'

/** Observers of the events hooks: one wrapper per hook. */
export interface EventsObserver {
  readonly publish: HookWrapper<'events:publish'> | undefined
  readonly listener: HookWrapper<'events:listener'> | undefined
}

/** Options of {@link traceEvents}, {@link measureEvents} and {@link logEvents}. */
export interface EventsInstrumentationOptions {
  /** Events (class names) that are not instrumented. */
  readonly ignore?: (event: string) => boolean
}

/** Default buckets of listener durations, in seconds. */
export const DEFAULT_EVENT_LISTENER_BUCKETS: readonly number[] = Object.freeze([
  0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30,
])

/**
 * Spans: `publish <Event>` (`INTERNAL`) around the inline phase of a publication, and
 * `<Event> → <Class.method>` per listener; detached listeners start inside the publication span, so
 * their spans are its children even when they end after it (and after the HTTP response).
 */
export function traceEvents(tracer: Tracer, options: EventsInstrumentationOptions = {}): EventsObserver {
  const ignore = options.ignore
  const record = guard('Recording an events span')
  const span = <T>(
    name: string,
    attributes: Record<string, string | boolean>,
    startTime: unknown,
    next: () => Promise<T>,
    error: () => unknown,
  ): Promise<T> => {
    const parent = otelContext.active()
    const created = tracer.otel.startSpan(
      name,
      { kind: SpanKind.INTERNAL, attributes, ...startTimeOf(startTime) },
      parent,
    )
    ensureContextManager()
    return otelContext.with(trace.setSpan(parent, created), async () => {
      let thrown: unknown
      let failed = false
      try {
        return await next()
      } catch (caught) {
        failed = true
        thrown = caught
        throw caught
      } finally {
        record(() => {
          if (failed) recordSpanError(created, error() ?? thrown)
          created.end()
        })
      }
    })
  }
  return {
    publish: (event, next) => {
      if (ignore?.(event.event) === true) return next()
      return span(
        `publish ${event.event}`,
        { [Attr.ZNIGHT_EVENT_NAME]: event.event, [Attr.ZNIGHT_EVENT_MODE]: event.mode },
        event.startTime,
        next,
        () => event.error,
      )
    },
    listener: (event, next) => {
      if (ignore?.(event.event) === true) return next()
      return span(
        `${event.event} → ${event.listener}`,
        {
          [Attr.ZNIGHT_EVENT_NAME]: event.event,
          [Attr.ZNIGHT_EVENT_LISTENER]: event.listener,
          [Attr.ZNIGHT_EVENT_DETACHED]: event.detached,
          [Attr.CODE_FUNCTION_NAME]: event.listener,
        },
        event.startTime,
        next,
        () => event.error,
      )
    },
  }
}

/**
 * | Metric | Type | Labels |
 * | --- | --- | --- |
 * | `znight_events_published_total` | counter | `event` (publications with listeners) |
 * | `znight_event_listener_duration_seconds` | histogram | `event`, `listener`, `detached`, `outcome` |
 *
 * Labels are class and method names, bounded by the code.
 */
export function measureEvents(registry: MetricsRegistry, options: EventsInstrumentationOptions = {}): EventsObserver {
  const published = registry.counter('znight_events_published_total', {
    help: 'Number of application events published to at least one listener',
    labelNames: ['event'],
  })
  const duration = registry.histogram('znight_event_listener_duration_seconds', {
    help: 'Duration of application event listeners, in seconds',
    labelNames: ['event', 'listener', 'detached', 'outcome'],
    buckets: DEFAULT_EVENT_LISTENER_BUCKETS,
  })
  const ignore = options.ignore
  const record = guard('Recording events metrics')
  return {
    publish: (event, next) => {
      if (ignore?.(event.event) !== true) record(() => published.inc({ event: event.event }))
      return next()
    },
    listener: async (event, next) => {
      if (ignore?.(event.event) === true) return next()
      const started = now()
      let outcome = 'completed'
      try {
        return await next()
      } catch (error) {
        outcome = 'failed'
        throw error
      } finally {
        record(() =>
          duration.observe(
            { event: event.event, listener: event.listener, detached: String(event.detached), outcome },
            elapsedMs(startOf(event.startTime, started)) / 1000,
          ),
        )
      }
    },
  }
}

/**
 * One `debug` entry per publication with listeners (`event`, `mode`, `inline`, `detached`,
 * `durationMs` of the inline phase, `failedListener` and `err` when an inline listener failed: the
 * caller receives that error). Failed detached listeners are logged by `@znight/events` itself
 * (its default `onError`), through the application logger.
 */
export function logEvents(logger: Logger, options: EventsInstrumentationOptions = {}): EventsObserver {
  const ignore = options.ignore
  const record = guard('Logging an event publication')
  return {
    publish: async (event, next) => {
      if (ignore?.(event.event) === true || !logger.isLevelEnabled('debug')) return next()
      const started = now()
      try {
        return await next()
      } finally {
        record(() => {
          const entry: Record<string, unknown> = {
            event: event.event,
            mode: event.mode,
            inline: event.inline,
            detached: event.detached,
            durationMs: elapsedMs(startOf(event.startTime, started)),
          }
          if (event.failedListener !== undefined) entry['failedListener'] = event.failedListener
          if (event.error !== undefined) entry['err'] = event.error
          logger.debug('event published', entry)
        })
      }
    },
    listener: undefined,
  }
}

function startTimeOf(startTime: unknown): { startTime?: number } {
  return typeof startTime === 'number' && Number.isFinite(startTime) && startTime >= 0 && startTime <= performance.now()
    ? { startTime }
    : {}
}
