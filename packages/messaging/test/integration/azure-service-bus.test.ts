import type { InboundMessage } from '../../src/index.ts'

import { ServiceBusAdministrationClient, ServiceBusClient } from '@azure/service-bus'
import { AzureServiceBusContainer, type StartedAzureServiceBusContainer } from '@testcontainers/azureservicebus'

import { type AzureServiceBusDriverOptions, azureServiceBus } from '../../src/drivers/azure-service-bus.ts'
import { MessageBroker } from '../../src/index.ts'
import { describeDriverConformance } from '../../src/testing.ts'
import { handler, sleep } from '../helpers.ts'
import { integration, startApp, stopApps, waitFor } from './support.ts'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'

/** The official Service Bus emulator (it starts a SQL Server container next to it). */
const EMULATOR_IMAGE = 'mcr.microsoft.com/azure-messaging/servicebus-emulator:2.0.1'
/** Port of the emulator's administration (HTTP) endpoint. */
const ADMIN_PORT = 5300

/** The emulator needs at least one entity in its configuration; the tests create theirs. */
const EMULATOR_CONFIG = {
  UserConfig: {
    Namespaces: [
      {
        Name: 'sbemulatorns',
        Queues: [
          {
            Name: 'bootstrap',
            Properties: {
              DeadLetteringOnMessageExpiration: false,
              DefaultMessageTimeToLive: 'PT1H',
              DuplicateDetectionHistoryTimeWindow: 'PT20S',
              ForwardDeadLetteredMessagesTo: '',
              ForwardTo: '',
              LockDuration: 'PT1M',
              MaxDeliveryCount: 10,
              RequiresDuplicateDetection: false,
              RequiresSession: false,
            },
          },
        ],
        Topics: [],
      },
    ],
    Logging: { Type: 'File' },
  },
}

