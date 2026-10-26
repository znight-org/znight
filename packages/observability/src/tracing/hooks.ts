import type { Attributes, Span } from '@opentelemetry/api'
import type { HookWrapper, HttpRequestEvent, MessageDeliveryEvent } from '@znight/core'
import type { Tracer } from './tracer.ts'

import { isSpanContextValid, context as otelContext, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'

import { normalizeMethod, OTHER_METHOD } from '../internal/hooks.ts'
import { guard } from '../internal/safe.ts'
import { formatTraceparent } from './propagation.ts'
import { SemanticAttributes as Attr } from './semconv.ts'
import { recordSpanError } from './tracer.ts'

/** Default response header carrying the trace context of a request (W3C Trace Context Level 2). */
export const TRACE_RESPONSE_HEADER = 'traceresponse'

/** Options of {@link traceHttpRequests}. */
export interface HttpTracingOptions {
  /** Requests that are not traced. */
  readonly ignore?: (event: HttpRequestEvent) => boolean
  /**
   * Response header receiving the server span context (`00-<trace-id>-<span-id>-<flags>`), so
   * clients can correlate. Default: `traceresponse`; `false` disables it.
   */
  readonly responseHeader?: string | false
}

/** Options of {@link traceMessages}. */
export interface MessagingTracingOptions {
  /** Deliveries that are not traced. */
  readonly ignore?: (event: MessageDeliveryEvent) => boolean
  /** `messaging.system` attribute (`rabbitmq`, `aws_sqs`, `kafka`...). Default: not set. */
  readonly system?: string
}

/**
 * `http:request` hook wrapper creating a `SERVER` span per request, child of the W3C trace context
 * found in the request headers (`traceparent`), active while the request is handled (so logs and
 * nested spans are correlated). Attributes follow the stable HTTP semantic conventions; 5xx
 * responses and unhandled errors set the span status to `ERROR` and record the exception.
 */
export function traceHttpRequests(tracer: Tracer, options: HttpTracingOptions = {}): HookWrapper<'http:request'> {
  const responseHeader = options.responseHeader ?? TRACE_RESPONSE_HEADER
  const ignore = options.ignore
  const record = guard('Recording an HTTP span')
  return (event, next) => {
    if (ignore?.(event) === true) return next()
    const parent = tracer.extract(event.headers)
    const method = normalizeMethod(event.method)
    const attributes: Attributes = {
      [Attr.HTTP_REQUEST_METHOD]: method,
      [Attr.URL_PATH]: event.path,
      [Attr.ZNIGHT_REQUEST_ID]: event.requestId,
    }
    if (method === OTHER_METHOD) attributes[Attr.HTTP_REQUEST_METHOD_ORIGINAL] = event.method
    if (event.route !== undefined) attributes[Attr.HTTP_ROUTE] = event.route
    addRequestAttributes(attributes, event.headers)
    const target = method === OTHER_METHOD ? 'HTTP' : method
    const span = tracer.otel.startSpan(
      event.route === undefined ? target : `${target} ${event.route}`,
      { kind: SpanKind.SERVER, attributes, ...startTimeOf(event.startTime) },
      parent,
    )
    if (responseHeader !== false) {
      const spanContext = span.spanContext()
      if (isSpanContextValid(spanContext)) event.responseHeaders[responseHeader] = formatTraceparent(spanContext)
    }
    return otelContext.with(trace.setSpan(parent, span), async () => {
      let failed = false
      let thrown: unknown
      try {
        return await next()
      } catch (error) {
        failed = true
        thrown = error
        throw error
      } finally {
        record(() => finishHttpSpan(span, event, failed, thrown))
      }
    })
  }
}

function finishHttpSpan(span: Span, event: HttpRequestEvent, failed: boolean, thrown: unknown): void {
  const status = event.status ?? (failed ? 500 : undefined)
  if (status !== undefined) span.setAttribute(Attr.HTTP_RESPONSE_STATUS_CODE, status)
  // server spans: 4xx are client errors, the span status stays unset
  if (status === undefined || status >= 500) {
    const error = event.error ?? thrown
    if (error !== undefined) recordSpanError(span, error)
    else if (status !== undefined) {
      span.setStatus({ code: SpanStatusCode.ERROR })
      span.setAttribute(Attr.ERROR_TYPE, String(status))
    }
  }
  span.end()
}

/** The producer's start time (a `performance.now()` value, accepted by OpenTelemetry) when valid. */
function startTimeOf(startTime: unknown): { startTime?: number } {
  return typeof startTime === 'number' && Number.isFinite(startTime) && startTime >= 0 && startTime <= performance.now()
    ? { startTime }
    : {}
}

function addRequestAttributes(attributes: Attributes, headers: HttpRequestEvent['headers']): void {
  const userAgent = headers['user-agent']
  if (userAgent !== undefined) attributes[Attr.USER_AGENT_ORIGINAL] = userAgent
  const host = headers['x-forwarded-host'] ?? headers['host']
  if (host !== undefined) {
    const { address, port } = splitHost(host.split(',')[0]?.trim() ?? host)
    if (address !== '') attributes[Attr.SERVER_ADDRESS] = address
    if (port !== undefined) attributes[Attr.SERVER_PORT] = port
  }
  const proto = headers['x-forwarded-proto']
  if (proto !== undefined) attributes[Attr.URL_SCHEME] = proto.split(',')[0]?.trim() ?? proto
  const forwarded = headers['x-forwarded-for']
  if (forwarded !== undefined) {
    const client = forwarded.split(',')[0]?.trim()
    if (client !== undefined && client !== '') attributes[Attr.CLIENT_ADDRESS] = client
  }
}

function splitHost(host: string): { address: string; port: number | undefined } {
  const match = /^(\[[^\]]*\]|[^:]*)(?::(\d+))?$/.exec(host)
  if (match === null) return { address: host, port: undefined }
  const port = match[2] === undefined ? undefined : Number(match[2])
  return { address: match[1] ?? host, port: port !== undefined && Number.isInteger(port) ? port : undefined }
}

