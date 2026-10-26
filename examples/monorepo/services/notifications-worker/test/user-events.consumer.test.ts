import type { Notification, NotificationChannel } from '../src/notifications/notification.js'

import { MessagingPlugin } from '@znight/messaging'
import { type MemoryDriver, memory } from '@znight/messaging/memory'
import { ObservabilityPlugin } from '@znight/observability'
import { TestApp } from '@znight/testing'
import { CLOCK, type Clock, USER_EVENTS_QUEUE, UserDirectory, UserEventType } from '@znight-examples/shared'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { afterEach, beforeEach, describe, expect, test as it } from 'bun:test'

const frozenClock: Clock = { now: () => new Date('2026-01-02T00:00:00.000Z') }

const ada = { id: 'u1', email: 'ada@example.com', name: 'Ada', at: '2026-01-01T00:00:00.000Z' }

/** A NotificationChannel recording what it sends, failing the first `failures` calls. */
class FakeChannel implements NotificationChannel {
  readonly sent: Notification[] = []
  failures = 0

  send(notification: Notification): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1
      return Promise.reject(new Error('channel unavailable'))
    }
    this.sent.push(notification)
    return Promise.resolve()
  }
}

// TestApp runs the real worker (consumers subscribed) on the in-memory broker. Messages are sent
// like an external producer would, through the real pipeline: decoding, schema validation,
// handler selection by type, retries, dead-lettering.
describe('user events', () => {
  let app: TestApp
  let driver: MemoryDriver
  let channel: FakeChannel

  beforeEach(async () => {
    driver = memory()
    channel = new FakeChannel()
    app = await TestApp.create({
      metadata,
      plugins: [
        ObservabilityPlugin.configure({ logging: { level: 'silent' }, metrics: false }),
        MessagingPlugin.configure({ driver }),
      ],
      overrides: [
        ['NotificationChannel', channel], // the local interface, by display name
        [CLOCK, frozenClock], // a provider of the shared library
      ],
    })
  })

  afterEach(async () => {
    await app.close()
  })

  const send = (type: string, payload: unknown): string => driver.send(USER_EVENTS_QUEUE, { type, payload })

  it('user.registered sends a welcome notification', async () => {
    send(UserEventType.Registered, ada)
    await driver.idle()

    expect(channel.sent).toEqual([
      {
        id: expect.any(String), // RandomIdGenerator: the library default
        to: 'ada@example.com',
        template: 'welcome',
        subject: 'Welcome aboard, Ada!',
        createdAt: '2026-01-02T00:00:00.000Z',
      },
    ])
    expect(driver.settlements(USER_EVENTS_QUEUE)).toMatchObject([{ action: 'ack', attempt: 1 }])
    expect(app.get(UserDirectory).find('u1')).toMatchObject({ email: 'ada@example.com' })
  })

  it('a redelivered event is handled once', async () => {
    send(UserEventType.Registered, ada)
    send(UserEventType.Registered, ada)
    await driver.idle()

    expect(channel.sent).toHaveLength(1)
    expect(driver.settlements(USER_EVENTS_QUEUE).map(settlement => settlement.action)).toEqual(['ack', 'ack'])
  })

  it('user.deleted says goodbye to a user known from user.registered', async () => {
    send(UserEventType.Registered, ada)
    send(UserEventType.Deleted, { id: 'u1', at: '2026-01-03T00:00:00.000Z' })
    await driver.idle()

    expect(channel.sent.map(notification => notification.template)).toEqual(['welcome', 'goodbye'])
    expect(app.get(UserDirectory).size).toBe(0)
  })

  it('a failing channel is retried (@Retry), then the message is acknowledged', async () => {
    channel.failures = 1
    send(UserEventType.Registered, ada)
    await driver.idle()

    expect(channel.sent).toHaveLength(1)
    expect(driver.settlements(USER_EVENTS_QUEUE).map(({ action, attempt }) => [action, attempt])).toEqual([
      ['retry', 1],
      ['ack', 2],
    ])
  })

  it('an invalid payload is dead-lettered without retry', async () => {
    send(UserEventType.Registered, { id: 'u2', name: 'No email' })
    await driver.idle()

    expect(channel.sent).toEqual([])
    expect(driver.deadLetters(USER_EVENTS_QUEUE)).toMatchObject([
      { queue: 'user-events.dlq', reason: 'validation', attempt: 1 },
    ])
  })
})
