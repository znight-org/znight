import type { InboundMessage } from '../../src/index.ts'

import { CreateQueueCommand, GetQueueAttributesCommand, SQSClient, type SQSClientConfig } from '@aws-sdk/client-sqs'
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack'

import { sqs } from '../../src/drivers/sqs.ts'
import { MessageBroker } from '../../src/index.ts'
import { handler, sleep } from '../helpers.ts'
import { driverConformance, integration, startApp, waitFor } from './conformance.ts'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

describe.skipIf(!integration)('SQS (LocalStack testcontainers)', () => {
  let container: StartedLocalStackContainer
  let config: SQSClientConfig
  let admin: SQSClient

  beforeAll(async () => {
    container = await new LocalstackContainer('localstack/localstack:4.4').withEnvironment({ SERVICES: 'sqs' }).start()
    config = {
      endpoint: container.getConnectionUri(),
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    }
    admin = new SQSClient(config)
  }, 180_000)

  afterAll(async () => {
    admin?.destroy()
    await container?.stop()
  })

  async function createQueue(name: string, attributes: Record<string, string> = {}): Promise<string> {
    const { QueueUrl } = await admin.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes }))
    return QueueUrl as string
  }

  async function queueArn(url: string): Promise<string> {
    const { Attributes } = await admin.send(
      new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }),
    )
    return Attributes?.QueueArn as string
  }

  driverConformance(
    'sqs',
    () => ({
      createDriver: overrides => sqs({ clientConfig: config, waitTimeSeconds: 1, visibilityTimeout: 5, ...overrides }),
      prepareQueue: async queue => {
        await createQueue(queue)
        await createQueue(`${queue}-dlq`)
      },
      nativeDelayMs: 2000,
    }),
    { delayedPublish: true },
  )

  it('refuses a RedrivePolicy that would steal retries, and uses its target otherwise', async () => {
    const dlqUrl = await createQueue(`redrive-target-${Date.now()}`)
    const arn = await queueArn(dlqUrl)
    const queue = `redrive-${Date.now()}`
    await createQueue(queue, { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: 2 }) })
    class Consumer {
      handle() {
        throw new Error('fail')
      }
    }
    const tooMany = sqs({ clientConfig: config, waitTimeSeconds: 1 })
    await expect(
      startApp(tooMany, [
        {
          class: Consumer,
          queue,
          handlers: [handler('handle', { retry: { attempts: 3, backoff: 'fixed', delay: 1 } })],
        },
      ]),
    ).rejects.toThrow('after 2 receive(s), but Consumer allows 3 attempt(s)')

    const dead: InboundMessage[] = []
    class Collector {
      collect(_payload: unknown, message: InboundMessage) {
        dead.push(message)
      }
    }
    const app = await startApp(sqs({ clientConfig: config, waitTimeSeconds: 1 }), [
      { class: Consumer, queue, handlers: [handler('handle', { retry: { attempts: 2, backoff: 'fixed', delay: 1 } })] },
      { class: Collector, queue: dlqUrl, options: { deadLetter: false }, handlers: [handler('collect')] },
    ])
    await app.get(MessageBroker).publish(queue, { redrive: true })
    await waitFor(() => dead.length === 1, 30_000, 'dead letter in the redrive target')
    expect(dead[0]?.headers['x-znight-dead-letter-reason']).toBe('max-attempts')
  })

  it('fails to subscribe when the dead-letter queue is missing', async () => {
    const queue = `no-dlq-${Date.now()}`
    await createQueue(queue)
    class Consumer {
      handle() {}
    }
    await expect(
      startApp(sqs({ clientConfig: config }), [{ class: Consumer, queue, handlers: [handler('handle')] }]),
    ).rejects.toThrow(`queue "${queue}-dlq" not found`)
  })

  it('round-trips binary payloads and orders FIFO message groups', async () => {
    const queue = `fifo-${Date.now()}.fifo`
    await createQueue(queue, { FifoQueue: 'true' })
    await createQueue(`fifo-${queue.slice(5, -5)}-dlq.fifo`, { FifoQueue: 'true' })
    const received: [string | undefined, unknown][] = []
    class Consumer {
      async handle(payload: unknown, message: InboundMessage) {
        await sleep(20)
        received.push([message.key, payload instanceof Uint8Array ? [...payload] : payload])
      }
    }
    const app = await startApp(sqs({ clientConfig: config, waitTimeSeconds: 1 }), [
      { class: Consumer, queue, options: { concurrency: 4 }, handlers: [handler('handle')] },
    ])
    const broker = app.get(MessageBroker)
    for (let index = 0; index < 4; index++)
      await broker.publish(queue, index, { key: index % 2 === 0 ? 'even' : 'odd' })
    await broker.publish(queue, new Uint8Array([0, 255, 7]), { key: 'binary' })
    await waitFor(() => received.length === 5, 30_000, 'five messages')
    expect(received.filter(([key]) => key === 'even').map(([, payload]) => payload)).toEqual([0, 2])
    expect(received.filter(([key]) => key === 'odd').map(([, payload]) => payload)).toEqual([1, 3])
    expect(received.find(([key]) => key === 'binary')?.[1]).toEqual([0, 255, 7])
    await expect(broker.publish(queue, 1, { delay: 1000 })).rejects.toThrow('does not support per-message delays')
  })

  it('extends the visibility of long-running handlers', async () => {
    const queue = `lease-${Date.now()}`
    await createQueue(queue)
    await createQueue(`${queue}-dlq`)
    const attempts: number[] = []
    class SlowConsumer {
      async handle(_payload: unknown, message: InboundMessage) {
        attempts.push(message.attempt)
        await sleep(3500)
      }
    }
    const app = await startApp(sqs({ clientConfig: config, waitTimeSeconds: 1, visibilityTimeout: 2 }), [
      { class: SlowConsumer, queue, options: { concurrency: 2 }, handlers: [handler('handle')] },
    ])
    await app.get(MessageBroker).publish(queue, 1)
    await sleep(5000)
    expect(attempts).toEqual([1])
  })

  it('rejects messages with too many headers', async () => {
    const queue = `attrs-${Date.now()}`
    await createQueue(queue)
    const driver = sqs({ clientConfig: config })
    await driver.connect({ logger: console })
    const headers = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`h${index}`, 'v']))
    await expect(
      driver.publish(queue, {
        id: 'x',
        type: 't',
        key: undefined,
        headers,
        body: '1',
        contentType: 'application/json',
        timestamp: Date.now(),
        delayMs: 0,
      }),
    ).rejects.toThrow('at most 10 attributes')
    await driver.close()
  })
})
