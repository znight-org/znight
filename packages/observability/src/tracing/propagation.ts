import type { Context, SpanContext, TextMapGetter, TextMapPropagator, TextMapSetter } from '@opentelemetry/api'

import { createTraceState, isSpanContextValid, trace } from '@opentelemetry/api'

/** Header carriers: lower-cased HTTP headers, message headers (any case), arrays of values. */
export type HeaderCarrier = Readonly<Record<string, string | readonly string[] | undefined>>

/** Reads headers case-insensitively (exact key first, which is the common, fast path). */
export const headerGetter: TextMapGetter<HeaderCarrier> = {
  keys: carrier => Object.keys(carrier),
  get: (carrier, key) => {
    const exact = carrier[key]
    if (exact !== undefined) return exact as string | string[]
    const lower = key.toLowerCase()
    for (const name of Object.keys(carrier)) {
      if (name.toLowerCase() === lower) return carrier[name] as string | string[] | undefined
    }
    return undefined
  },
}

/** Writes headers into a plain record. */
export const headerSetter: TextMapSetter<Record<string, string>> = {
  set: (carrier, key, value) => {
    carrier[key] = value
  },
}

const TRACEPARENT = 'traceparent'
const TRACESTATE = 'tracestate'
const TRACEPARENT_PATTERN = /^([\da-f]{2})-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})(-.*)?$/
const INVALID_TRACE_ID = '00000000000000000000000000000000'
const INVALID_SPAN_ID = '0000000000000000'

/** Formats a span context as a W3C `traceparent` value (`00-<trace-id>-<span-id>-<flags>`). */
export function formatTraceparent(spanContext: SpanContext): string {
  return `00-${spanContext.traceId}-${spanContext.spanId}-${(spanContext.traceFlags & 0xff).toString(16).padStart(2, '0')}`
}

/** Parses a W3C `traceparent` value (Trace Context Level 1/2 rules), `undefined` when invalid. */
export function parseTraceparent(value: string): SpanContext | undefined {
  const match = TRACEPARENT_PATTERN.exec(value.trim())
  if (match === null) return undefined
  const [, version, traceId, spanId, flags, rest] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string?,
  ]
  // version ff is forbidden; version 00 has exactly four fields; future versions may add fields
  if (version === 'ff' || (version === '00' && rest !== undefined)) return undefined
  if (traceId === INVALID_TRACE_ID || spanId === INVALID_SPAN_ID) return undefined
  return { traceId, spanId, traceFlags: Number.parseInt(flags, 16), isRemote: true }
}

/**
 * Minimal W3C Trace Context propagator (`traceparent` / `tracestate`). Used when no global
 * propagator is registered, so that incoming trace ids are honoured (and appear in logs) even
 * without an OpenTelemetry SDK.
 */
export class W3CTraceContextFallback implements TextMapPropagator {
  inject(context: Context, carrier: unknown, setter: TextMapSetter): void {
    const spanContext = trace.getSpanContext(context)
    if (spanContext === undefined || !isSpanContextValid(spanContext)) return
    setter.set(carrier, TRACEPARENT, formatTraceparent(spanContext))
    const traceState = spanContext.traceState?.serialize()
    if (traceState !== undefined && traceState !== '') setter.set(carrier, TRACESTATE, traceState)
  }

  extract(context: Context, carrier: unknown, getter: TextMapGetter): Context {
    const header = first(getter.get(carrier, TRACEPARENT))
    if (header === undefined) return context
    const spanContext = parseTraceparent(header)
    if (spanContext === undefined) return context
    const state = getter.get(carrier, TRACESTATE)
    const rawState = Array.isArray(state) ? state.join(',') : state
    if (typeof rawState === 'string' && rawState !== '') spanContext.traceState = createTraceState(rawState)
    return trace.setSpanContext(context, spanContext)
  }

  fields(): string[] {
    return [TRACEPARENT, TRACESTATE]
  }
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}
