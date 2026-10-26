import type { MethodInterceptor, MethodInvocation } from '@znight/core'
import type { Counter, Histogram } from '../metrics/prom.ts'
import type { MetricsRegistry } from '../metrics/registry.ts'

import { errorMessage, invalidOption } from '../internal/errors.ts'
import { guard, warn } from '../internal/safe.ts'
import { now } from '../internal/time.ts'
import { observeCall } from './observe.ts'
import { assertOptionalString, assertOptionsObject } from './options.ts'

/** Kind of metric recorded by `@Metric()`. */
export type MetricKind = 'counter' | 'histogram'

/** Options of `@Metric()` / {@link MetricInterceptor}. */
export interface MetricOptions {
  /**
   * Metric name (prefixed with the registry prefix). Default: `method_duration_seconds` for a
   * histogram, `method_calls_total` for a counter, shared by every `@Metric()` method and told apart
   * by the `class` and `method` labels.
   */
  readonly name?: string
  /** `histogram` (call durations, in seconds; its `_count` counts calls) or `counter` (calls). Default: `histogram`. */
  readonly type?: MetricKind
  /** Description (`# HELP`). */
  readonly help?: string
  /** Static labels added to every series (in addition to `class`, `method` and `outcome`). */
  readonly labels?: Readonly<Record<string, string>>
  /** Histogram buckets, in seconds. Default: `prom-client`'s. */
  readonly buckets?: readonly number[]
}

/** Options of the {@link MetricInterceptor} constructor. */
export interface MetricInterceptorOptions {
  /** Receives configuration errors (conflicting metric definitions). Default: a process warning. */
  readonly onError?: (error: unknown) => void
}

/** Records one call. */
type Recorder = (invocation: MethodInvocation, outcome: 'success' | 'error', started: number) => void

const DEFAULT_NAMES: Readonly<Record<MetricKind, string>> = {
  histogram: 'method_duration_seconds',
  counter: 'method_calls_total',
}

const DEFAULT_HELP: Readonly<Record<MetricKind, string>> = {
  histogram: 'Duration of method calls, in seconds',
  counter: 'Number of method calls',
}

/** Placeholder of "no options" in the recorder cache. */
const NO_OPTIONS: MetricOptions = Object.freeze({})

/**
 * Method interceptor behind `@Metric()`: records each call in a histogram (duration in seconds) or a
 * counter, with the labels `class`, `method` and `outcome` (`success` | `error`) plus static labels.
 * Metrics are created on the first call (get-or-create); a conflicting definition (same name, other
 * type or labels) is reported once and the method keeps working unmeasured. Without metrics (no
 * registry), calls pass through. Synchronous methods stay synchronous.
 */
export class MetricInterceptor implements MethodInterceptor<MetricOptions | undefined> {
  readonly #registry: MetricsRegistry | undefined
  readonly #recorders = new WeakMap<MetricOptions, Recorder | null>()
  readonly #onError: (error: unknown) => void
  readonly #record = guard('@Metric()')

  constructor(registry: MetricsRegistry | undefined, options: MetricInterceptorOptions = {}) {
    this.#registry = registry
    this.#onError = options.onError ?? (error => warn(`@Metric(): ${errorMessage(error)}`))
  }

  intercept(invocation: MethodInvocation, options?: MetricOptions): unknown {
    const recorder = this.#recorder(options ?? NO_OPTIONS)
    if (recorder === null) return invocation.proceed()
    const started = now()
    return observeCall(invocation.isAsync, () => invocation.proceed(), {
      success: () => this.#record(() => recorder(invocation, 'success', started)),
      failure: () => this.#record(() => recorder(invocation, 'error', started)),
    })
  }

  #recorder(options: MetricOptions): Recorder | null {
    const cached = this.#recorders.get(options)
    if (cached !== undefined) return cached
    const resolved = resolveMetricOptions(options)
    let recorder: Recorder | null = null
    if (this.#registry !== undefined) {
      try {
        recorder = createRecorder(this.#registry, resolved)
      } catch (error) {
        this.#onError(error)
      }
    }
    this.#recorders.set(options, recorder)
    return recorder
  }
}

/** Normalised `@Metric()` options. */
export interface ResolvedMetricOptions {
  readonly type: MetricKind
  readonly name: string
  readonly help: string
  readonly labels: readonly (readonly [string, string])[]
  readonly buckets: readonly number[] | undefined
}

const RESERVED_LABELS: ReadonlySet<string> = new Set(['class', 'method', 'outcome'])

/**
 * Validates and normalises `@Metric()` options.
 *
 * @throws ZnightError (ZNIGHT005) for invalid options.
 */
export function resolveMetricOptions(options: unknown, where = '@Metric()'): ResolvedMetricOptions {
  assertOptionsObject(options, where)
  const { type = 'histogram', name, help, labels, buckets } = (options ?? {}) as MetricOptions
  if (type !== 'histogram' && type !== 'counter') {
    throw invalidOption(`${where} type`, `expected "histogram" or "counter", got ${JSON.stringify(type)}`)
  }
  assertOptionalString(name, `${where} name`)
  assertOptionalString(help, `${where} help`)
  if (labels !== undefined && (typeof labels !== 'object' || labels === null || Array.isArray(labels))) {
    throw invalidOption(`${where} labels`, `expected an object of strings, got ${JSON.stringify(labels)}`)
  }
  const entries = Object.entries(labels ?? {})
  for (const [label, value] of entries) {
    if (RESERVED_LABELS.has(label)) throw invalidOption(`${where} labels`, `"${label}" is set automatically`)
    if (typeof value !== 'string') throw invalidOption(`${where} labels.${label}`, 'expected a string')
  }
  if (buckets !== undefined && (!Array.isArray(buckets) || buckets.some(bound => !Number.isFinite(bound)))) {
    throw invalidOption(`${where} buckets`, `expected an array of numbers, got ${JSON.stringify(buckets)}`)
  }
  return {
    type,
    name: name ?? DEFAULT_NAMES[type],
    help: help ?? DEFAULT_HELP[type],
    labels: entries as [string, string][],
    buckets,
  }
}

function createRecorder(registry: MetricsRegistry, options: ResolvedMetricOptions): Recorder {
  const { type, name, help, labels: statics } = options
  const labelNames = ['class', 'method', 'outcome', ...statics.map(([label]) => label)]
  const labelsOf = (invocation: MethodInvocation, outcome: string): Record<string, string> => {
    const labels: Record<string, string> = { class: invocation.className, method: invocation.methodName, outcome }
    for (const [label, value] of statics) labels[label] = value
    return labels
  }
  if (type === 'counter') {
    const counter: Counter = registry.counter(name, { help, labelNames })
    return (invocation, outcome) => counter.inc(labelsOf(invocation, outcome))
  }
  const histogram: Histogram = registry.histogram(name, {
    help,
    labelNames,
    ...(options.buckets === undefined ? {} : { buckets: options.buckets }),
  })
  return (invocation, outcome, started) => histogram.observe(labelsOf(invocation, outcome), (now() - started) / 1000)
}
