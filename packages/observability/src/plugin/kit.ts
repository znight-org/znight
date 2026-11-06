import type { HookListener, HookWrapper, PluginContext } from '@znight/core'
import type { MetricsOptions, ObservabilityOptions, TracingOptions } from './options.ts'

import { ErrorCode, ZnightError } from '@znight/core'

import { logGraphQLOperations, measureGraphQLOperations, traceGraphQLOperations } from '../graphql/operations.ts'
import { LoggedInterceptor } from '../interceptors/logged.ts'
import { MetricInterceptor } from '../interceptors/metric.ts'
import { TracedInterceptor } from '../interceptors/traced.ts'
import { composeWrappers } from '../internal/hooks.ts'
import { toCoreLogger } from '../logging/core-logger.ts'
import { Logger } from '../logging/logger.ts'
import { logHttpRequests, logMessages } from '../logging/requests.ts'
import { measureHttpRequests, measureMessages } from '../metrics/hooks.ts'
import { MetricsRegistry } from '../metrics/registry.ts'
import { MetricsServer } from '../metrics/server.ts'
import { logJobs, measureJobs, traceJobs } from '../schedule/jobs.ts'
import { type MessagePublishWrapper, traceHttpRequests, traceMessagePublish, traceMessages } from '../tracing/hooks.ts'
import { Tracer } from '../tracing/tracer.ts'
import { logWebSocket, measureWebSocketMessages, traceWebSocketMessages } from '../websocket/gateways.ts'

/** Everything the plugin builds from its options. */
export interface ObservabilityKit {
  readonly logger: Logger
  readonly tracer: Tracer
  readonly metrics: MetricsRegistry | undefined
  /** Why `metrics` is undefined. */
  readonly metricsUnavailable: ZnightError | undefined
  readonly server: MetricsServer | undefined
  readonly loggedInterceptor: LoggedInterceptor
  readonly tracedInterceptor: TracedInterceptor
  readonly metricInterceptor: MetricInterceptor
  /** Combined `http:request` wrapper (tracing → metrics → logs), if any feature is enabled. */
  readonly http: HookWrapper<'http:request'> | undefined
  /** Combined `messaging:message` wrapper (tracing → metrics → logs), if any feature is enabled. */
  readonly messaging: HookWrapper<'messaging:message'> | undefined
  /** `messaging:publish` wrapper (producer span + trace context injection), if enabled. */
  readonly publish: MessagePublishWrapper | undefined
  /** Combined `schedule:run` wrapper for executed runs (tracing → metrics → logs), if any feature is enabled. */
  readonly schedule: HookWrapper<'schedule:run'> | undefined
  /** `schedule:run` listener for every occurrence (counters, logs of occurrences that did not run). */
  readonly scheduleListener: HookListener<'schedule:run'> | undefined
  /** Combined `graphql:operation` wrapper (tracing → metrics → logs), if any feature is enabled. */
  readonly graphql: HookWrapper<'graphql:operation'> | undefined
  /** Combined `websocket:message` wrapper (tracing → metrics → logs), if any feature is enabled. */
  readonly websocket: HookWrapper<'websocket:message'> | undefined
  /** `websocket:connection` listener (connection metrics and logs), if any feature is enabled. */
  readonly websocketListener: HookListener<'websocket:connection'> | undefined
}

