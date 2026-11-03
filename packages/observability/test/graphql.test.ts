/**
 * Instrumentation of `graphql:operation` (RFC 0005 §8.10): spans (name, attributes, parent, status,
 * opt-in document), metrics (labels, the `_OTHER` cap, outcomes), opt-in logs, and the hook being
 * registered only when a GraphQL feature is on. The producer is emulated as `@znight/graphql` runs
 * it: `hooks.run()` around the execution, `outcome` and `errors` set before `run` resolves, inside
 * the `http:request` hook for the HTTP transport.
 */
import type { Application, GraphQLOperationEvent, PluginOptions } from '@znight/core'
import type { ObservabilityOptions } from '../src/index.ts'
import type { Entry } from './helpers.ts'

import { SpanKind, SpanStatusCode } from '@opentelemetry/api'
import { Application as App } from '@znight/core'

import { ObservabilityPlugin, type ObservabilityPluginInstance } from '../src/index.ts'
import { capture, caught, httpEvent, memoryTracing, meta } from './helpers.ts'
import { afterEach, describe, expect, it } from 'bun:test'

const { provider, exporter } = memoryTracing()

afterEach(() => exporter.reset())

const QUERY = 'query Books { books { title } }'

/** A `graphql:operation` event, as `@znight/graphql` builds it for an executed operation. */
function operation(overrides: Partial<GraphQLOperationEvent> = {}): GraphQLOperationEvent {
  return {
    operationType: 'query',
    operationName: 'Books',
    documentId: 'a1b2c3',
    transport: 'http',
    requestId: 'req-1',
    // `GraphQLContext.document` is a graphql-js `DocumentNode`, whose `loc.source.body` is the query
    context: { document: { kind: 'Document', loc: { source: { body: QUERY } } } },
    startTime: performance.now(),
    ...overrides,
  }
}

type Settled = Pick<GraphQLOperationEvent, 'outcome' | 'errors'>

/** Runs an operation through the hook; `settle` sets the outcome (and errors) or throws, like the producer. */
async function execute(
  app: Application,
  event: GraphQLOperationEvent,
  settle: () => Settled = () => ({ outcome: 'success' }),
): Promise<void> {
  // like the producer: Promise.resolve(run()).then(done, failed)
  await app.hooks.run('graphql:operation', event, () =>
    Promise.resolve()
      .then(settle)
      .then(
        settled => {
          event.outcome = settled.outcome
          if (settled.errors !== undefined) event.errors = settled.errors
          return { status: 200 }
        },
        (error: unknown) => {
          event.outcome = 'error'
          throw error
        },
      ),
  )
}

async function create(
  options: PluginOptions<ObservabilityOptions>,
): Promise<{ app: Application; plugin: ObservabilityPluginInstance }> {
  const plugin = ObservabilityPlugin.configure(options)
  const app = await App.create({ metadata: meta({}), plugins: [plugin], shutdown: { signals: false } })
  return { app, plugin }
}

function graphqlEntries(entries: readonly Entry[]): Entry[] {
  return entries.filter(entry => typeof entry.msg === 'string' && entry.msg.startsWith('graphql operation'))
}

const tracingOnly: ObservabilityOptions = {
  logging: { destination: capture().stream, requests: false },
  metrics: false,
  tracing: { tracerProvider: provider, http: true },
}

describe('graphql:operation hook registration', () => {
  it('registers the wrapper only when a GraphQL feature is on', async () => {
    const { stream } = capture()
    const allOff: ObservabilityOptions = {
      logging: { destination: stream },
      metrics: { server: false, graphql: false },
      tracing: { tracerProvider: provider, graphql: false },
    }
    for (const [options, expected] of [
      // tracing and metrics are on by default, logs are opt-in
      [{ logging: { destination: stream }, metrics: { server: false }, tracing: { tracerProvider: provider } }, true],
      [allOff, false],
      [{ ...allOff, logging: { destination: stream, graphql: false } }, false],
      [{ logging: { destination: stream }, metrics: false, tracing: false }, false],
      [{ logging: { destination: stream, graphql: true }, metrics: false, tracing: false }, true],
      [{ ...allOff, metrics: { server: false } }, true],
      [{ ...allOff, tracing: { tracerProvider: provider } }, true],
      // options given as a function: registered until they are evaluated, removed in onBootstrap
      [() => allOff, false],
      [() => ({ ...allOff, logging: { destination: stream, graphql: { level: 'debug' } } }), true],
    ] as const) {
      const { app } = await create(options as PluginOptions<ObservabilityOptions>)
      expect(app.hooks.hasWrappers('graphql:operation')).toBe(expected)
      await app.stop()
      expect(app.hooks.hasWrappers('graphql:operation')).toBe(false)
    }
  })

  it('leaves operations untouched when every GraphQL feature is off', async () => {
    const { stream, entries } = capture()
    const { app, plugin } = await create({
      logging: { destination: stream, level: 'debug' },
      metrics: { defaultMetrics: false, server: false, graphql: false },
      tracing: { tracerProvider: provider, graphql: false },
    })
    await execute(app, operation())
    expect(exporter.getFinishedSpans()).toHaveLength(0)
    expect(graphqlEntries(entries)).toEqual([])
    expect(await plugin.metrics?.metrics()).not.toContain('graphql_')
    await app.stop()
  })
})

