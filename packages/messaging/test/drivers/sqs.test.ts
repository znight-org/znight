/**
 * SQS driver against a fake client (the driver accepts an `SQSClient`): ordering between the lease
 * extension of an in-flight message and its settlement. The behaviour of a real queue is covered by
 * `test/integration/sqs.test.ts`.
 */
import type { SQSClient } from '@aws-sdk/client-sqs'
import type { DriverDelivery, SubscribeOptions } from '../../src/driver.ts'

import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs'

import { sqs } from '../../src/drivers/sqs.ts'
import { memoryLogger } from '../helpers.ts'
import { describe, expect, it, jest } from 'bun:test'

const URL = 'https://sqs.eu-west-1.amazonaws.com/123456789012/orders'

const options: SubscribeOptions = {
  consumer: 'OrderConsumer',
  concurrency: 1,
  deadLetterQueue: undefined,
  maxAttempts: 3,
  retryDelays: [],
  options: {},
}

/**
 * A client answering after `latency(command)` ms, recording the visibility changes in the order SQS
 * applies them (`applied`), and delivering a single message.
 */
function fakeClient(latency: (command: ChangeMessageVisibilityCommand | DeleteMessageCommand) => number) {
  const applied: string[] = []
  let delivered = false
  const respond = (command: ChangeMessageVisibilityCommand | DeleteMessageCommand, label: string): Promise<object> =>
    new Promise(resolve =>
      setTimeout(() => {
        applied.push(label)
        resolve({})
      }, latency(command)),
    )
  const client = {
    send(command: unknown, sendOptions?: { abortSignal?: AbortSignal }): Promise<unknown> {
      if (command instanceof GetQueueAttributesCommand) return Promise.resolve({ Attributes: {} })
      if (command instanceof ReceiveMessageCommand) {
        if (!delivered) {
          delivered = true
          return Promise.resolve({
            Messages: [
              {
                MessageId: 'm1',
                ReceiptHandle: 'receipt-1',
                Body: '{}',
                Attributes: { ApproximateReceiveCount: '1' },
                MessageAttributes: {},
              },
            ],
          })
        }
        // long polling until the subscription stops
        return new Promise((_resolve, reject) => {
          sendOptions?.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }
      if (command instanceof ChangeMessageVisibilityCommand) {
        return respond(command, `visibility ${command.input.VisibilityTimeout}`)
      }
      if (command instanceof DeleteMessageCommand) return respond(command, 'delete')
      return Promise.reject(new Error(`unexpected command ${String(command)}`))
    },
  }
  return { client: client as unknown as SQSClient, applied }
}

/**
 * Subscribes with a 2 s visibility timeout (the lease is extended every second) and settles the
 * single message after `afterMs`; returns the visibility changes once everything landed (fake clock).
 */
async function settleAfter(
  afterMs: number,
  latency: Parameters<typeof fakeClient>[0],
  settle: (delivery: DriverDelivery) => Promise<void>,
): Promise<string[]> {
  jest.useFakeTimers()
  try {
    const { client, applied } = fakeClient(latency)
    const driver = sqs({ client, queueUrls: { orders: URL }, visibilityTimeout: 2, waitTimeSeconds: 0 })
    await driver.connect({ logger: memoryLogger() })
    let settled = false
    const subscription = await driver.subscribe(
      'orders',
      async delivery => {
        await new Promise(resolve => setTimeout(resolve, afterMs))
        await settle(delivery)
        settled = true
      },
      options,
    )
    for (let elapsed = 0; elapsed < 2500; elapsed += 10) {
      jest.advanceTimersByTime(10)
      for (let tick = 0; tick < 20; tick++) await Promise.resolve()
    }
    expect(settled).toBe(true)
    await subscription.cancel()
    await subscription.close()
    await driver.close()
    return applied
  } finally {
    jest.useRealTimers()
  }
}

const isExtension = (command: ChangeMessageVisibilityCommand | DeleteMessageCommand): boolean =>
  command instanceof ChangeMessageVisibilityCommand && command.input.VisibilityTimeout === 2

describe('lease extension and settlements', () => {
  it('waits for the extension in flight before the retry sets the visibility', async () => {
    // extension sent at 1 s, applied at 1.4 s; the retry starts at 1.1 s
    const applied = await settleAfter(
      1100,
      command => (isExtension(command) ? 400 : 50),
      delivery => delivery.retry({ attempt: 2, delayMs: 300_000, error: new Error('boom') }),
    )
    expect(applied).toEqual(['visibility 2', 'visibility 300'])
  })

  it('stops extending the lease once a retry is in flight', async () => {
    // retry sent at 0.9 s, applied at 1.1 s: the extension due at 1 s must not override it
    const applied = await settleAfter(
      900,
      () => 200,
      delivery => delivery.retry({ attempt: 2, delayMs: 300_000, error: new Error('boom') }),
    )
    expect(applied).toEqual(['visibility 300'])
  })

  it('stops extending the lease once a release or an acknowledgement is in flight', async () => {
    expect(
      await settleAfter(
        900,
        () => 200,
        delivery => delivery.release(),
      ),
    ).toEqual(['visibility 0'])
    expect(
      await settleAfter(
        900,
        () => 200,
        delivery => delivery.ack(),
      ),
    ).toEqual(['delete'])
  })
})
