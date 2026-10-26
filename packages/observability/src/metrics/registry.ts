import type {
  Counter,
  Gauge,
  Histogram,
  PromClient,
  PromDefaultMetricsConfig,
  PromMetricConfig,
  PromRegistry,
  Summary,
} from './prom.ts'

import { errorMessage, invalidOption } from '../internal/errors.ts'
import { isPeerInstalled, loadOptionalPeer } from '../internal/optional.ts'

/** Options of the default process metrics (`prom-client` `collectDefaultMetrics`). */
export interface DefaultMetricsOptions {
  /** Prefix of the default metric names (after the registry prefix). */
  readonly prefix?: string
  /** Buckets of `nodejs_gc_duration_seconds`. */
  readonly gcDurationBuckets?: readonly number[]
  /** Event loop lag sampling precision, in milliseconds. Default: 10. */
  readonly eventLoopMonitoringPrecision?: number
}

/** Options of {@link MetricsRegistry}. */
export interface MetricsRegistryOptions {
  /** Prefix of every metric created through the registry (`myapp_`). Default: none. */
  readonly prefix?: string
  /** Labels added to every series (`{ service: 'billing' }`). */
  readonly defaultLabels?: Readonly<Record<string, string>>
  /** Collect process metrics (CPU, memory, event loop lag, GC, handles...). Default: `true`. */
  readonly defaultMetrics?: boolean | DefaultMetricsOptions
  /** The `prom-client` module. Default: loaded from the optional peer dependency. */
  readonly client?: PromClient
  /** Registry to use, e.g. `client.register` (the global one). Default: a new, isolated registry. */
  readonly registry?: PromRegistry
}

/** Options of a counter. */
export interface CounterOptions {
  /** Description (`# HELP`). Default: the metric name. */
  readonly help?: string
  /** Names of the labels of the series. Default: none. */
  readonly labelNames?: readonly string[]
}

/** Options of a gauge. */
export type GaugeOptions = CounterOptions

/** Options of a histogram. */
export interface HistogramOptions extends CounterOptions {
  /** Upper bounds of the buckets. Default: `prom-client`'s (`[0.005, ..., 10]`). */
  readonly buckets?: readonly number[]
}

/** Options of a summary. */
export interface SummaryOptions extends CounterOptions {
  /** Quantiles. Default: `[0.01, 0.05, 0.5, 0.9, 0.95, 0.99, 0.999]`. */
  readonly percentiles?: readonly number[]
  /** Sliding window duration. */
  readonly maxAgeSeconds?: number
  /** Number of buckets of the sliding window. */
  readonly ageBuckets?: number
}

/** Kind of a metric. */
export type MetricType = 'counter' | 'gauge' | 'histogram' | 'summary'

interface Registered {
  readonly type: MetricType
  readonly labelNames: readonly string[]
  readonly metric: unknown
}

const CLASS_OF: Readonly<Record<MetricType, 'Counter' | 'Gauge' | 'Histogram' | 'Summary'>> = {
  counter: 'Counter',
  gauge: 'Gauge',
  histogram: 'Histogram',
  summary: 'Summary',
}

/**
 * Prometheus metrics registry, backed by the optional peer dependency
 * [`prom-client`](https://github.com/siimon/prom-client) (`bun add prom-client`). Injectable.
 *
 * Metric factories are idempotent: asking twice for the same name returns the same metric (with a
 * clear error when the type or labels differ), so providers can declare their metrics in their
 * constructor without coordination.
 *
 * ```ts
 * const orders = registry.counter('orders_created_total', { help: 'Orders created', labelNames: ['channel'] })
 * orders.inc({ channel: 'web' })
 * ```
 *
 * @throws ZnightError (ZNIGHT001) when `prom-client` is not installed.
 */
export class MetricsRegistry {
  /** The `prom-client` module. */
  readonly client: PromClient
  /** The underlying `prom-client` registry. */
  readonly registry: PromRegistry
  /** Prefix of every metric name created through this registry. */
  readonly prefix: string
  readonly #metrics = new Map<string, Registered>()

  constructor(options: MetricsRegistryOptions = {}) {
    this.client = options.client ?? loadPromClient()
    this.registry = options.registry ?? new this.client.Registry()
    this.prefix = options.prefix ?? ''
    if (options.defaultLabels !== undefined) this.registry.setDefaultLabels({ ...options.defaultLabels })
    const defaults = options.defaultMetrics ?? true
    if (defaults !== false) this.#collectDefaultMetrics(defaults === true ? {} : defaults)
  }

  /** Whether `prom-client` can be loaded (metrics are enabled by default only when it is installed). */
  static isAvailable(): boolean {
    return isPeerInstalled('prom-client')
  }

  /** Content type of {@link metrics} (Prometheus text exposition format). */
  get contentType(): string {
    return this.registry.contentType
  }

  /** A counter (get-or-create). */
  counter(name: string, options: CounterOptions = {}): Counter {
    return this.#getOrCreate('counter', name, options) as Counter
  }

  /** A gauge (get-or-create). */
  gauge(name: string, options: GaugeOptions = {}): Gauge {
    return this.#getOrCreate('gauge', name, options) as Gauge
  }

  /** A histogram (get-or-create). */
  histogram(name: string, options: HistogramOptions = {}): Histogram {
    return this.#getOrCreate('histogram', name, options) as Histogram
  }

  /** A summary (get-or-create). */
  summary(name: string, options: SummaryOptions = {}): Summary {
    return this.#getOrCreate('summary', name, options) as Summary
  }

