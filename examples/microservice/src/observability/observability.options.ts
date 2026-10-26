import type { ObservabilityOptions } from '@znight/observability'
import type { ObservabilityConfig } from '../config/observability.config.js'
import type { Tracing } from './tracing.js'

/**
 * Options of ObservabilityPlugin, computed from the configuration:
 *
 * - **logs**: one JSON line per entry on stdout, enriched with `requestId`, `traceId` and `spanId`;
 *   one entry per HTTP request and per message delivery;
 * - **metrics** (`prom-client`) on a dedicated server (`METRICS_PORT`, `/metrics`): HTTP RED metrics,
 *   messaging metrics (`messaging_messages_processed_total{queue,consumer,type,outcome}`,
 *   `messaging_process_duration_seconds`, `messaging_active_messages`), process metrics and the
 *   `@Metric()` metrics of the services. An object requires `prom-client`: a missing peer fails the
 *   boot instead of silently disabling the metrics;
 * - **traces**: `SERVER` / `PRODUCER` / `CONSUMER` spans with W3C trace context propagation, recorded
 *   by the tracer provider of `tracing.ts`.
 */
export function observabilityOptions(config: ObservabilityConfig, tracing: Tracing): ObservabilityOptions {
  // probes are frequent and not worth a log line nor a trace (they are still measured)
  const isProbe = (event: { readonly path: string }): boolean => event.path === '/health'
  return {
    logging: { level: config.logLevel, name: config.serviceName, requests: { ignore: isProbe } },
    metrics: {
      defaultLabels: { service: config.serviceName },
      server: { port: config.metricsPort },
    },
    tracing: { tracerProvider: tracing.provider, http: { ignore: isProbe } },
  }
}