describe('tracing.graphql', () => {
  it('creates an INTERNAL span "<type> <name>" per operation, child of the HTTP span', async () => {
    const { app } = await create(tracingOnly)
    await app.hooks.run('http:request', httpEvent({ method: 'POST', path: '/graphql', route: '/graphql' }), () =>
      execute(app, operation()),
    )
    const spans = exporter.getFinishedSpans()
    const http = spans.find(span => span.name === 'POST /graphql')
    const span = spans.find(span => span.name === 'query Books')
    expect(span?.kind).toBe(SpanKind.INTERNAL)
    expect(span?.parentSpanContext?.spanId).toBe(http?.spanContext().spanId)
    expect(span?.spanContext().traceId).toBe(http?.spanContext().traceId)
    expect(span?.attributes).toEqual({
      'graphql.operation.type': 'query',
      'graphql.operation.name': 'Books',
      'znight.request.id': 'req-1',
      'znight.graphql.transport': 'http',
      'znight.graphql.document_id': 'a1b2c3',
      'znight.graphql.outcome': 'success',
    })
    expect(span?.status.code).toBe(SpanStatusCode.UNSET)
    await app.stop()
  })

  it('names anonymous operations by type, and requests rejected before selection "GraphQL Operation"', async () => {
    const { app } = await create(tracingOnly)
    await execute(app, operation({ operationType: 'mutation', operationName: undefined }))
    await execute(
      app,
      operation({ operationType: undefined, operationName: undefined, documentId: undefined, context: undefined }),
      () => ({
        outcome: 'rejected',
        errors: [{ message: 'Syntax Error: Unexpected "}".', code: 'GRAPHQL_PARSE_FAILED' }],
      }),
    )
    const [mutation, rejected] = exporter.getFinishedSpans()
    expect(mutation?.name).toBe('mutation')
    expect(mutation?.attributes).not.toHaveProperty('graphql.operation.name')
    expect(rejected?.name).toBe('GraphQL Operation')
    expect(rejected?.attributes).not.toHaveProperty('graphql.operation.type')
    expect(rejected?.attributes).toMatchObject({
      'znight.graphql.outcome': 'rejected',
      'znight.graphql.error_codes': ['GRAPHQL_PARSE_FAILED'],
      'error.type': 'GRAPHQL_PARSE_FAILED',
    })
    expect(rejected?.status).toEqual({ code: SpanStatusCode.ERROR, message: 'Syntax Error: Unexpected "}".' })
    await app.stop()
  })

  it('sets the status from the outcome: partial keeps it unset, error and thrown errors set ERROR', async () => {
    const { app } = await create(tracingOnly)
    const fieldError = { message: 'Forbidden', code: 'FORBIDDEN', path: ['books', 0, 'secret'] }
    await execute(app, operation({ operationName: 'Partial' }), () => ({
      outcome: 'partial',
      errors: [fieldError, { ...fieldError, path: ['books', 1, 'secret'] }],
    }))
    await execute(app, operation({ operationName: 'Failed' }), () => ({
      outcome: 'error',
      errors: [{ message: 'Unexpected error.', code: 'INTERNAL_SERVER_ERROR', path: ['books'] }],
    }))
    const thrown = await caught(() =>
      execute(app, operation({ operationName: 'Thrown' }), () => {
        throw new TypeError('boom')
      }),
    )
    expect(thrown).toBeInstanceOf(TypeError)
    const byName = new Map(exporter.getFinishedSpans().map(span => [span.name, span]))
    const partial = byName.get('query Partial')
    expect(partial?.status.code).toBe(SpanStatusCode.UNSET)
    expect(partial?.attributes).toMatchObject({
      'znight.graphql.outcome': 'partial',
      'znight.graphql.error_codes': ['FORBIDDEN'],
    })
    expect(partial?.attributes).not.toHaveProperty('error.type')
    const failed = byName.get('query Failed')
    expect(failed?.status).toEqual({ code: SpanStatusCode.ERROR, message: 'Unexpected error.' })
    expect(failed?.attributes['error.type']).toBe('INTERNAL_SERVER_ERROR')
    const threw = byName.get('query Thrown')
    expect(threw?.status).toEqual({ code: SpanStatusCode.ERROR, message: 'boom' })
    expect(threw?.attributes).toMatchObject({ 'znight.graphql.outcome': 'error', 'error.type': 'TypeError' })
    expect(threw?.events.map(event => event.name)).toEqual(['exception'])
    await app.stop()
  })

  it('records graphql.document only with document: true, and honours ignore', async () => {
    const { app } = await create({
      ...tracingOnly,
      tracing: {
        tracerProvider: provider,
        graphql: { document: true, ignore: event => event.operationName === 'Introspection' },
      },
    })
    await execute(app, operation())
    await execute(app, operation({ operationName: 'Introspection' }))
    await execute(app, operation({ operationName: 'Direct', transport: 'direct', context: {} }))
    const spans = exporter.getFinishedSpans()
    expect(spans.map(span => span.name)).toEqual(['query Books', 'query Direct'])
    expect(spans[0]?.attributes['graphql.document']).toBe(QUERY)
    expect(spans[1]?.attributes).not.toHaveProperty('graphql.document')
    await app.stop()

    const { app: defaults } = await create(tracingOnly)
    await execute(defaults, operation())
    expect(exporter.getFinishedSpans()[2]?.attributes).not.toHaveProperty('graphql.document')
    await defaults.stop()
  })

  it('covers the whole life of a subscription, and is active while it runs', async () => {
    const { app, plugin } = await create(tracingOnly)
    let end: (() => void) | undefined
    const ended = new Promise<void>(resolve => {
      end = resolve
    })
    const event = operation({ operationType: 'subscription', operationName: 'BookAdded', transport: 'sse' })
    let active: string | undefined
    const running = app.hooks.run('graphql:operation', event, async () => {
      active = plugin.tracer?.traceContext()?.spanId
      await ended
      event.outcome = 'success'
    })
    await Promise.resolve()
    expect(exporter.getFinishedSpans()).toHaveLength(0)
    end?.()
    await running
    const [span] = exporter.getFinishedSpans()
    expect(span?.name).toBe('subscription BookAdded')
    expect(active).toBe(span?.spanContext().spanId)
    await app.stop()
  })
})