/** Builds the logger, tracer, registry, interceptors and hook wrappers from resolved options. */
export function buildKit(options: ObservabilityOptions, ctx: PluginContext): ObservabilityKit {
  const {
    requests,
    messages,
    jobs,
    graphql: graphqlLogs,
    websocket: websocketLogs,
    replaceCoreLogger,
    ...loggerOptions
  } = options.logging ?? {}
  const logger = new Logger({ ...loggerOptions, scope: ctx.container })

  const tracing = sectionOf<TracingOptions>(options.tracing)
  const {
    http: httpTracing,
    messaging: messagingTracing,
    publish: publishTracing,
    schedule: scheduleTracing,
    graphql: graphqlTracing,
    websocket: websocketTracing,
    ...tracerOptions
  } = tracing ?? {}
  const tracer = new Tracer(tracerOptions)

  const metricsSection = metricsSectionOf(options.metrics)
  const {
    server: serverOptions,
    http: httpMetrics,
    messaging: messagingMetrics,
    schedule: scheduleMetrics,
    graphql: graphqlMetrics,
    websocket: websocketMetrics,
    ...registryOptions
  } = metricsSection.options ?? {}
  const metrics = metricsSection.options === undefined ? undefined : new MetricsRegistry(registryOptions)
  const server =
    metrics === undefined || serverOptions === false
      ? undefined
      : new MetricsServer(metrics, serverOptions === true ? {} : serverOptions)

  const coreLogger = logger.child({ component: 'znight' })
  const jobLogs = jobs === false ? undefined : logJobs(logger, objectOf(jobs))
  const jobMetrics =
    metrics !== undefined && scheduleMetrics !== false ? measureJobs(metrics, objectOf(scheduleMetrics)) : undefined
  const wsMetrics =
    metrics !== undefined && websocketMetrics !== false
      ? measureWebSocketMessages(metrics, objectOf(websocketMetrics))
      : undefined
  const wsLogs = websocketLogs === false ? undefined : logWebSocket(logger, objectOf(websocketLogs))
  const kit: ObservabilityKit = {
    logger,
    tracer,
    metrics,
    metricsUnavailable: metricsSection.reason,
    server,
    loggedInterceptor: new LoggedInterceptor(logger),
    tracedInterceptor: new TracedInterceptor(tracer),
    metricInterceptor: new MetricInterceptor(metrics, {
      onError: error => coreLogger.error('@Metric() cannot record its metric', { err: error }),
    }),
    http: composeWrappers<'http:request'>([
      tracing !== undefined && httpTracing !== false ? traceHttpRequests(tracer, objectOf(httpTracing)) : undefined,
      metrics !== undefined && httpMetrics !== false ? measureHttpRequests(metrics, objectOf(httpMetrics)) : undefined,
      requests === false ? undefined : logHttpRequests(logger, objectOf(requests)),
    ]),
    messaging: composeWrappers<'messaging:message'>([
      tracing !== undefined && messagingTracing !== false
        ? traceMessages(tracer, objectOf(messagingTracing))
        : undefined,
      metrics !== undefined && messagingMetrics !== false
        ? measureMessages(metrics, objectOf(messagingMetrics))
        : undefined,
      messages === false ? undefined : logMessages(logger, objectOf(messages)),
    ]),
    publish:
      tracing !== undefined && publishTracing !== false
        ? traceMessagePublish(tracer, objectOf(publishTracing))
        : undefined,
    schedule: composeWrappers<'schedule:run'>([
      tracing !== undefined && scheduleTracing !== false ? traceJobs(tracer, objectOf(scheduleTracing)) : undefined,
      jobMetrics?.wrap,
      jobLogs?.wrap,
    ]),
    scheduleListener: composeListeners<'schedule:run'>([jobMetrics?.listen, jobLogs?.listen]),
    // logs are opt-in: the HTTP request carrying an operation is logged already
    graphql: composeWrappers<'graphql:operation'>([
      tracing !== undefined && graphqlTracing !== false
        ? traceGraphQLOperations(tracer, objectOf(graphqlTracing))
        : undefined,
      metrics !== undefined && graphqlMetrics !== false
        ? measureGraphQLOperations(metrics, objectOf(graphqlMetrics))
        : undefined,
      graphqlLogs === undefined || graphqlLogs === false
        ? undefined
        : logGraphQLOperations(logger, objectOf(graphqlLogs)),
    ]),
    websocket: composeWrappers<'websocket:message'>([
      tracing !== undefined && websocketTracing !== false
        ? traceWebSocketMessages(tracer, objectOf(websocketTracing))
        : undefined,
      wsMetrics?.wrap,
      wsLogs?.wrap,
    ]),
    websocketListener: composeListeners<'websocket:connection'>([wsMetrics?.listen, wsLogs?.listen]),
  }
  if (replaceCoreLogger !== false) ctx.app.setLogger(toCoreLogger(coreLogger))
  if (metricsSection.reason !== undefined && metricsSection.options === undefined && options.metrics === undefined) {
    coreLogger.debug('Metrics disabled: the optional peer dependency "prom-client" is not installed')
  }
  return kit
}

/** `undefined` when disabled, the options object otherwise. */
function sectionOf<T extends object>(value: boolean | T | undefined): T | undefined {
  if (value === false) return undefined
  return value === undefined || value === true ? ({} as T) : value
}

function objectOf<T extends object>(value: boolean | T | undefined): T {
  return value === undefined || typeof value === 'boolean' ? ({} as T) : value
}

function metricsSectionOf(value: boolean | MetricsOptions | undefined): {
  readonly options: MetricsOptions | undefined
  readonly reason: ZnightError | undefined
} {
  if (value === false) {
    return {
      options: undefined,
      reason: new ZnightError(ErrorCode.MissingProvider, 'MetricsRegistry is unavailable: metrics are disabled', {
        hints: ['Enable them: ObservabilityPlugin.configure({ metrics: true })'],
      }),
    }
  }
  if (value === undefined && !MetricsRegistry.isAvailable()) {
    return {
      options: undefined,
      reason: new ZnightError(
        ErrorCode.MissingProvider,
        'MetricsRegistry is unavailable: the optional peer dependency "prom-client" is not installed',
        { hints: ['Install it: bun add prom-client (or npm install prom-client)'] },
      ),
    }
  }
  return { options: value === undefined || value === true ? {} : value, reason: undefined }
}

/** Calls every listener in order; `undefined` when there is none. */
function composeListeners<K extends 'schedule:run' | 'websocket:connection'>(
  listeners: readonly (HookListener<K> | undefined)[],
): HookListener<K> | undefined {
  const active = listeners.filter((listener): listener is HookListener<K> => listener !== undefined)
  if (active.length === 0) return undefined
  return event => {
    for (const listener of active) listener(event)
  }
}
