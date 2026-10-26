/**
 * Structural types of the parts of `prom-client` this package uses. `prom-client` is an optional
 * peer dependency: these types keep the public declarations free of it.
 */

/** Label values of one time series. */
export type LabelValues = Readonly<Record<string, string | number>>

/** A monotonically increasing counter (`prom-client` `Counter`). */
export interface Counter {
  inc(value?: number): void
  inc(labels: LabelValues, value?: number): void
  /** Removes the series with these labels. */
  remove(labels: LabelValues): void
  reset(): void
}

/** A value that goes up and down (`prom-client` `Gauge`). */
export interface Gauge {
  inc(value?: number): void
  inc(labels: LabelValues, value?: number): void
  dec(value?: number): void
  dec(labels: LabelValues, value?: number): void
  set(value: number): void
  set(labels: LabelValues, value: number): void
  remove(labels: LabelValues): void
  reset(): void
}

/** A distribution in buckets (`prom-client` `Histogram`). */
export interface Histogram {
  observe(value: number): void
  observe(labels: LabelValues, value: number): void
  /** Starts a timer; calling the returned function observes the elapsed seconds and returns them. */
  startTimer(labels?: LabelValues): (labels?: LabelValues) => number
  remove(labels: LabelValues): void
  reset(): void
}

/** Quantiles over a sliding window (`prom-client` `Summary`). */
export interface Summary {
  observe(value: number): void
  observe(labels: LabelValues, value: number): void
  startTimer(labels?: LabelValues): (labels?: LabelValues) => number
  remove(labels: LabelValues): void
  reset(): void
}

/** A `prom-client` `Registry`. */
export interface PromRegistry {
  metrics(): Promise<string>
  readonly contentType: string
  getSingleMetric(name: string): unknown
  removeSingleMetric(name: string): void
  setDefaultLabels(labels: object): void
  resetMetrics(): void
  clear(): void
}

/** Common configuration of `prom-client` metrics. */
export interface PromMetricConfig {
  name: string
  help: string
  labelNames?: string[]
  registers?: PromRegistry[]
  buckets?: number[]
  percentiles?: number[]
  maxAgeSeconds?: number
  ageBuckets?: number
}

/** Configuration of `collectDefaultMetrics`. */
export interface PromDefaultMetricsConfig {
  register?: PromRegistry
  prefix?: string
  labels?: object
  gcDurationBuckets?: number[]
  eventLoopMonitoringPrecision?: number
}

/** The `prom-client` module (the part used here). */
export interface PromClient {
  readonly Registry: new () => PromRegistry
  // constructors are typed by what they produce (`never` accepts the real, stricter signatures);
  // MetricsRegistry passes a PromMetricConfig
  readonly Counter: new (
    config: never,
  ) => Counter
  readonly Gauge: new (config: never) => Gauge
  readonly Histogram: new (config: never) => Histogram
  readonly Summary: new (config: never) => Summary
  collectDefaultMetrics(config?: PromDefaultMetricsConfig): void
  /** The global registry. */
  readonly register: PromRegistry
}
