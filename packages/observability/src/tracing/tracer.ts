import type {
  Context,
  Tracer as OtelTracer,
  Span,
  SpanOptions,
  TextMapPropagator,
  TracerProvider,
} from '@opentelemetry/api'
import type { HeaderCarrier } from './propagation.ts'

import { isSpanContextValid, context as otelContext, propagation, SpanStatusCode, trace } from '@opentelemetry/api'

import { errorMessage, errorType, isThenable } from '../internal/errors.ts'
import { headerGetter, headerSetter, W3CTraceContextFallback } from './propagation.ts'
import { SemanticAttributes } from './semconv.ts'

/** Default instrumentation scope name of the spans created by Znight. */
export const TRACER_NAME = '@znight/observability'

/** Options of {@link Tracer}. */
export interface TracerOptions {
  /** Instrumentation scope name. Default: `@znight/observability`. */
  readonly name?: string
  /** Instrumentation scope version. */
  readonly version?: string
  /**
   * Tracer provider. Default: the global one (`trace.getTracerProvider()`), i.e. whatever SDK the
   * application registers (`NodeSDK`, `NodeTracerProvider.register()`...), even after this tracer is
   * created. Without SDK, spans are no-ops (but incoming trace ids still reach the logs).
   */
  readonly tracerProvider?: TracerProvider
  /**
   * Propagator used to read/write trace context headers. Default: the global propagator when one
   * is registered, otherwise a built-in W3C Trace Context (`traceparent`/`tracestate`) propagator.
   */
  readonly propagator?: TextMapPropagator
}

/** Options of {@link Tracer.withSpan}. */
export interface WithSpanOptions extends SpanOptions {
  /** Parent context. Default: the active context. */
  readonly context?: Context
}

/** Identifiers of the active span. */
export interface TraceContextInfo {
  readonly traceId: string
  readonly spanId: string
  readonly traceFlags: number
  readonly sampled: boolean
}

const FALLBACK_PROPAGATOR = new W3CTraceContextFallback()

/**
 * Thin wrapper over the OpenTelemetry API tracer: injectable, SDK-agnostic, with helpers that
 * handle span lifecycle (end, errors) and context propagation.
 *
 * ```ts
 * await tracer.withSpan('payment.capture', async span => {
 *   span.setAttribute('payment.provider', 'stripe')
 *   return gateway.capture(order)
 * })
 * ```
 */
export class Tracer {
  /** The underlying OpenTelemetry tracer. */
  readonly otel: OtelTracer
  readonly #provider: TracerProvider | undefined
  readonly #propagator: TextMapPropagator | undefined

  constructor(options: TracerOptions = {}) {
    const name = options.name ?? TRACER_NAME
    this.#provider = options.tracerProvider
    this.#propagator = options.propagator
    this.otel = (this.#provider ?? trace.getTracerProvider()).getTracer(name, options.version)
  }

  /** Starts a span (not made active, not ended: see {@link withSpan}). */
  startSpan(name: string, options?: SpanOptions, context?: Context): Span {
    return this.otel.startSpan(name, options, context)
  }

  /**
   * Runs `fn` in a new active span and ends it when `fn` returns, or when the promise it returns
   * settles. A thrown error / rejection is recorded on the span (status `ERROR`) and rethrown.
   * Synchronous functions stay synchronous.
   */
  withSpan<T>(name: string, fn: (span: Span) => T, options: WithSpanOptions = {}): T {
    const { context: parent = otelContext.active(), ...spanOptions } = options
    const span = this.otel.startSpan(name, spanOptions, parent)
    let result: T
    try {
      result = otelContext.with(trace.setSpan(parent, span), fn, undefined, span)
    } catch (error) {
      recordSpanError(span, error)
      span.end()
      throw error
    }
    if (!isThenable(result)) {
      span.end()
      return result
    }
    return Promise.resolve(result).then(
      value => {
        span.end()
        return value
      },
      (error: unknown) => {
        recordSpanError(span, error)
        span.end()
        throw error
      },
    ) as T
  }

  /** The active span, if any. */
  activeSpan(): Span | undefined {
    return trace.getActiveSpan()
  }

  /** Identifiers of the active span (valid span context only). */
  traceContext(context: Context = otelContext.active()): TraceContextInfo | undefined {
    const spanContext = trace.getSpanContext(context)
    if (spanContext === undefined || !isSpanContextValid(spanContext)) return undefined
    return {
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
      traceFlags: spanContext.traceFlags,
      sampled: (spanContext.traceFlags & 1) === 1,
    }
  }

  /** Runs `fn` with `context` active. */
  withContext<T>(context: Context, fn: () => T): T {
    return otelContext.with(context, fn)
  }

  /**
   * Writes the trace context of `context` (default: the active one) into `carrier` (`traceparent`,
   * `tracestate`...), e.g. the headers of an outgoing request or message. Returns `carrier`.
   */
  inject<C extends Record<string, string>>(carrier: C, context: Context = otelContext.active()): C {
    this.#currentPropagator().inject(context, carrier, headerSetter)
    return carrier
  }

  /** Reads a trace context from `carrier` (incoming headers) on top of `context` (default: the active one). */
  extract(carrier: HeaderCarrier, context: Context = otelContext.active()): Context {
    return this.#currentPropagator().extract(context, carrier, headerGetter)
  }

  /**
   * Exports the spans buffered by the tracer provider (`forceFlush()`), when it supports it.
   * Never rejects.
   */
  async forceFlush(): Promise<void> {
    let provider: unknown = this.#provider ?? trace.getTracerProvider()
    const delegate = (provider as { getDelegate?: () => unknown }).getDelegate?.()
    if (delegate !== undefined) provider = delegate
    const flush = (provider as { forceFlush?: () => Promise<void> }).forceFlush
    if (typeof flush !== 'function') return
    try {
      await flush.call(provider)
    } catch {
      // exporter failures are reported by the SDK itself
    }
  }

  #currentPropagator(): TextMapPropagator {
    if (this.#propagator !== undefined) return this.#propagator
    // a global propagator registered by an SDK advertises its fields; the no-op one has none
    return propagation.fields().length > 0 ? GLOBAL_PROPAGATOR : FALLBACK_PROPAGATOR
  }
}

/** Delegates to the global propagation API (resolved at call time). */
const GLOBAL_PROPAGATOR: TextMapPropagator = {
  inject: (context, carrier, setter) => propagation.inject(context, carrier, setter),
  extract: (context, carrier, getter) => propagation.extract(context, carrier, getter),
  fields: () => propagation.fields(),
}

/** Records `error` on `span`: exception event, `ERROR` status and `error.type`. */
export function recordSpanError(span: Span, error: unknown): void {
  span.recordException(error instanceof Error ? error : { name: errorType(error), message: errorMessage(error) })
  span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(error) })
  span.setAttribute(SemanticAttributes.ERROR_TYPE, errorType(error))
}