describe.skipIf(!integration)('Azure Service Bus (emulator testcontainers)', () => {
  afterEach(stopApps)

  let container: StartedAzureServiceBusContainer
  let connectionString: string
  let admin: ServiceBusAdministrationClient

  beforeAll(async () => {
    container = await new AzureServiceBusContainer(EMULATOR_IMAGE)
      .acceptLicense()
      .withConfig(JSON.stringify(EMULATOR_CONFIG))
      .start()
    connectionString = container.getConnectionString()
    const adminPort = container.getMappedPort(ADMIN_PORT)
    admin = new ServiceBusAdministrationClient(connectionString.replace(/:\d+;/, `:${adminPort};`))
  }, 300_000)

  afterAll(async () => {
    await container?.stop()
  })

  const driver = (options: Partial<AzureServiceBusDriverOptions> = {}) =>
    azureServiceBus({ connectionString, administrationClient: admin, maxWaitTimeMs: 1000, ...options })

  describeDriverConformance({
    name: 'azure-service-bus',
    driver: overrides => driver(overrides),
    prepareQueue: async queue => {
      await admin.createQueue(queue, { maxDeliveryCount: 10, lockDuration: 'PT30S' })
    },
    test: { describe, it },
    timeoutMs: 120_000,
  })

  it('fans a topic out to its subscriptions', async () => {
    const topic = `events-${Date.now()}`
    await admin.createTopic(topic)
    await admin.createSubscription(topic, 'billing')
    await admin.createSubscription(topic, 'audit')
    const billing: InboundMessage[] = []
    const audit: InboundMessage[] = []
    class BillingConsumer {
      handle(_payload: unknown, message: InboundMessage) {
        billing.push(message)
      }
    }
    class AuditConsumer {
      handle(_payload: unknown, message: InboundMessage) {
        audit.push(message)
      }
    }
    const app = await startApp(driver({ subscriptions: { billing: `${topic}/billing` } }), [
      { class: BillingConsumer, queue: 'billing', handlers: [handler('handle')] },
      { class: AuditConsumer, queue: `${topic}/audit`, handlers: [handler('handle')] },
    ])
    await app.get(MessageBroker).publish(topic, { id: 1 }, { type: 'invoice', headers: { keep: 'me' } })
    await waitFor(() => billing.length === 1 && audit.length === 1, 30_000, 'both subscriptions')
    expect(billing[0]).toMatchObject({ type: 'invoice', payload: { id: 1 }, headers: { keep: 'me' } })
    expect(audit[0]?.id).toBe(billing[0]?.id as string)
  })

  it("lets the entity own retries and dead letters (retries: 'entity')", async () => {
    const queue = `owned-${Date.now()}`
    await admin.createQueue(queue, { maxDeliveryCount: 3 })
    const attempts: number[] = []
    const dead: InboundMessage[] = []
    class FailingConsumer {
      handle(_payload: unknown, message: InboundMessage) {
        attempts.push(message.attempt)
        throw new Error('fail')
      }
    }
    class Collector {
      handle(_payload: unknown, message: InboundMessage) {
        dead.push(message)
      }
    }
    const app = await startApp(driver({ retries: 'entity' }), [
      {
        class: FailingConsumer,
        queue,
        handlers: [handler('handle', { retry: { attempts: 3, backoff: 'fixed', delay: 30_000 } })],
      },
      {
        class: Collector,
        queue: `${queue}/$deadletterqueue`,
        options: { deadLetter: false, retries: 'znight' },
        handlers: [handler('handle')],
      },
    ])
    await app.get(MessageBroker).publish(queue, { owned: true }, { headers: { keep: 'me' } })
    await waitFor(() => dead.length === 1, 30_000, 'the message dead-lettered by the entity').catch(
      (error: unknown) => {
        throw new Error(`${String(error)} (attempts: ${attempts.join(', ')})`)
      },
    )
    expect(attempts).toEqual([1, 2, 3])
    expect(dead[0]?.payload).toEqual({ owned: true })
    expect(dead[0]?.attempt).toBe(1)
    expect(dead[0]?.headers).toMatchObject({ keep: 'me', DeadLetterReason: 'MaxDeliveryCountExceeded' })
  })

  it('fails to subscribe when the queue is missing, and provisions it on demand', async () => {
    const queue = `provisioned-${Date.now()}`
    class Consumer {
      handle() {}
    }
    await expect(startApp(driver(), [{ class: Consumer, queue, handlers: [handler('handle')] }])).rejects.toThrow(
      `queue "${queue}" not found`,
    )
    const received: unknown[] = []
    class Provisioned {
      handle(payload: unknown) {
        received.push(payload)
      }
    }
    const app = await startApp(driver({ provision: true }), [
      {
        class: Provisioned,
        queue,
        // the emulator accepts a maxDeliveryCount up to 10 (the service up to 2000)
        handlers: [handler('handle', { retry: { attempts: 4, backoff: 'fixed', delay: 1 } })],
      },
    ])
    await app.get(MessageBroker).publish(queue, { provisioned: true })
    await waitFor(() => received.length === 1, 30_000, 'the message on the provisioned queue')
    expect((await admin.getQueue(queue)).maxDeliveryCount).toBe(10)
  })

  it('refuses session-enabled queues', async () => {
    const queue = `sessions-${Date.now()}`
    await admin.createQueue(queue, { requiresSession: true })
    class Consumer {
      handle() {}
    }
    await expect(startApp(driver(), [{ class: Consumer, queue, handlers: [handler('handle')] }])).rejects.toThrow(
      `queue "${queue}" requires sessions`,
    )
    // without the administration client, the first receive detects it (a peek would not)
    await expect(
      startApp(driver({ administrationClient: false }), [{ class: Consumer, queue, handlers: [handler('handle')] }]),
    ).rejects.toThrow(`queue "${queue}" requires sessions`)
  })

  it('renews the lock of long-running handlers', async () => {
    const queue = `lease-${Date.now()}`
    await admin.createQueue(queue, { lockDuration: 'PT5S' })
    const attempts: number[] = []
    class SlowConsumer {
      async handle(_payload: unknown, message: InboundMessage) {
        attempts.push(message.attempt)
        await sleep(9000)
      }
    }
    const app = await startApp(driver(), [
      { class: SlowConsumer, queue, options: { concurrency: 2 }, handlers: [handler('handle')] },
    ])
    await app.get(MessageBroker).publish(queue, 1)
    await sleep(12_000)
    expect(attempts).toEqual([1])
    // completed after the lock was renewed: nothing left (the emulator has no runtime properties API)
    const client = new ServiceBusClient(connectionString)
    try {
      expect(await client.createReceiver(queue).peekMessages(1)).toEqual([])
    } finally {
      await client.close()
    }
  }, 30_000)
})
