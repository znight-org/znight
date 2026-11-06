/**
 * Instrumentation of the `websocket:*` hooks (RFC 0003 §8.10): message spans as new traces linked to
 * the handshake span, metrics with the event cap, connection gauges and counters, close logs. The
 * producer is emulated as `@znight/websocket` runs it: messages in the handshake's async context,
 * `outcome` set before `run` resolves; connection events emitted.
 */
import type { Application, WebSocketConnectionEvent, WebSocketMessageEvent } from '@znight/core'
import type { ObservabilityOptions } from '../src/index.ts'

import { SpanKind, SpanStatusCode } from '@opentelemetry/api'
import { Application as App } from '@znight/core'

import { ObservabilityPlugin, type ObservabilityPluginInstance } from '../src/index.ts'
import { capture, httpEvent, memoryTracing, meta } from './helpers.ts'
import { afterEach, describe, expect, it } from 'bun:test'

const { provider, exporter } = memoryTracing()

afterEach(() => exporter.reset())

function message(overrides: Partial<WebSocketMessageEvent> = {}): WebSocketMessageEvent {
  return {
    gateway: 'ChatGateway',
    path: '/chat',
    event: 'message.send',
    handler: 'send',
    connectionId: 'c-1',
    requestId: 'req-1',
    bytes: 42,
    context: {},
    startTime: performance.now(),
    ...overrides,
  }
}

function connection(
  type: 'open' | 'close',
  overrides: Partial<WebSocketConnectionEvent> = {},
): WebSocketConnectionEvent {
  return {
    type,
    gateway: 'ChatGateway',
    path: '/chat',
    connectionId: 'c-1',
    requestId: 'req-1',
    connection: {},
    openedAt: performance.now() - 5,
    ...(type === 'close' ? { code: 1000, reason: '', initiator: 'client' as const } : {}),
    ...overrides,
  }
}

async function handle(app: Application, event: WebSocketMessageEvent, outcome: WebSocketMessageEvent['outcome']) {
  await app.hooks.run('websocket:message', event, () => {
    event.outcome = outcome
    if (outcome === 'error') event.error = Object.assign(new Error('boom'), { code: 'INTERNAL' })
    return Promise.resolve()
  })
}

async function create(
  options: ObservabilityOptions,
): Promise<{ app: Application; plugin: ObservabilityPluginInstance }> {
  const plugin = ObservabilityPlugin.configure(options)
  const app = await App.create({ metadata: meta({}), plugins: [plugin], shutdown: { signals: false } })
  return { app, plugin }
}

describe('websocket instrumentation', () => {
  it('registers the hooks only when a WebSocket feature is on', async () => {
    const { stream } = capture()
    const { app } = await create({
      logging: { destination: stream, websocket: false },
      metrics: { server: false, websocket: false },
      tracing: { tracerProvider: provider, websocket: false },
    })
    expect(app.hooks.hasWrappers('websocket:message')).toBe(false)
    expect(app.hooks.hasListeners('websocket:connection')).toBe(false)
    await app.stop()
  })

  it('traces each message as a new SERVER trace linked to the handshake span', async () => {
    const { app } = await create({
      logging: { destination: capture().stream, requests: false, websocket: false },
      metrics: false,
      tracing: { tracerProvider: provider },
    })
    // the plugin runs messages in the async context of the handshake (the http:request span)
    let handshakeContext: (fn: () => Promise<void>) => Promise<void> = fn => fn()
    await app.hooks.run('http:request', httpEvent({ method: 'GET', path: '/chat', route: '/chat' }), async () => {
      const { AsyncLocalStorage } = await import('node:async_hooks')
      const snapshot = AsyncLocalStorage.snapshot()
      handshakeContext = fn => snapshot(fn)
    })
    await handshakeContext(() => handle(app, message(), 'ok'))
    await handshakeContext(() => handle(app, message({ event: 'boom', handler: 'boom' }), 'error'))
    const spans = exporter.getFinishedSpans()
    const http = spans.find(span => span.name === 'GET /chat')
    const ok = spans.find(span => span.name === 'WS /chat message.send')
    const failed = spans.find(span => span.name === 'WS /chat boom')
    expect(ok?.kind).toBe(SpanKind.SERVER)
    expect(ok?.parentSpanContext).toBeUndefined()
    expect(ok?.spanContext().traceId).not.toBe(http?.spanContext().traceId)
    expect(ok?.links.map(link => link.context.spanId)).toEqual([http?.spanContext().spanId as string])
    expect(ok?.attributes).toEqual({
      'znight.websocket.gateway': 'ChatGateway',
      'znight.websocket.connection_id': 'c-1',
      'znight.websocket.event': 'message.send',
      'znight.websocket.handler': 'send',
      'znight.websocket.outcome': 'ok',
      'znight.request.id': 'req-1',
      'http.route': '/chat',
    })
    expect(failed?.status).toEqual({ code: SpanStatusCode.ERROR, message: 'message error' })
    expect(failed?.attributes['error.type']).toBe('INTERNAL')
    await app.stop()
  })

  it('measures messages (event cap, unmatched) and connections', async () => {
    const { app, plugin } = await create({
      logging: { destination: capture().stream, websocket: false },
      metrics: { defaultMetrics: false, server: false, websocket: { maxEvents: 1 } },
      tracing: false,
    })
    await handle(app, message(), 'ok')
    await handle(app, message({ event: 'other', handler: 'other' }), 'ok')
    await handle(app, message({ event: 'nope', handler: undefined }), 'unhandled')
    app.hooks.emit('websocket:connection', connection('open'))
    app.hooks.emit('websocket:connection', connection('open', { connectionId: 'c-2' }))
    app.hooks.emit('websocket:connection', connection('close', { initiator: 'heartbeat' }))
    const text = (await plugin.metrics?.metrics()) ?? ''
    expect(text).toContain(
      'websocket_messages_received_total{gateway="ChatGateway",event="message.send",outcome="ok"} 1',
    )
    expect(text).toContain('websocket_messages_received_total{gateway="ChatGateway",event="_OTHER",outcome="ok"} 1')
    expect(text).toContain(
      'websocket_messages_received_total{gateway="ChatGateway",event="unmatched",outcome="unhandled"} 1',
    )
    expect(text).toContain('websocket_connections_active{gateway="ChatGateway"} 1')
    expect(text).toContain('websocket_connections_total{gateway="ChatGateway",initiator="heartbeat"} 1')
    expect(text).toContain(
      'websocket_message_duration_seconds_count{gateway="ChatGateway",event="message.send",outcome="ok"} 1',
    )
    await app.stop()
  })

  it('logs closed connections and failed messages, and every message with messages: true', async () => {
    const { stream, entries } = capture()
    const { app } = await create({
      logging: { destination: stream, level: 'debug', requests: false, websocket: { messages: true } },
      metrics: false,
      tracing: false,
    })
    await handle(app, message(), 'ok')
    await handle(app, message({ event: 'boom', handler: 'boom' }), 'error')
    app.hooks.emit('websocket:connection', connection('close', { code: 1001, initiator: 'shutdown' }))
    const ws = entries.filter(entry => typeof entry.msg === 'string' && entry.msg.startsWith('websocket'))
    expect(ws.map(entry => [entry.level, entry.msg])).toEqual([
      [20, 'websocket message handled'],
      [50, 'websocket message failed'],
      [30, 'websocket connection closed'],
    ])
    expect(ws[2]).toMatchObject({ gateway: 'ChatGateway', code: 1001, initiator: 'shutdown', connectionId: 'c-1' })
    await app.stop()
  })
})
