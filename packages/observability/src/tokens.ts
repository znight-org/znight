import type { TypedToken } from '@znight/core'
import type { LoggedInterceptor } from './interceptors/logged.ts'
import type { MetricInterceptor } from './interceptors/metric.ts'
import type { TracedInterceptor } from './interceptors/traced.ts'
import type { Logger } from './logging/logger.ts'
import type { MetricsRegistry } from './metrics/registry.ts'
import type { Tracer } from './tracing/tracer.ts'

/**
 * Container tokens of the externals provided by `ObservabilityPlugin` (declared in this package's
 * `package.json#znight.provides`, so the compiler binds `Logger`, `Tracer`... parameters to them).
 */
export const ObservabilityTokens: {
  readonly Logger: TypedToken<Logger>
  readonly MetricsRegistry: TypedToken<MetricsRegistry>
  readonly Tracer: TypedToken<Tracer>
  readonly LoggedInterceptor: TypedToken<LoggedInterceptor>
  readonly TracedInterceptor: TypedToken<TracedInterceptor>
  readonly MetricInterceptor: TypedToken<MetricInterceptor>
} = Object.freeze({
  Logger: '@znight/observability#Logger',
  MetricsRegistry: '@znight/observability#MetricsRegistry',
  Tracer: '@znight/observability#Tracer',
  LoggedInterceptor: '@znight/observability#LoggedInterceptor',
  TracedInterceptor: '@znight/observability#TracedInterceptor',
  MetricInterceptor: '@znight/observability#MetricInterceptor',
})

/**
 * Scope token under which `@znight/http` stores the id of the current request. Read (duck-typed,
 * without depending on `@znight/http`) to add `requestId` to every log entry.
 */
export const REQUEST_ID_TOKEN = '@znight/http#RequestId'
