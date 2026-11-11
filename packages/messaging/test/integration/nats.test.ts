import type { JetStreamClient, JetStreamManager } from '@nats-io/jetstream'
import type { NatsConnection } from '@nats-io/transport-node'
import type { InboundMessage } from '../../src/index.ts'

import { jetstream } from '@nats-io/jetstream'
import { connect } from '@nats-io/transport-node'
import { NatsContainer, type StartedNatsContainer } from '@testcontainers/nats'

import { nats } from '../../src/drivers/nats.ts'
import { MessageBroker, MessagingHeaders } from '../../src/index.ts'
import { describeDriverConformance } from '../../src/testing.ts'
import { handler, sleep } from '../helpers.ts'
import { integration, startApp, startContainer, stopApps, waitFor } from './support.ts'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'

const IMAGE = 'nats:2.14.9'
const NANOS_PER_MS = 1_000_000

describe.skipIf(!integration)('NATS JetStream (testcontainers)', () => {
  afterEach(stopApps)

  let container: StartedNatsContainer
  /** Servers and credentials of the container (the image is started with a user). */
  let base: { servers: string[]; connectionOptions: { user?: string; pass?: string } }
  let connection: NatsConnection
  let js: JetStreamClient
  let jsm: JetStreamManager

  beforeAll(async () => {
    container = await startContainer(() => new NatsContainer(IMAGE).withJetStream().start())
    const { user, pass } = container.getConnectionOptions()
    base = {
      servers: [`${container.getHost()}:${container.getMappedPort(4222)}`],
      connectionOptions: { ...(user === undefined ? {} : { user }), ...(pass === undefined ? {} : { pass }) },
    }
    connection = await connect({ ...base.connectionOptions, servers: base.servers })
    js = jetstream(connection)
    jsm = await js.jetstreamManager()
  }, 180_000)

  afterAll(async () => {
    await connection?.drain()
    await container?.stop()
  })

  /** A stream capturing `queue`, and one capturing its dead-letter subject. */
  async function createQueue(queue: string): Promise<void> {
    await jsm.streams.add({ name: queue, subjects: [queue] })
    await jsm.streams.add({ name: `${queue}_dlq`, subjects: [`${queue}.dlq`] })
  }

  describeDriverConformance({
    name: 'nats',
    driver: overrides => nats({ ...base, fetchExpiresMs: 1000, ...overrides }),
    prepareQueue: (queue, deadLetterQueue) =>
      jsm.streams
        .add({ name: queue, subjects: [queue] })
        .then(() => jsm.streams.add({ name: `${queue}_dlq`, subjects: [deadLetterQueue] }))
        .then(() => undefined),
    test: { describe, it },
    nativeDelayMs: 500,
    timeoutMs: 60_000,
  })

  it('creates the durable pull consumer with explicit acks and unlimited deliveries', async () => {
    const queue = `created-${Date.now()}`
    await createQueue(queue)
    class Consumer {
      handle() {}
    }
    await startApp(nats({ ...base, ackWaitMs: 5000 }), [{ class: Consumer, queue, handlers: [handler('handle')] }])
    const info = await jsm.consumers.info(queue, `znight-${queue}`)
    expect(info.config).toMatchObject({
      durable_name: `znight-${queue}`,
      filter_subject: queue,
      ack_policy: 'explicit',
      max_deliver: -1,
      ack_wait: 5000 * NANOS_PER_MS,
    })
    expect(info.config.deliver_subject).toBeUndefined()
  })

  it('fails to subscribe without a stream, and provisions the streams on demand', async () => {
    const queue = `provisioned-${Date.now()}`
    class Consumer {
      handle() {}
    }
    await expect(
      startApp(nats({ ...base }), [{ class: Consumer, queue, handlers: [handler('handle')] }]),
    ).rejects.toThrow(`no stream captures the subject "${queue}"`)
    const received: unknown[] = []
    class Provisioned {
      handle(payload: unknown) {
        received.push(payload)
      }
    }
    const app = await startApp(nats({ ...base, provision: true, fetchExpiresMs: 1000 }), [
      { class: Provisioned, queue, handlers: [handler('handle')] },
    ])
    await app.get(MessageBroker).publish(queue, { provisioned: true })
    await waitFor(() => received.length === 1, 30_000, 'the message on the provisioned stream')
    expect(await jsm.streams.find(`${queue}.dlq`)).toBe(`${queue}_dlq`)
  })

  it('refuses a consumer whose max_deliver stops before the last attempt', async () => {
    const queue = `limited-${Date.now()}`
    await createQueue(queue)
    await jsm.consumers.add(queue, {
      durable_name: `znight-${queue}`,
      filter_subject: queue,
      ack_policy: 'explicit',
      max_deliver: 2,
    })
    class Consumer {
      handle() {}
    }
    await expect(
      startApp(nats({ ...base }), [
        {
          class: Consumer,
          queue,
          handlers: [handler('handle', { retry: { attempts: 3, backoff: 'fixed', delay: 1 } })],
        },
      ]),
    ).rejects.toThrow('stops delivering a message after 2 deliveries, but Consumer allows 3 attempt(s)')
  })

  it('dead-letters the messages JetStream stops delivering (max_deliver advisory)', async () => {
    const queue = `advisory-${Date.now()}`
    await createQueue(queue)
    const durable = `znight-${queue}`
    await jsm.consumers.add(queue, {
      durable_name: durable,
      filter_subject: queue,
      ack_policy: 'explicit',
      ack_wait: 1000 * NANOS_PER_MS,
      max_deliver: 1,
    })
    // delivered once outside the application and never acknowledged: its only delivery is spent
    await js.publish(queue, JSON.stringify({ spent: true }), { msgID: `spent-${queue}` })
    const fetched = await (await js.consumers.get(queue, durable)).next({ expires: 5000 })
    expect(fetched?.info.deliveryCount).toBe(1)
    const handled: unknown[] = []
    const dead: InboundMessage[] = []
    class Consumer {
      handle(payload: unknown) {
        handled.push(payload)
      }
    }
    class Collector {
      collect(_payload: unknown, message: InboundMessage) {
        dead.push(message)
      }
    }
    await startApp(nats({ ...base, fetchExpiresMs: 1000 }), [
      // one attempt: max_deliver 1 allows it
      { class: Consumer, queue, handlers: [handler('handle', { retry: { attempts: 1, backoff: 'fixed', delay: 0 } })] },
      { class: Collector, queue: `${queue}.dlq`, options: { deadLetter: false }, handlers: [handler('collect')] },
    ])
    await waitFor(() => dead.length === 1, 30_000, 'the dead letter of the advisory')
    expect(handled).toEqual([])
    expect(dead[0]?.payload).toEqual({ spent: true })
    expect(dead[0]?.headers).toMatchObject({
      [MessagingHeaders.DeadLetterReason]: 'max-attempts',
      [MessagingHeaders.OriginalQueue]: queue,
      [MessagingHeaders.Attempts]: '1',
    })
  })

  it('extends the ack wait of long-running handlers', async () => {
    const queue = `working-${Date.now()}`
    await createQueue(queue)
    const attempts: number[] = []
    class Slow {
      async handle(_payload: unknown, message: InboundMessage) {
        attempts.push(message.attempt)
        await sleep(3000)
      }
    }
    const app = await startApp(nats({ ...base, ackWaitMs: 1000, fetchExpiresMs: 1000 }), [
      { class: Slow, queue, options: { concurrency: 2 }, handlers: [handler('handle')] },
    ])
    await app.get(MessageBroker).publish(queue, 1)
    await sleep(4500)
    expect(attempts).toEqual([1])
  }, 30_000)
})
