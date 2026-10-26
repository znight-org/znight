import type { Attributes } from '@opentelemetry/api'
import type { MethodInterceptor, MethodInvocation } from '@znight/core'
import type { Tracer } from '../tracing/tracer.ts'

import { context as otelContext, SpanKind, trace } from '@opentelemetry/api'

import { invalidOption } from '../internal/errors.ts'
import { guard } from '../internal/safe.ts'
import { SemanticAttributes } from '../tracing/semconv.ts'
import { recordSpanError } from '../tracing/tracer.ts'
import { observeCall } from './observe.ts'
import { assertOptionalString, assertOptionsObject } from './options.ts'

/** Span kind of a traced method. */
export type TracedSpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer'

/** Options of `@Traced()` / {@link TracedInterceptor}. */
export interface TracedOptions {
  /** Span name. Default: `<Class>.<method>`. */
  readonly name?: string
  /** Attributes set on the span (static values). */
  readonly attributes?: Attributes
  /** Span kind. Default: `internal`. */
  readonly kind?: TracedSpanKind
}

const KINDS: Readonly<Record<TracedSpanKind, SpanKind>> = {
  internal: SpanKind.INTERNAL,
  server: SpanKind.SERVER,
  client: SpanKind.CLIENT,
  producer: SpanKind.PRODUCER,
  consumer: SpanKind.CONSUMER,
}

/** Normalised `@Traced()` options. */
export interface Resolved {
  readonly name: string | undefined
  readonly kind: SpanKind
  readonly attributes: Attributes | undefined
}

const DEFAULTS: Resolved = Object.freeze({ name: undefined, kind: SpanKind.INTERNAL, attributes: undefined })

/**
 * Method interceptor behind `@Traced()`: runs the method in a child span of the active context
 * (`code.function.name` attribute), active during the call so nested spans and logs are correlated,
 * ended when the method returns (or its promise settles for async methods). Errors are recorded
 * (exception event, status `ERROR`) and rethrown. Synchronous methods stay synchronous.
 */
export class TracedInterceptor implements MethodInterceptor<TracedOptions | undefined> {
  readonly #tracer: Tracer
  readonly #resolved = new WeakMap<TracedOptions, Resolved>()
  readonly #record = guard('@Traced()')

  constructor(tracer: Tracer) {
    this.#tracer = tracer
  }

  intercept(invocation: MethodInvocation, options?: TracedOptions): unknown {
    const settings = this.#settings(options)
    const qualified = `${invocation.className}.${invocation.methodName}`
    const parent = otelContext.active()
    const span = this.#tracer.otel.startSpan(
      settings.name ?? qualified,
      {
        kind: settings.kind,
        attributes: { [SemanticAttributes.CODE_FUNCTION_NAME]: qualified, ...settings.attributes },
      },
      parent,
    )
    const active = trace.setSpan(parent, span)
    return observeCall(invocation.isAsync, () => otelContext.with(active, () => invocation.proceed()), {
      success: () => this.#record(() => span.end()),
      failure: error =>
        this.#record(() => {
          recordSpanError(span, error)
          span.end()
        }),
    })
  }

  #settings(options: TracedOptions | undefined): Resolved {
    if (options === undefined || options === null) return DEFAULTS
    let resolved = this.#resolved.get(options)
    if (resolved === undefined) {
      resolved = resolveTracedOptions(options)
      this.#resolved.set(options, resolved)
    }
    return resolved
  }
}

/**
 * Validates and normalises `@Traced()` options.
 *
 * @throws ZnightError (ZNIGHT005) for invalid options.
 */
export function resolveTracedOptions(options: unknown, where = '@Traced()'): Resolved {
  assertOptionsObject(options, where)
  if (options === undefined || options === null) return DEFAULTS
  const { name, kind = 'internal', attributes } = options as TracedOptions
  assertOptionalString(name, `${where} name`)
  if (typeof kind !== 'string' || !Object.hasOwn(KINDS, kind)) {
    throw invalidOption(
      `${where} kind`,
      `expected one of ${Object.keys(KINDS).join(', ')}, got ${JSON.stringify(kind)}`,
    )
  }
  if (
    attributes !== undefined &&
    (typeof attributes !== 'object' || attributes === null || Array.isArray(attributes))
  ) {
    throw invalidOption(`${where} attributes`, `expected an object, got ${JSON.stringify(attributes)}`)
  }
  return { name, kind: KINDS[kind], attributes }
}