/**
 * `messaging:message` hook wrapper creating a `CONSUMER` span (`process <queue>`) per delivery,
 * child of the trace context found in the message headers, active while the handler runs.
 * Retries, dead letters and unhandled errors set the span status to `ERROR`.
 */
export function traceMessages(tracer: Tracer, options: MessagingTracingOptions = {}): HookWrapper<'messaging:message'> {
  const ignore = options.ignore
  const record = guard('Recording a messaging span')
  return (event, next) => {
    if (ignore?.(event) === true) return next()
    const parent = tracer.extract(event.headers)
    const attributes: Attributes = {
      [Attr.MESSAGING_OPERATION_NAME]: 'process',
      [Attr.MESSAGING_OPERATION_TYPE]: 'process',
      [Attr.MESSAGING_DESTINATION_NAME]: event.queue,
      [Attr.MESSAGING_MESSAGE_ID]: event.messageId,
      [Attr.ZNIGHT_CONSUMER]: event.consumer,
      [Attr.ZNIGHT_ATTEMPT]: event.attempt,
    }
    if (options.system !== undefined) attributes[Attr.MESSAGING_SYSTEM] = options.system
    if (event.type !== undefined) attributes[Attr.ZNIGHT_MESSAGE_TYPE] = event.type
    if (event.handler !== undefined) attributes[Attr.ZNIGHT_HANDLER] = event.handler
    const span = tracer.otel.startSpan(
      `process ${event.queue}`,
      { kind: SpanKind.CONSUMER, attributes, ...startTimeOf(event.startTime) },
      parent,
    )
    return otelContext.with(trace.setSpan(parent, span), async () => {
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
          const outcome = event.outcome ?? (failed ? 'error' : 'ack')
          span.setAttribute(Attr.ZNIGHT_OUTCOME, outcome)
          if (outcome !== 'ack') {
            const error = event.error ?? thrown
            if (error === undefined) {
              span.setStatus({ code: SpanStatusCode.ERROR, message: `message ${outcome}` })
            } else {
              recordSpanError(span, error)
            }
          }
          span.end()
        })
      }
    })
  }
}

/**
 * Minimal shape of the `messaging:publish` hook event used here; `MessagePublishEvent` from
 * `@znight/core` satisfies it.
 */
export interface MessagePublishEventLike {
  readonly queue: string
  readonly type?: string | undefined
  readonly messageId?: string | undefined
  /** Headers sent with the message, mutable until `next()` is called. */
  readonly headers: Record<string, string>
  readonly startTime?: number | undefined
  error?: unknown
}

/** A `messaging:publish` hook wrapper. */
export type MessagePublishWrapper = (event: MessagePublishEventLike, next: () => Promise<unknown>) => Promise<unknown>

/** Options of {@link traceMessagePublish}. */
export interface MessagePublishTracingOptions {
  /** Publications that are not traced (their headers are not touched). */
  readonly ignore?: (event: MessagePublishEventLike) => boolean
  /** `messaging.system` attribute. Default: not set. */
  readonly system?: string
}

/**
 * `messaging:publish` hook wrapper (`MessageBroker.publish()` of `@znight/messaging`) creating a
 * `PRODUCER` span (`send <queue>`) and writing its trace context into the message headers
 * (`traceparent`...), so that the consumer span continues the trace.
 */
export function traceMessagePublish(tracer: Tracer, options: MessagePublishTracingOptions = {}): MessagePublishWrapper {
  const ignore = options.ignore
  const record = guard('Recording a publish span')
  return (event, next) => {
    if (ignore?.(event) === true) return next()
    const parent = otelContext.active()
    const attributes: Attributes = {
      [Attr.MESSAGING_OPERATION_NAME]: 'send',
      [Attr.MESSAGING_OPERATION_TYPE]: 'send',
      [Attr.MESSAGING_DESTINATION_NAME]: event.queue,
    }
    if (event.messageId !== undefined) attributes[Attr.MESSAGING_MESSAGE_ID] = event.messageId
    if (event.type !== undefined) attributes[Attr.ZNIGHT_MESSAGE_TYPE] = event.type
    if (options.system !== undefined) attributes[Attr.MESSAGING_SYSTEM] = options.system
    const span = tracer.otel.startSpan(
      `send ${event.queue}`,
      { kind: SpanKind.PRODUCER, attributes, ...startTimeOf(event.startTime) },
      parent,
    )
    const active = trace.setSpan(parent, span)
    if (typeof event.headers === 'object' && event.headers !== null) record(() => tracer.inject(event.headers, active))
    return otelContext.with(active, async () => {
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
          const error = event.error ?? thrown
          if (failed || error !== undefined) recordSpanError(span, error)
          span.end()
        })
      }
    })
  }
}