describe('metrics.graphql', () => {
  const metricsOnly = (graphql?: NonNullable<Exclude<ObservabilityOptions['metrics'], boolean>>['graphql']) =>
    ({
      logging: { destination: capture().stream },
      tracing: false,
      metrics: { defaultMetrics: false, server: false, ...(graphql === undefined ? {} : { graphql }) },
    }) satisfies ObservabilityOptions

  it('counts operations by type, name and outcome, and times them by type and name', async () => {
    const { app, plugin } = await create(metricsOnly())
    await execute(app, operation())
    await execute(app, operation(), () => ({ outcome: 'partial', errors: [{ message: 'x', code: 'FORBIDDEN' }] }))
    await execute(app, operation({ operationType: 'mutation', operationName: undefined }))
    await execute(app, operation({ operationType: undefined, operationName: undefined }), () => ({
      outcome: 'rejected',
    }))
    await caught(() =>
      execute(app, operation({ operationName: 'Boom' }), () => {
        throw new Error('boom')
      }),
    )
    const body = (await plugin.metrics?.metrics()) ?? ''
    expect(body).toContain('graphql_operations_total{type="query",name="Books",outcome="success"} 1')
    expect(body).toContain('graphql_operations_total{type="query",name="Books",outcome="partial"} 1')
    expect(body).toContain('graphql_operations_total{type="mutation",name="anonymous",outcome="success"} 1')
    expect(body).toContain('graphql_operations_total{type="unknown",name="anonymous",outcome="rejected"} 1')
    expect(body).toContain('graphql_operations_total{type="query",name="Boom",outcome="error"} 1')
    expect(body).toContain('graphql_operation_duration_seconds_count{type="query",name="Books"} 2')
    expect(body).toContain('graphql_operation_duration_seconds_count{type="mutation",name="anonymous"} 1')
    expect(body).toContain('graphql_operation_duration_seconds_bucket{le="0.005",type="query",name="Books"}')
    await app.stop()
  })

  it('caps the name label at maxOperationNames distinct names (_OTHER)', async () => {
    const { app, plugin } = await create(metricsOnly({ maxOperationNames: 2, buckets: [0.1, 1] }))
    for (const name of ['A', 'B', 'C', 'D', 'A', undefined]) {
      await execute(app, operation({ operationName: name }))
    }
    const body = (await plugin.metrics?.metrics()) ?? ''
    expect(body).toContain('graphql_operations_total{type="query",name="A",outcome="success"} 2')
    expect(body).toContain('graphql_operations_total{type="query",name="B",outcome="success"} 1')
    expect(body).toContain('graphql_operations_total{type="query",name="_OTHER",outcome="success"} 2')
    // anonymous operations do not use a slot of the cap
    expect(body).toContain('graphql_operations_total{type="query",name="anonymous",outcome="success"} 1')
    expect(body).not.toContain('name="C"')
    expect(body).toContain('graphql_operation_duration_seconds_bucket{le="0.1",type="query",name="_OTHER"} 2')
    await app.stop()
  })

  it('honours ignore and rejects an invalid maxOperationNames', async () => {
    const { app, plugin } = await create(metricsOnly({ ignore: event => event.operationName === 'Health' }))
    await execute(app, operation({ operationName: 'Health' }))
    expect(await plugin.metrics?.metrics()).not.toContain('name="Health"')
    await app.stop()
    for (const maxOperationNames of [0, 1.5]) {
      await expect(create(metricsOnly({ maxOperationNames }))).rejects.toThrow('metrics.graphql.maxOperationNames')
    }
  })
})

