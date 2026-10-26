import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base'
import type { Plugin } from '@znight/core'

import { context } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base'

/**
 * OpenTelemetry setup of the service. Znight only uses the OpenTelemetry **API**: whatever SDK the
 * application registers records the spans.
 *
 * - The AsyncLocalStorage **context manager** makes the active span follow async calls: the
 *   `SERVER` span of `POST /orders` is the parent of the `PRODUCER` span of the publication, which
 *   writes its `traceparent` into the message headers; the `CONSUMER` span continues that trace,
 *   and every log line carries the `traceId` / `spanId` of the active span.
 * - The **tracer provider** keeps the last spans in memory ({@link RecentSpans}). In production,
 *   export them instead: `spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())]`
 *   (`@opentelemetry/exporter-trace-otlp-http`), or use `@opentelemetry/sdk-node`.
 */
export interface Tracing {
  readonly provider: BasicTracerProvider
  readonly spans: RecentSpans
  /** Shuts the tracer provider down when the application is disposed: put it first in `plugins`. */
  readonly plugin: Plugin
}

/** Registers the context manager (process-wide) and creates the tracer provider. Call it first. */
export function startTracing(options: { readonly maxSpans?: number } = {}): Tracing {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
  const spans = new RecentSpans(options.maxSpans)
  const provider = new BasicTracerProvider({ spanProcessors: [spans] })
  const plugin: Plugin = {
    name: 'tracing',
    // plugins are disposed in reverse order: first in the list, this runs after ObservabilityPlugin
    // flushed the tracer, once nothing can create spans anymore
    async onDispose(ctx) {
      await provider.shutdown()
      context.disable() // unregisters the context manager
      ctx.logger.info('Tracing stopped', { spans: spans.all().length })
    },
  }
  return { provider, spans, plugin }
}

/**
 * A span processor keeping the last `limit` finished spans in memory: a stand-in for a real exporter
 * (OTLP, Jaeger, Zipkin...), handy in tests and demos.
 */
export class RecentSpans implements SpanProcessor {
  readonly #spans: ReadableSpan[] = []

  constructor(private readonly limit = 1000) {}

  onStart(): void {}

  onEnd(span: ReadableSpan): void {
    this.#spans.push(span)
    if (this.#spans.length > this.limit) this.#spans.shift()
  }

  /** Finished spans, oldest first. */
  all(): readonly ReadableSpan[] {
    return [...this.#spans]
  }

  /** Finished spans of one trace, oldest first. */
  trace(traceId: string): readonly ReadableSpan[] {
    return this.#spans.filter(span => span.spanContext().traceId === traceId)
  }

  clear(): void {
    this.#spans.length = 0
  }

  forceFlush(): Promise<void> {
    return Promise.resolve()
  }

  shutdown(): Promise<void> {
    return Promise.resolve()
  }
}
