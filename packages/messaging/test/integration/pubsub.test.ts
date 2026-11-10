import type { ClientConfig } from '@google-cloud/pubsub'
import type { InboundMessage } from '../../src/index.ts'

import { PubSub, v1 } from '@google-cloud/pubsub'
import { PubSubEmulatorContainer, type StartedPubSubEmulatorContainer } from '@testcontainers/gcloud'

import { pubsub } from '../../src/drivers/pubsub.ts'
import { MessageBroker } from '../../src/index.ts'
import { handler, sleep } from '../helpers.ts'
import { driverConformance, integration, startApp, waitFor } from './conformance.ts'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

/** The emulators image of the Google Cloud CLI (gcloud beta emulators pubsub start). */
const EMULATOR_IMAGE = 'gcr.io/google.com/cloudsdktool/google-cloud-cli:576.0.0-emulators'

describe.skipIf(!integration)('Pub/Sub (emulator testcontainers)', () => {
  let container: StartedPubSubEmulatorContainer
  let config: ClientConfig
  let client: PubSub
  let publisher: v1.PublisherClient
  let subscriber: v1.SubscriberClient
  let project: string

  beforeAll(async () => {
    container = await new PubSubEmulatorContainer(EMULATOR_IMAGE).start()
    project = container.getProjectId()
    config = { apiEndpoint: container.getEmulatorEndpoint(), projectId: project }
    client = new PubSub(config)
    const clientConfig = (await client.getClientConfig()) as ConstructorParameters<typeof v1.PublisherClient>[0]
    publisher = new v1.PublisherClient(clientConfig)
    subscriber = new v1.SubscriberClient(clientConfig)
  }, 180_000)

  afterAll(async () => {
    await publisher?.close()
    await subscriber?.close()
    await client?.close()
    await container?.stop()
  })

  const topicPath = (name: string): string => `projects/${project}/topics/${name}`
  const subscriptionPath = (name: string): string => `projects/${project}/subscriptions/${name}`

  /** A topic and a subscription of the same name. */
  async function createQueue(
    name: string,
    settings: { deadLetterTopic?: string; maxDeliveryAttempts?: number; ordering?: boolean } = {},
  ): Promise<void> {
    await publisher.createTopic({ name: topicPath(name) })
    await subscriber.createSubscription({
      name: subscriptionPath(name),
      topic: topicPath(name),
      ackDeadlineSeconds: 10,
      enableMessageOrdering: settings.ordering ?? false,
      ...(settings.deadLetterTopic === undefined
        ? {}
        : {
            deadLetterPolicy: {
              deadLetterTopic: topicPath(settings.deadLetterTopic),
              maxDeliveryAttempts: settings.maxDeliveryAttempts ?? 5,
            },
          }),
    })
  }

  driverConformance(
    'pubsub',
    () => ({
      createDriver: overrides => pubsub({ clientConfig: config, pullTimeoutMs: 1000, ...overrides }),
      prepareQueue: async queue => {
        await createQueue(`${queue}-dlq`)
        await createQueue(queue)
      },
      nativeDelayMs: 2000,
    }),
    { delayedPublish: false },
  )

  it('counts attempts natively and lets the subscription dead-letter (retries: subscription)', async () => {
    const queue = `owned-${Date.now()}`
    await createQueue(`${queue}-dead`)
    await createQueue(queue, { deadLetterTopic: `${queue}-dead`, maxDeliveryAttempts: 5 })
    const attempts: number[] = []
    const dead: InboundMessage[] = []
    class FailingConsumer {
      handle(_payload: unknown, message: InboundMessage) {
        attempts.push(message.attempt)
        throw new Error('fail')
      }
    }
    class Collector {
      collect(_payload: unknown, message: InboundMessage) {
        dead.push(message)
      }
    }
    const app = await startApp(pubsub({ clientConfig: config, pullTimeoutMs: 1000, retries: 'subscription' }), [
      {
        class: FailingConsumer,
        queue,
        handlers: [handler('handle', { retry: { attempts: 5, backoff: 'fixed', delay: 30_000 } })],
      },
      {
        class: Collector,
        queue: `${queue}-dead`,
        // the collector's subscription has no dead-letter policy: Znight owns its failures
        options: { deadLetter: false, retries: 'znight' },
        handlers: [handler('collect')],
      },
    ])
    await app.get(MessageBroker).publish(queue, { owned: true }, { headers: { keep: 'me' } })
    await waitFor(() => dead.length === 1, 60_000, 'the message forwarded by the subscription')
    expect(attempts).toEqual([1, 2, 3, 4, 5])
    expect(dead[0]?.payload).toEqual({ owned: true })
    expect(dead[0]?.headers).toMatchObject({ keep: 'me', CloudPubSubDeadLetterSourceDeliveryCount: '5' })
  })

  it('refuses a dead-letter policy that would forward a message before its last attempt', async () => {
    const queue = `steal-${Date.now()}`
    await createQueue(`${queue}-dead`)
    await createQueue(queue, { deadLetterTopic: `${queue}-dead`, maxDeliveryAttempts: 5 })
    class Consumer {
      handle() {}
    }
    await expect(
      startApp(pubsub({ clientConfig: config }), [
        {
          class: Consumer,
          queue,
          handlers: [handler('handle', { retry: { attempts: 6, backoff: 'fixed', delay: 1 } })],
        },
      ]),
    ).rejects.toThrow('after 5 delivery attempt(s), but Consumer allows 6 attempt(s)')
  })

  it('fails to subscribe when the subscription is missing, and provisions it on demand', async () => {
    const queue = `provisioned-${Date.now()}`
    class Consumer {
      received: unknown[] = []
      handle(payload: unknown) {
        this.received.push(payload)
      }
    }
    await expect(
      startApp(pubsub({ clientConfig: config }), [{ class: Consumer, queue, handlers: [handler('handle')] }]),
    ).rejects.toThrow(`subscription "${queue}" not found`)
    const received: unknown[] = []
    class Provisioned {
      handle(payload: unknown) {
        received.push(payload)
      }
    }
    const app = await startApp(pubsub({ clientConfig: config, provision: true, pullTimeoutMs: 1000 }), [
      { class: Provisioned, queue, handlers: [handler('handle')] },
    ])
    await app.get(MessageBroker).publish(queue, { provisioned: true })
    await waitFor(() => received.length === 1, 30_000, 'the message on the provisioned subscription')
    const [dlq] = await subscriber.getSubscription({ subscription: subscriptionPath(`${queue}-dlq`) })
    expect(dlq.topic).toBe(topicPath(`${queue}-dlq`))
  })

  it("provisions a subscription with a dead-letter policy under retries: 'subscription'", async () => {
    const queue = `provisioned-owned-${Date.now()}`
    const attempts: number[] = []
    const dead: InboundMessage[] = []
    class FailingConsumer {
      handle(_payload: unknown, message: InboundMessage) {
        attempts.push(message.attempt)
        throw new Error('fail')
      }
    }
    class Collector {
      collect(_payload: unknown, message: InboundMessage) {
        dead.push(message)
      }
    }
    const driver = pubsub({ clientConfig: config, provision: true, pullTimeoutMs: 1000, retries: 'subscription' })
    const app = await startApp(driver, [
      {
        class: FailingConsumer,
        queue,
        handlers: [handler('handle', { retry: { attempts: 5, backoff: 'fixed', delay: 0 } })],
      },
      {
        class: Collector,
        queue: `${queue}-dlq`,
        options: { deadLetter: false, retries: 'znight' },
        handlers: [handler('collect')],
      },
    ])
    const [subscription] = await subscriber.getSubscription({ subscription: subscriptionPath(queue) })
    expect(subscription.deadLetterPolicy).toMatchObject({
      deadLetterTopic: topicPath(`${queue}-dlq`),
      maxDeliveryAttempts: 5,
    })
    await app.get(MessageBroker).publish(queue, { provisioned: true })
    await waitFor(() => dead.length === 1, 60_000, 'the message forwarded by the provisioned policy')
    expect(attempts).toEqual([1, 2, 3, 4, 5])
  })

  it('handles the messages of an ordering key in order', async () => {
    const queue = `ordered-${Date.now()}`
    await createQueue(`${queue}-dlq`)
    await createQueue(queue, { ordering: true })
    const received: [string | undefined, unknown][] = []
    class Consumer {
      async handle(payload: unknown, message: InboundMessage) {
        await sleep(20)
        received.push([message.key, payload])
      }
    }
    const app = await startApp(pubsub({ clientConfig: config, pullTimeoutMs: 1000 }), [
      { class: Consumer, queue, options: { concurrency: 4 }, handlers: [handler('handle')] },
    ])
    const broker = app.get(MessageBroker)
    for (let index = 0; index < 6; index++)
      await broker.publish(queue, index, { key: index % 2 === 0 ? 'even' : 'odd' })
    await waitFor(() => received.length === 6, 30_000, 'six messages')
    expect(received.filter(([key]) => key === 'even').map(([, payload]) => payload)).toEqual([0, 2, 4])
    expect(received.filter(([key]) => key === 'odd').map(([, payload]) => payload)).toEqual([1, 3, 5])
  })

  it('extends the ack deadline of long-running handlers', async () => {
    const queue = `lease-${Date.now()}`
    await createQueue(`${queue}-dlq`)
    await createQueue(queue)
    const attempts: number[] = []
    class SlowConsumer {
      async handle(_payload: unknown, message: InboundMessage) {
        attempts.push(message.attempt)
        await sleep(13_000)
      }
    }
    const app = await startApp(pubsub({ clientConfig: config, pullTimeoutMs: 1000, ackDeadlineSeconds: 10 }), [
      { class: SlowConsumer, queue, options: { concurrency: 2 }, handlers: [handler('handle')] },
    ])
    await app.get(MessageBroker).publish(queue, 1)
    await sleep(15_000)
    expect(attempts).toEqual([1])
  }, 30_000)
})