describe('logging.graphql', () => {
  it('is off by default', async () => {
    const { stream, entries } = capture()
    const { app } = await create({ logging: { destination: stream, level: 'debug' }, metrics: false, tracing: false })
    expect(app.hooks.hasWrappers('graphql:operation')).toBe(false)
    await execute(app, operation())
    expect(graphqlEntries(entries)).toEqual([])
    await app.stop()
  })

  it('writes one entry per operation, at the level of its outcome', async () => {
    const { stream, entries } = capture()
    const { app } = await create({
      logging: { destination: stream, graphql: true, replaceCoreLogger: false },
      metrics: false,
      tracing: { tracerProvider: provider },
    })
    const errors = [{ message: 'Forbidden', code: 'FORBIDDEN', path: ['books', 0, 'secret'] }]
    await execute(app, operation())
    await execute(app, operation(), () => ({ outcome: 'partial', errors }))
    await execute(app, operation({ operationType: undefined, operationName: undefined }), () => ({
      outcome: 'rejected',
      errors: [{ message: 'Bad', code: 'GRAPHQL_VALIDATION_FAILED' }],
    }))
    await caught(() =>
      execute(app, operation(), () => {
        throw new Error('boom')
      }),
    )
    const logged = graphqlEntries(entries)
    expect(logged.map(entry => [entry.level, entry.msg, entry['outcome']])).toEqual([
      [30, 'graphql operation completed', 'success'],
      [40, 'graphql operation completed with errors', 'partial'],
      [40, 'graphql operation rejected', 'rejected'],
      [50, 'graphql operation failed', 'error'],
    ])
    const [success, partial, , failed] = logged
    expect(success).toMatchObject({
      operationType: 'query',
      operationName: 'Books',
      transport: 'http',
      documentId: 'a1b2c3',
      requestId: 'req-1',
    })
    expect(typeof success?.['durationMs']).toBe('number')
    // written inside the span of the operation
    expect(typeof success?.['traceId']).toBe('string')
    expect(success).not.toHaveProperty('errors')
    expect(partial?.['errors']).toEqual(errors)
    expect(failed?.['err']).toMatchObject({ message: 'boom' })
    await app.stop()
  })

  it('honours the level and ignore options, and rejects an invalid level', async () => {
    const { stream, entries } = capture()
    const { app } = await create({
      logging: {
        destination: stream,
        level: 'debug',
        graphql: { level: 'debug', ignore: event => event.operationName === 'Noisy' },
      },
      metrics: false,
      tracing: false,
    })
    await execute(app, operation())
    await execute(app, operation({ operationName: 'Noisy' }))
    expect(graphqlEntries(entries).map(entry => [entry.level, entry['operationName']])).toEqual([[20, 'Books']])
    await app.stop()
    await expect(create({ logging: { graphql: { level: 'loud' as never } } })).rejects.toThrow('logging.graphql.level')
  })
})
