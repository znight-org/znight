/**
 * `events:publish` and `events:listener` (RFC 0011 §5.12): spans, metrics and logs, driven through
 * the hooks the way `@znight/events` produces them (no dependency on the package).
 */
import type { EventListenerEvent, EventPublishEvent } from '@znight/core'

import { Application } from '@znight/core'

import { ObservabilityPlugin } from '../src/index.ts'
import { capture, memoryTracing, meta } from './helpers.ts'
import { afterEach, describe, expect, it } from 'bun:test'

const { provider, exporter } = memoryTracing()

afterEach(() => exporter.reset())

class Boom extends Error {}

async function publish(app: Application, failing: boolean): Promise<void> {
  const record: EventPublishEvent = {
    event: 'UserCreated',
    payload: {},
    mode: 'publish',
    inline: 1,
    detached: 0,
    startTime: performance.now(),
  }
  await app.hooks.run('events:publish', record, async () => {
    const listener: EventListenerEvent = {
      event: 'UserCreated',
      payload: {},
      listener: 'WelcomeMail.send',
      detached: false,
      startTime: performance.now(),
    }
    try {
      await app.hooks.run('events:listener', listener, async () => {
        await Promise.resolve()
        if (failing) throw new Boom('listener failed')
      })
    } catch (error) {
      record.error = error
      record.failedListener = 'WelcomeMail.send'
      throw error
    }
  })
}

describe('events instrumentation', () => {
  it('records spans, metrics and a debug log per publication', async () => {
    const { stream, entries } = capture()
    const plugin = ObservabilityPlugin.configure({
      logging: { level: 'debug', destination: stream, replaceCoreLogger: false },
      tracing: { tracerProvider: provider },
      metrics: { server: false },
    })
    const app = await Application.create({ metadata: meta({}), plugins: [plugin], shutdown: { signals: false } })
    await publish(app, false)
    await publish(app, true).catch(() => undefined)

    const spans = exporter.getFinishedSpans().map(span => span.name)
    expect(spans).toEqual([
      'UserCreated → WelcomeMail.send',
      'publish UserCreated',
      'UserCreated → WelcomeMail.send',
      'publish UserCreated',
    ])
    const [listenerSpan, publishSpan] = exporter.getFinishedSpans()
    expect(listenerSpan?.spanContext().traceId).toBe(publishSpan?.spanContext().traceId as string)

    const body = (await plugin.metrics?.metrics()) ?? ''
    expect(body).toContain('znight_events_published_total{event="UserCreated"} 2')
    expect(body).toContain(
      'znight_event_listener_duration_seconds_count{event="UserCreated",listener="WelcomeMail.send",detached="false",outcome="failed"} 1',
    )

    const logs = entries.filter(entry => entry.msg === 'event published')
    expect(logs.map(entry => [entry['event'], entry['failedListener']])).toEqual([
      ['UserCreated', undefined],
      ['UserCreated', 'WelcomeMail.send'],
    ])
    await app.stop()
  })

  it('can be disabled per signal', async () => {
    const plugin = ObservabilityPlugin.configure({
      logging: { events: false },
      tracing: { events: false },
      metrics: { events: false, server: false },
    })
    const app = await Application.create({ metadata: meta({}), plugins: [plugin], shutdown: { signals: false } })
    expect(app.hooks.hasWrappers('events:publish')).toBe(false)
    expect(app.hooks.hasWrappers('events:listener')).toBe(false)
    await app.stop()
  })
})
