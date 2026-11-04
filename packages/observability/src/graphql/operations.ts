/**
 * Instrumentation of the `graphql:operation` hook of `@znight/graphql` (RFC 0005 §8.10): one span,
 * the operation metrics and an optional log entry per operation. `@znight/graphql` wraps every
 * operation with `hooks.run()` when wrappers exist (a subscription for its whole life) and sets
 * `outcome` and `errors` before `run` resolves. Read structurally: no dependency on
 * `@znight/graphql`.
 */
import type { Attributes, Span } from '@opentelemetry/api'
import type { GraphQLOperationEvent, GraphQLOperationOutcome, HookWrapper } from '@znight/core'
import type { LogEntryLevel } from '../logging/levels.ts'
import type { Logger } from '../logging/logger.ts'
import type { MetricsRegistry } from '../metrics/registry.ts'
import type { Tracer } from '../tracing/tracer.ts'

import { context as otelContext, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'

import { invalidOption } from '../internal/errors.ts'
import { guard } from '../internal/safe.ts'
import { elapsedMs, now, startOf } from '../internal/time.ts'
import { parseEntryLevel } from '../logging/levels.ts'
import { DEFAULT_DURATION_BUCKETS } from '../metrics/hooks.ts'
import { ensureContextManager } from '../tracing/context.ts'
import { SemanticAttributes as Attr } from '../tracing/semconv.ts'
import { recordSpanError } from '../tracing/tracer.ts'

/** Options of {@link traceGraphQLOperations}. */
export interface GraphQLTracingOptions {
  /** Operations that are not traced. */
  readonly ignore?: (event: GraphQLOperationEvent) => boolean
  /**
   * Record the query text as `graphql.document`. It may carry literal values (inline arguments), so
   * it is off unless asked for. Default: `false`.
   */
  readonly document?: boolean
}

/** Options of {@link measureGraphQLOperations}. */
export interface GraphQLMetricsOptions {
  /** Buckets of `graphql_operation_duration_seconds`. Default: {@link DEFAULT_DURATION_BUCKETS}. */
  readonly buckets?: readonly number[]
  /** Operations that are not measured. */
  readonly ignore?: (event: GraphQLOperationEvent) => boolean
  /**
   * Distinct `name` label values (clients choose operation names); later names are recorded as
   * `_OTHER`. Default: 100.
   */
  readonly maxOperationNames?: number
}

/** Options of {@link logGraphQLOperations}. */
export interface GraphQLOperationLogOptions {
  /** Level of successful operations (`partial` and `rejected` are `warn`, `error` is `error`). Default: `info`. */
  readonly level?: LogEntryLevel
  /** Operations that are not logged. */
  readonly ignore?: (event: GraphQLOperationEvent) => boolean
}

/** Default of {@link GraphQLMetricsOptions.maxOperationNames}. */
export const DEFAULT_MAX_OPERATION_NAMES = 100

/** `name` label of the operation names beyond {@link GraphQLMetricsOptions.maxOperationNames}. */
export const OTHER_OPERATION_NAME = '_OTHER'

/** `name` label of anonymous operations (`query { ... }`). */
export const ANONYMOUS_OPERATION = 'anonymous'

/** `type` label of requests rejected before an operation was selected (parse error...). */
export const UNKNOWN_OPERATION_TYPE = 'unknown'

/**
 * One `INTERNAL` span per operation, child of the active span (the `SERVER` span of the HTTP request
 * carrying it), named after the OpenTelemetry GraphQL conventions: `<type> <name>`, `<type>` for an
 * anonymous operation, `GraphQL Operation` when none was selected. Attributes:
 * `graphql.operation.type`, `graphql.operation.name`, `graphql.document` (opt-in, `document: true`),
 * `znight.request.id`, `znight.graphql.transport`, `.driver` (only for a driver other than the
 * built-in transport, RFC 0009), `.document_id`, `.outcome` and `.error_codes`. The
 * status is `ERROR` for the `error` and `rejected` outcomes (`partial` responses carry data and keep
 * it unset). A subscription's span covers its whole life.
 */
export function traceGraphQLOperations(
  tracer: Tracer,
  options: GraphQLTracingOptions = {},
): HookWrapper<'graphql:operation'> {
  const ignore = options.ignore
  const withDocument = options.document === true
  const record = guard('Recording a GraphQL span')
  return (event, next) => {
    if (ignore?.(event) === true) return next()
    const parent = otelContext.active()
    const attributes: Attributes = {
      [Attr.ZNIGHT_REQUEST_ID]: event.requestId,
      [Attr.ZNIGHT_GRAPHQL_TRANSPORT]: event.transport,
    }
    // the built-in transport is the default: only another driver (RFC 0009) is recorded
    const driver = event.driver
    if (driver !== undefined && driver !== 'builtin') attributes[Attr.ZNIGHT_GRAPHQL_DRIVER] = driver
    if (event.operationType !== undefined) attributes[Attr.GRAPHQL_OPERATION_TYPE] = event.operationType
    if (event.operationName !== undefined) attributes[Attr.GRAPHQL_OPERATION_NAME] = event.operationName
    if (event.documentId !== undefined) attributes[Attr.ZNIGHT_GRAPHQL_DOCUMENT_ID] = event.documentId
    if (withDocument) {
      const text = documentText(event.context)
      if (text !== undefined) attributes[Attr.GRAPHQL_DOCUMENT] = text
    }
    const span = tracer.otel.startSpan(
      spanName(event),
      { kind: SpanKind.INTERNAL, attributes, ...startTimeOf(event.startTime) },
      parent,
    )
    ensureContextManager()
    return otelContext.with(trace.setSpan(parent, span), async () => {
      let failed = false
      let thrown: unknown
      try {
        return await next()
      } catch (error) {
        failed = true
        thrown = error
        throw error
      } finally {
        record(() => finishSpan(span, event, failed, thrown))
      }
    })
  }
}

function finishSpan(span: Span, event: GraphQLOperationEvent, failed: boolean, thrown: unknown): void {
  const outcome = settledOutcome(event)
  span.setAttribute(Attr.ZNIGHT_GRAPHQL_OUTCOME, outcome)
  const codes = errorCodes(event)
  if (codes.length > 0) span.setAttribute(Attr.ZNIGHT_GRAPHQL_ERROR_CODES, codes)
  if (failed) {
    recordSpanError(span, thrown)
  } else if (outcome === 'error' || outcome === 'rejected') {
    const first = event.errors?.[0]
    span.setStatus({ code: SpanStatusCode.ERROR, message: first?.message ?? `operation ${outcome}` })
    span.setAttribute(Attr.ERROR_TYPE, first?.code ?? outcome)
  }
  span.end()
}

/**
 * Operation metrics (prefixed with the registry prefix):
 *
 * | Metric | Type | Labels |
 * | --- | --- | --- |
 * | `graphql_operations_total` | counter | `type`, `name`, `outcome` |
 * | `graphql_operation_duration_seconds` | histogram | `type`, `name` |
 *
 * `type` is `query`, `mutation`, `subscription` or `unknown` (rejected before an operation was
 * selected); `name` is the operation name, `anonymous` for an anonymous operation, limited to
 * `maxOperationNames` distinct values (then `_OTHER`): clients choose operation names. A
 * subscription is timed over its whole life.
 */
export function measureGraphQLOperations(
  registry: MetricsRegistry,
  options: GraphQLMetricsOptions = {},
): HookWrapper<'graphql:operation'> {
  const name = boundedNameLabel(options.maxOperationNames)
  const total = registry.counter('graphql_operations_total', {
    help: 'Number of GraphQL operations, by outcome',
    labelNames: ['type', 'name', 'outcome'],
  })
  const duration = registry.histogram('graphql_operation_duration_seconds', {
    help: 'Duration of GraphQL operations, in seconds',
    labelNames: ['type', 'name'],
    buckets: options.buckets ?? DEFAULT_DURATION_BUCKETS,
  })
  const ignore = options.ignore
  const record = guard('Recording GraphQL metrics')
  return async (event, next) => {
    if (ignore?.(event) === true) return next()
    const started = now()
    try {
      return await next()
    } finally {
      record(() => {
        const labels = { type: event.operationType ?? UNKNOWN_OPERATION_TYPE, name: name(event.operationName) }
        total.inc({ ...labels, outcome: settledOutcome(event) })
        duration.observe(labels, (now() - startOf(event.startTime, started)) / 1000)
      })
    }
  }
}

const LOG_MESSAGES: Readonly<Record<GraphQLOperationOutcome, string>> = {
  success: 'graphql operation completed',
  partial: 'graphql operation completed with errors',
  error: 'graphql operation failed',
  rejected: 'graphql operation rejected',
}

/**
 * One entry per settled operation (a subscription when it ends): `operationType`, `operationName`,
 * `outcome`, `transport`, `documentId`, `requestId`, `durationMs`, and `errors` (message, code,
 * path, as sent to the client) or `err` (what the execution threw) when it did not succeed. Written
 * inside the span, so it carries `traceId`.
 */
export function logGraphQLOperations(
  logger: Logger,
  options: GraphQLOperationLogOptions = {},
): HookWrapper<'graphql:operation'> {
  const level = options.level === undefined ? 'info' : parseEntryLevel(options.level, 'logging.graphql.level')
  const ignore = options.ignore
  const record = guard('Logging a GraphQL operation')
  return async (event, next) => {
    if (ignore?.(event) === true) return next()
    const started = now()
    let thrown: unknown
    let failed = false
    try {
      return await next()
    } catch (error) {
      failed = true
      thrown = error
      throw error
    } finally {
      record(() => {
        const outcome = settledOutcome(event)
        const severity = severityOf(outcome, level)
        if (logger.isLevelEnabled(severity)) {
          const entry: Record<string, unknown> = {
            operationType: event.operationType,
            operationName: event.operationName,
            outcome,
            transport: event.transport,
            documentId: event.documentId,
            requestId: event.requestId,
            durationMs: elapsedMs(startOf(event.startTime, started)),
          }
          if (event.errors !== undefined && event.errors.length > 0) entry['errors'] = event.errors
          if (failed) entry['err'] = thrown
          logger.log(severity, LOG_MESSAGES[outcome], entry)
        }
      })
    }
  }
}

/**
 * Outcome of an operation once `next()` settled. The producer sets it before `run` resolves; it is
 * missing only when the execution threw, or when an inner wrapper threw or did not call `next()`.
 */
function settledOutcome(event: GraphQLOperationEvent): GraphQLOperationOutcome {
  const outcome = event.outcome
  return outcome !== undefined && Object.hasOwn(LOG_MESSAGES, outcome) ? outcome : 'error'
}

function severityOf(outcome: GraphQLOperationOutcome, success: LogEntryLevel): LogEntryLevel {
  switch (outcome) {
    case 'success':
      return success
    case 'error':
      return 'error'
    default:
      return 'warn'
  }
}

/** Span name of the OpenTelemetry GraphQL conventions. */
function spanName(event: GraphQLOperationEvent): string {
  if (event.operationType === undefined) return 'GraphQL Operation'
  return event.operationName === undefined ? event.operationType : `${event.operationType} ${event.operationName}`
}

/** Distinct error codes of the response, in order of appearance. */
function errorCodes(event: GraphQLOperationEvent): string[] {
  const errors = event.errors
  if (errors === undefined || errors.length === 0) return []
  const codes = new Set<string>()
  for (const error of errors) if (typeof error.code === 'string') codes.add(error.code)
  return [...codes]
}

/**
 * The query text of the operation: `GraphQLContext.document` of `@znight/graphql` is a graphql-js
 * `DocumentNode` whose `loc.source.body` is the text it was parsed from. Read structurally.
 */
function documentText(context: unknown): string | undefined {
  const document = (context as { readonly document?: { readonly loc?: { readonly source?: { body?: unknown } } } })
    ?.document
  const body = document?.loc?.source?.body
  return typeof body === 'string' ? body : undefined
}

/** The `name` label: the operation name, limited to `max` distinct values (`_OTHER` beyond). */
function boundedNameLabel(max: number = DEFAULT_MAX_OPERATION_NAMES): (name: string | undefined) => string {
  if (!Number.isInteger(max) || max < 1) {
    throw invalidOption('metrics.graphql.maxOperationNames', `expected a positive integer, got ${String(max)}`)
  }
  const seen = new Set<string>()
  return name => {
    if (name === undefined) return ANONYMOUS_OPERATION
    if (seen.has(name)) return name
    if (seen.size >= max) return OTHER_OPERATION_NAME
    seen.add(name)
    return name
  }
}

function startTimeOf(startTime: unknown): { startTime?: number } {
  return typeof startTime === 'number' && Number.isFinite(startTime) && startTime >= 0 && startTime <= performance.now()
    ? { startTime }
    : {}
}
