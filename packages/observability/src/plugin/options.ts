import type { EventsInstrumentationOptions } from '../events/events.ts'
import type { GraphQLMetricsOptions, GraphQLOperationLogOptions, GraphQLTracingOptions } from '../graphql/operations.ts'
import type { LoggerOptions } from '../logging/logger.ts'
import type { HttpRequestLogOptions, MessageLogOptions } from '../logging/requests.ts'
import type { HttpMetricsOptions, MessagingMetricsOptions } from '../metrics/hooks.ts'
import type { MetricsRegistryOptions } from '../metrics/registry.ts'
import type { MetricsServerOptions } from '../metrics/server.ts'
import type { JobLogOptions, ScheduleMetricsOptions, ScheduleTracingOptions } from '../schedule/jobs.ts'
import type { HttpTracingOptions, MessagePublishTracingOptions, MessagingTracingOptions } from '../tracing/hooks.ts'
import type { TracerOptions } from '../tracing/tracer.ts'
import type { WebSocketLogOptions, WebSocketMetricsOptions, WebSocketTracingOptions } from '../websocket/gateways.ts'

/** `logging` options of `ObservabilityPlugin.configure()`. */
export interface LoggingOptions extends Omit<LoggerOptions, 'scope'> {
  /** One entry per HTTP request (`http:request` hook). Default: `true`. */
  readonly requests?: boolean | HttpRequestLogOptions
  /** One entry per message delivery (`messaging:message` hook). Default: `true`. */
  readonly messages?: boolean | MessageLogOptions
  /** One entry per scheduled run (`schedule:run` hook of `@znight/schedule`). Default: `true`. */
  readonly jobs?: boolean | JobLogOptions
  /** One entry per GraphQL operation (`graphql:operation` hook of `@znight/graphql`). Default: `false`. */
  readonly graphql?: boolean | GraphQLOperationLogOptions
  /** One `debug` entry per event publication (`events:publish` hook of `@znight/events`). Default: `true`. */
  readonly events?: boolean | EventsInstrumentationOptions
  /**
   * One entry per closed WebSocket connection and per failed message (`websocket:*` hooks of
   * `@znight/websocket`); `{ messages: true }` adds a `debug` entry per message. Default: `true`.
   */
  readonly websocket?: boolean | WebSocketLogOptions
  /**
   * Route the framework's own logs (core, plugins) through the logger, with `component: 'znight'`
   * (`app.setLogger()`). Default: `true`.
   */
  readonly replaceCoreLogger?: boolean
}

/** `metrics` options of `ObservabilityPlugin.configure()`. */
export interface MetricsOptions extends MetricsRegistryOptions {
  /** Dedicated `/metrics` HTTP server (port 9464 by default), started in `onStart`. `false` disables it. Default: `true`. */
  readonly server?: boolean | MetricsServerOptions
  /** HTTP RED metrics (`http:request` hook). Default: `true`. */
  readonly http?: boolean | HttpMetricsOptions
  /** Consumer metrics (`messaging:message` hook). Default: `true`. */
  readonly messaging?: boolean | MessagingMetricsOptions
  /** Scheduled job metrics (`schedule:run` hook of `@znight/schedule`). Default: `true`. */
  readonly schedule?: boolean | ScheduleMetricsOptions
  /** GraphQL operation metrics (`graphql:operation` hook of `@znight/graphql`). Default: `true`. */
  readonly graphql?: boolean | GraphQLMetricsOptions
  /** WebSocket connection and message metrics (`websocket:*` hooks of `@znight/websocket`). Default: `true`. */
  readonly websocket?: boolean | WebSocketMetricsOptions
  /** Application event metrics (`events:*` hooks of `@znight/events`). Default: `true`. */
  readonly events?: boolean | EventsInstrumentationOptions
}

/** `tracing` options of `ObservabilityPlugin.configure()`. */
export interface TracingOptions extends TracerOptions {
  /** A `SERVER` span per HTTP request (`http:request` hook). Default: `true`. */
  readonly http?: boolean | HttpTracingOptions
  /** A `CONSUMER` span per message delivery (`messaging:message` hook). Default: `true`. */
  readonly messaging?: boolean | MessagingTracingOptions
  /**
   * A `PRODUCER` span per published message, whose trace context is written into the message
   * headers (`messaging:publish` hook of `@znight/messaging`). Default: `true`.
   */
  readonly publish?: boolean | MessagePublishTracingOptions
  /**
   * An `INTERNAL` span per scheduled run (`schedule:run` hook of `@znight/schedule`), the root of a
   * new trace except for manual runs. Default: `true`.
   */
  readonly schedule?: boolean | ScheduleTracingOptions
  /**
   * An `INTERNAL` span per GraphQL operation, child of the HTTP request span (`graphql:operation`
   * hook of `@znight/graphql`). Default: `true`.
   */
  readonly graphql?: boolean | GraphQLTracingOptions
  /**
   * A `SERVER` span per inbound WebSocket message, the root of a new trace linked to the handshake
   * span (`websocket:message` hook of `@znight/websocket`). Default: `true`.
   */
  readonly websocket?: boolean | WebSocketTracingOptions
  /**
   * An `INTERNAL` span per event publication and per listener (`events:*` hooks of
   * `@znight/events`). Default: `true`.
   */
  readonly events?: boolean | EventsInstrumentationOptions
}

/** Options of `ObservabilityPlugin.configure()`. */
export interface ObservabilityOptions {
  /** Logger settings (level, redaction, transports...) and request/message logs. */
  readonly logging?: LoggingOptions
  /**
   * Prometheus metrics. Default: enabled when the optional peer `prom-client` is installed.
   * `false` disables them (`@Metric()` methods then run unmeasured); `true` or an object requires
   * `prom-client`.
   */
  readonly metrics?: boolean | MetricsOptions
  /**
   * Automatic spans for HTTP requests, messages, scheduled runs and GraphQL operations. `false`
   * disables them (the injectable `Tracer` and `@Traced()` keep working). Spans are recorded by
   * whatever OpenTelemetry SDK the application registers. Default: `true`.
   */
  readonly tracing?: boolean | TracingOptions
}
