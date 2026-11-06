/**
 * Instrumentation of the `websocket:message` and `websocket:connection` hooks of
 * `@znight/websocket` (RFC 0003 §8.10): a span, metrics and an optional debug log entry per inbound
 * message; connection gauges, counters and one log entry per closed connection. Handshakes are
 * `http:request` events already. Read structurally: no dependency on `@znight/websocket`.
 */
import type { Attributes, Link } from '@opentelemetry/api'
import type { HookListener, HookWrapper, WebSocketConnectionEvent, WebSocketMessageEvent } from '@znight/core'
import type { LogEntryLevel } from '../logging/levels.ts'
import type { Logger } from '../logging/logger.ts'
import type { MetricsRegistry } from '../metrics/registry.ts'
import type { Tracer } from '../tracing/tracer.ts'

import { context as otelContext, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'

import { invalidOption } from '../internal/errors.ts'
import { guard } from '../internal/safe.ts'
import { elapsedMs, now, startOf } from '../internal/time.ts'
import { parseEntryLevel } from '../logging/levels.ts'
import { DEFAULT_DURATION_BUCKETS } from '../metrics/hooks.ts'
import { ensureContextManager } from '../tracing/context.ts'
import { SemanticAttributes as Attr } from '../tracing/semconv.ts'
import { recordSpanError } from '../tracing/tracer.ts'

/** Options of {@link traceWebSocketMessages}. */
export interface WebSocketTracingOptions {
  /** Messages that are not traced. */
  readonly ignore?: (event: WebSocketMessageEvent) => boolean
}

/** Options of {@link measureWebSocketMessages}. */
export interface WebSocketMetricsOptions {
  /** Buckets of `websocket_message_duration_seconds`. Default: {@link DEFAULT_DURATION_BUCKETS}. */
  readonly buckets?: readonly number[]
  /** Messages that are not measured. */
  readonly ignore?: (event: WebSocketMessageEvent) => boolean
  /** Distinct `event` label values per gateway (clients choose events); later ones are `_OTHER`. Default: 50. */
  readonly maxEvents?: number
}

/** Options of {@link logWebSocket}. */
export interface WebSocketLogOptions {
  /** Level of the entry of a closed connection. Default: `info`. */
  readonly level?: LogEntryLevel
  /** One `debug` entry per message (failed messages are `error` entries anyway). Default: `false`. */
  readonly messages?: boolean
  /** Connections and messages that are not logged. */
  readonly ignore?: (event: WebSocketConnectionEvent | WebSocketMessageEvent) => boolean
}

/** Default of {@link WebSocketMetricsOptions.maxEvents}. */
export const DEFAULT_MAX_WEBSOCKET_EVENTS = 50

/** `event` label of the events beyond {@link WebSocketMetricsOptions.maxEvents}. */
export const OTHER_WEBSOCKET_EVENT = '_OTHER'

/** `event` label of messages no handler matched, and of undecodable frames. */
export const UNMATCHED_WEBSOCKET_EVENT = 'unmatched'

/**
 * One `SERVER` span per inbound message, `WS <path> <event>` (`WS <path>` on raw gateways), the
 * root of a **new trace** linked to the handshake's span: a connection lives for hours, its
 * messages must not be children of a long-ended HTTP span. Attributes: `znight.websocket.gateway`,
 * `.event`, `.handler`, `.connection_id`, `.outcome`, `znight.request.id` (the handshake's) and
 * `http.route`. The status is `ERROR` for the `error` and `timeout` outcomes.
 */
export function traceWebSocketMessages(
  tracer: Tracer,
  options: WebSocketTracingOptions = {},
): HookWrapper<'websocket:message'> {
  const ignore = options.ignore
  const record = guard('Recording a WebSocket span')
  return (event, next) => {
    if (ignore?.(event) === true) return next()
    const handshake = trace.getSpanContext(otelContext.active())
    const links: Link[] = handshake === undefined ? [] : [{ context: handshake }]
    const attributes: Attributes = {
      [Attr.ZNIGHT_WEBSOCKET_GATEWAY]: event.gateway,
      [Attr.ZNIGHT_WEBSOCKET_CONNECTION_ID]: event.connectionId,
      [Attr.ZNIGHT_REQUEST_ID]: event.requestId,
      [Attr.HTTP_ROUTE]: event.path,
    }
    if (event.event !== undefined) attributes[Attr.ZNIGHT_WEBSOCKET_EVENT] = event.event
    if (event.handler !== undefined) attributes[Attr.ZNIGHT_WEBSOCKET_HANDLER] = event.handler
    const span = tracer.otel.startSpan(
      event.event === undefined ? `WS ${event.path}` : `WS ${event.path} ${event.event}`,
      { kind: SpanKind.SERVER, attributes, links, root: true, ...startTimeOf(event.startTime) },
      ROOT_CONTEXT,
    )
    ensureContextManager()
    return otelContext.with(trace.setSpan(ROOT_CONTEXT, span), async () => {
      let failed = false
      let thrown: unknown
      try {
        return await next()
      } catch (error) {
        failed = true
        thrown = error
        throw error
      } finally {
        record(() => {
          const outcome = event.outcome ?? 'error'
          span.setAttribute(Attr.ZNIGHT_WEBSOCKET_OUTCOME, outcome)
          if (failed) recordSpanError(span, thrown)
          else if (outcome === 'error' || outcome === 'timeout') {
            span.setStatus({ code: SpanStatusCode.ERROR, message: `message ${outcome}` })
            span.setAttribute(Attr.ERROR_TYPE, errorType(event.error, outcome))
          }
          span.end()
        })
      }
    })
  }
}

/** The metrics of messages and connections: a `websocket:message` wrapper and a `websocket:connection` listener. */
export interface WebSocketMetrics {
  readonly wrap: HookWrapper<'websocket:message'>
  readonly listen: HookListener<'websocket:connection'>
}

/**
 * WebSocket metrics (prefixed with the registry prefix):
 *
 * | Metric | Type | Labels |
 * | --- | --- | --- |
 * | `websocket_connections_active` | gauge | `gateway` |
 * | `websocket_connections_total` | counter | `gateway`, `initiator` (closed connections) |
 * | `websocket_messages_received_total` | counter | `gateway`, `event`, `outcome` |
 * | `websocket_message_duration_seconds` | histogram | `gateway`, `event`, `outcome` |
 *
 * `event` is `unmatched` for unknown events and undecodable frames, `raw` on raw gateways, and
 * limited to `maxEvents` distinct values per gateway (then `_OTHER`).
 */
export function measureWebSocketMessages(
  registry: MetricsRegistry,
  options: WebSocketMetricsOptions = {},
): WebSocketMetrics {
  const max = options.maxEvents ?? DEFAULT_MAX_WEBSOCKET_EVENTS
  if (!Number.isInteger(max) || max < 1) {
    throw invalidOption('metrics.websocket.maxEvents', `expected a positive integer, got ${String(max)}`)
  }
  const active = registry.gauge('websocket_connections_active', {
    help: 'Open WebSocket connections',
    labelNames: ['gateway'],
  })
  const connections = registry.counter('websocket_connections_total', {
    help: 'Closed WebSocket connections, by initiator',
    labelNames: ['gateway', 'initiator'],
  })
  const received = registry.counter('websocket_messages_received_total', {
    help: 'Inbound WebSocket messages, by outcome',
    labelNames: ['gateway', 'event', 'outcome'],
  })
  const duration = registry.histogram('websocket_message_duration_seconds', {
    help: 'Duration of the handling of inbound WebSocket messages, in seconds',
    labelNames: ['gateway', 'event', 'outcome'],
    buckets: options.buckets ?? DEFAULT_DURATION_BUCKETS,
  })
  const seen = new Map<string, Set<string>>()
  const eventLabel = (event: WebSocketMessageEvent): string => {
    if (event.handler === undefined) return UNMATCHED_WEBSOCKET_EVENT
    const name = event.event ?? 'raw'
    let events = seen.get(event.path)
    if (events === undefined) {
      events = new Set()
      seen.set(event.path, events)
    }
    if (events.has(name)) return name
    if (events.size >= max) return OTHER_WEBSOCKET_EVENT
    events.add(name)
    return name
  }
  const ignore = options.ignore
  const record = guard('Recording WebSocket metrics')
  return {
    wrap: async (event, next) => {
      if (ignore?.(event) === true) return next()
      const started = now()
      try {
        return await next()
      } finally {
        record(() => {
          const labels = { gateway: event.gateway, event: eventLabel(event), outcome: event.outcome ?? 'error' }
          received.inc(labels)
          duration.observe(labels, (now() - startOf(event.startTime, started)) / 1000)
        })
      }
    },
    listen: event =>
      record(() => {
        if (event.type === 'open') active.inc({ gateway: event.gateway })
        else {
          active.dec({ gateway: event.gateway })
          connections.inc({ gateway: event.gateway, initiator: event.initiator ?? 'client' })
        }
      }),
  }
}

/** The logs of connections and messages. */
export interface WebSocketLogs {
  /** `undefined` unless message entries are enabled (or to log failed messages). */
  readonly wrap: HookWrapper<'websocket:message'>
  readonly listen: HookListener<'websocket:connection'>
}

/**
 * One entry per closed connection (`websocket connection closed`: gateway, path, connectionId,
 * requestId, durationMs, code, reason, initiator), one `error` entry per failed message (with
 * `err`), and with `messages: true` one `debug` entry per message. Entries written inside a
 * connection carry its request id (same scope).
 */
export function logWebSocket(logger: Logger, options: WebSocketLogOptions = {}): WebSocketLogs {
  const level = options.level === undefined ? 'info' : parseEntryLevel(options.level, 'logging.websocket.level')
  const ignore = options.ignore
  const messages = options.messages === true
  const record = guard('Logging WebSocket activity')
  return {
    wrap: async (event, next) => {
      if (ignore?.(event) === true) return next()
      const started = now()
      try {
        return await next()
      } finally {
        record(() => {
          const failed = event.outcome === 'error' || event.outcome === 'timeout' || event.outcome === undefined
          const severity: LogEntryLevel = failed ? 'error' : 'debug'
          if ((failed || messages) && logger.isLevelEnabled(severity)) {
            const entry: Record<string, unknown> = {
              gateway: event.gateway,
              path: event.path,
              event: event.event,
              handler: event.handler,
              outcome: event.outcome ?? 'error',
              connectionId: event.connectionId,
              requestId: event.requestId,
              bytes: event.bytes,
              durationMs: elapsedMs(startOf(event.startTime, started)),
            }
            if (failed && event.error !== undefined) entry['err'] = event.error
            logger.log(severity, failed ? 'websocket message failed' : 'websocket message handled', entry)
          }
        })
      }
    },
    listen: event =>
      record(() => {
        if (event.type !== 'close' || ignore?.(event) === true || !logger.isLevelEnabled(level)) return
        logger.log(level, 'websocket connection closed', {
          gateway: event.gateway,
          path: event.path,
          connectionId: event.connectionId,
          requestId: event.requestId,
          durationMs: elapsedMs(event.openedAt),
          code: event.code,
          reason: event.reason,
          initiator: event.initiator,
        })
      }),
  }
}

function errorType(error: unknown, outcome: string): string {
  const code = (error as { readonly code?: unknown } | null | undefined)?.code
  return typeof code === 'string' ? code : outcome
}

function startTimeOf(startTime: unknown): { startTime?: number } {
  return typeof startTime === 'number' && Number.isFinite(startTime) && startTime >= 0 && startTime <= performance.now()
    ? { startTime }
    : {}
}