  /** A metric created through this registry, by name (without the prefix). */
  get(name: string): Counter | Gauge | Histogram | Summary | undefined {
    return this.#metrics.get(this.prefix + name)?.metric as Counter | Gauge | Histogram | Summary | undefined
  }

  /** Every metric in the Prometheus text exposition format (what `/metrics` serves). */
  metrics(): Promise<string> {
    return this.registry.metrics()
  }

  /** Resets the values of every metric (keeps the definitions). */
  reset(): void {
    this.registry.resetMetrics()
  }

  #getOrCreate(type: MetricType, name: string, options: SummaryOptions & HistogramOptions): unknown {
    if (typeof name !== 'string' || name === '') throw invalidOption('metric name', 'expected a non-empty string')
    const fullName = this.prefix + name
    const labelNames = [...(options.labelNames ?? [])]
    const existing = this.#metrics.get(fullName) ?? this.#adopt(fullName, type, labelNames)
    if (existing !== undefined) {
      if (existing.type !== type) {
        throw invalidOption(`metric "${fullName}"`, `it is already registered as a ${existing.type}, not a ${type}`)
      }
      if (!sameLabels(existing.labelNames, labelNames)) {
        throw invalidOption(
          `metric "${fullName}"`,
          `it is already registered with the labels [${existing.labelNames.join(', ')}], not [${labelNames.join(', ')}]`,
        )
      }
      return existing.metric
    }
    const config: PromMetricConfig = {
      name: fullName,
      help: options.help ?? fullName,
      labelNames,
      registers: [this.registry],
    }
    if (options.buckets !== undefined) config.buckets = [...options.buckets]
    if (options.percentiles !== undefined) config.percentiles = [...options.percentiles]
    if (options.maxAgeSeconds !== undefined) config.maxAgeSeconds = options.maxAgeSeconds
    if (options.ageBuckets !== undefined) config.ageBuckets = options.ageBuckets
    let metric: unknown
    try {
      metric = new this.client[CLASS_OF[type]](config as never)
    } catch (error) {
      throw invalidOption(`metric "${fullName}"`, errorMessage(error))
    }
    this.#metrics.set(fullName, { type, labelNames, metric })
    return metric
  }

  /** A metric registered directly in the `prom-client` registry by someone else. */
  #adopt(fullName: string, type: MetricType, labelNames: readonly string[]): Registered | undefined {
    const foreign = this.registry.getSingleMetric(fullName)
    if (foreign === undefined) return undefined
    const actual = (Object.keys(CLASS_OF) as MetricType[]).find(kind => foreign instanceof this.client[CLASS_OF[kind]])
    const registered: Registered = {
      type: actual ?? type,
      labelNames: (foreign as { labelNames?: readonly string[] }).labelNames ?? labelNames,
      metric: foreign,
    }
    this.#metrics.set(fullName, registered)
    return registered
  }

  #collectDefaultMetrics(options: DefaultMetricsOptions): void {
    const config: PromDefaultMetricsConfig = { prefix: this.prefix + (options.prefix ?? '') }
    if (options.gcDurationBuckets !== undefined) config.gcDurationBuckets = [...options.gcDurationBuckets]
    if (options.eventLoopMonitoringPrecision !== undefined) {
      config.eventLoopMonitoringPrecision = options.eventLoopMonitoringPrecision
    }
    for (const metric of sharedDefaultMetrics(this.client, config, this.registry.contentType).getMetricsAsArray()) {
      try {
        this.registry.registerMetric(metric as never)
      } catch (error) {
        // a metric of that name is already in this (shared) registry: keep it
        if (!/already been registered/i.test(errorMessage(error))) throw error
      }
    }
  }
}

/**
 * Process-wide default metrics, by `prom-client` module and configuration.
 *
 * `collectDefaultMetrics` starts collectors that are never released (a GC `PerformanceObserver`, an
 * enabled `monitorEventLoopDelay` histogram) and whose metrics reference the registry they were
 * created in: on Node.js, every registry collecting them would stay in memory for the life of the
 * process. Collecting them once per configuration in a private registry, then registering those
 * metric objects in each `MetricsRegistry`, keeps the collectors bounded and lets the registries of
 * disposed applications be garbage collected. The content type is part of the configuration: an
 * OpenMetrics registry renames the counters it exposes.
 */
const DEFAULT_METRICS = new WeakMap<PromClient, Map<string, PromRegistry>>()

function sharedDefaultMetrics(client: PromClient, config: PromDefaultMetricsConfig, contentType: string): PromRegistry {
  let byConfig = DEFAULT_METRICS.get(client)
  if (byConfig === undefined) {
    byConfig = new Map()
    DEFAULT_METRICS.set(client, byConfig)
  }
  const key = JSON.stringify([
    contentType,
    config.prefix,
    config.gcDurationBuckets,
    config.eventLoopMonitoringPrecision,
  ])
  let holder = byConfig.get(key)
  if (holder === undefined) {
    holder = new client.Registry()
    client.collectDefaultMetrics({ ...config, register: holder })
    byConfig.set(key, holder)
  }
  return holder
}

function sameLabels(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const sorted = [...b].sort()
  return [...a].sort().every((label, index) => label === sorted[index])
}

function loadPromClient(): PromClient {
  return loadOptionalPeer<PromClient>(
    'prom-client',
    'Metrics',
    'or disable metrics: ObservabilityPlugin.configure({ metrics: false })',
  )
}
