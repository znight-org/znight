/**
 * SQS driver against a fake client (the driver accepts an `SQSClient`): ordering between the lease
 * extension of an in-flight message and its settlement, dead-letter copies that SQS always accepts,
 * FIFO messages waiting behind their group when the subscription stops. The behaviour of a real queue is covered by
 * `test/integration/sqs.test.ts`.
 */
import type { SQSClient } from '@aws-sdk/client-sqs'
import type { DriverDelivery, SubscribeOptions } from '../../src/driver.ts'

import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs'

import { sqs } from '../../src/drivers/sqs.ts'
import { deferred, memoryLogger } from '../helpers.ts'
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

/** Characters SQS accepts in a message body or a string attribute. */
const SQS_TEXT = /^[\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]*$/u
/** A valid FIFO deduplication id: 1 to 128 ASCII letters, digits and punctuation. */
const DEDUPLICATION_ID = /^[\x21-\x7E]{1,128}$/

/**
 * A client delivering one message and validating the dead-letter copies the way SQS does
 * (characters, deduplication id, size): an invalid copy is rejected with a client fault.
 */
function validatingClient(message: { body: string; attributes: Record<string, string> }, maxSize = 1_048_576) {
  const sent: SendMessageCommand['input'][] = []
  const deleted: string[] = []
  let delivered = false
  const client = {
    send(command: unknown, sendOptions?: { abortSignal?: AbortSignal }): Promise<unknown> {
      if (command instanceof GetQueueAttributesCommand) return Promise.resolve({ Attributes: {} })
      if (command instanceof ReceiveMessageCommand) {
        if (!delivered) {
          delivered = true
          const attributes = Object.entries(message.attributes).map(([name, value]) => [
            name,
            { DataType: 'String', StringValue: value },
          ])
          return Promise.resolve({
            Messages: [
              {
                MessageId: '8f0e9c1a-0d39-4d5e-9b52-2b1f4b9e7a10',
                ReceiptHandle: 'receipt-1',
                Body: message.body,
                Attributes: { ApproximateReceiveCount: '4', MessageGroupId: 'g' },
                MessageAttributes: Object.fromEntries(attributes),
              },
            ],
          })
        }
        return new Promise((_resolve, reject) => {
          sendOptions?.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }
      if (command instanceof SendMessageCommand) {
        const input = command.input
        const reject = (reason: string): Promise<never> =>
          Promise.reject(Object.assign(new Error(reason), { $fault: 'client' }))
        let size = Buffer.byteLength(input.MessageBody ?? '')
        for (const [name, attribute] of Object.entries(input.MessageAttributes ?? {})) {
          const value = attribute.StringValue ?? ''
          if (!SQS_TEXT.test(value)) return reject(`InvalidParameterValue: invalid characters in ${name}`)
          size += Buffer.byteLength(name) + Buffer.byteLength(attribute.DataType ?? '') + Buffer.byteLength(value)
        }
        if (size > maxSize) return reject('InvalidParameterValue: message too long')
        const deduplication = input.MessageDeduplicationId
        if (deduplication !== undefined && !DEDUPLICATION_ID.test(deduplication)) {
          return reject('InvalidParameterValue: invalid MessageDeduplicationId')
        }
        sent.push(input)
        return Promise.resolve({ MessageId: 'copy' })
      }
      if (command instanceof DeleteMessageCommand) {
        deleted.push(command.input.ReceiptHandle as string)
        return Promise.resolve({})
      }
      return Promise.reject(new Error(`unexpected command ${String(command)}`))
    },
  }
  return { client: client as unknown as SQSClient, sent, deleted }
}

describe('dead-letter copies', () => {
  async function deadLetter(
    queue: string,
    message: Parameters<typeof validatingClient>[0],
    error: unknown,
    maxSize?: number,
  ) {
    const { client, sent, deleted } = validatingClient(message, maxSize)
    const base = 'https://sqs.eu-west-1.amazonaws.com/123456789012/'
    const driver = sqs({
      client,
      queueUrls: { [queue]: `${base}${queue}`, [deadLetterName(queue)]: `${base}${deadLetterName(queue)}` },
      waitTimeSeconds: 0,
      extendVisibility: false,
    })
    const logger = memoryLogger()
    await driver.connect({ logger })
    let failure: unknown
    let done = false
    const subscription = await driver.subscribe(
      queue,
      async delivery => {
        try {
          await delivery.deadLetter({ queue: deadLetterName(queue), reason: 'max-attempts', error, attempt: 4 })
        } catch (caught) {
          failure = caught
        }
        done = true
      },
      { ...options, deadLetterQueue: deadLetterName(queue) },
    )
    const deadline = Date.now() + 2000
    while (!done && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2))
    await subscription.cancel()
    await subscription.close()
    await driver.close()
    return { failure, sent, deleted, logger }
  }

  function deadLetterName(queue: string): string {
    return queue.endsWith('.fifo') ? `${queue.slice(0, -5)}-dlq.fifo` : `${queue}-dlq`
  }

  it('derives the FIFO deduplication id from the SQS message id, never from x-znight-id', async () => {
    const { failure, sent, deleted } = await deadLetter(
      'orders.fifo',
      { body: '{}', attributes: { 'x-znight-id': 'a b é' } },
      new Error('boom'),
    )
    expect(failure).toBeUndefined()
    expect(sent).toHaveLength(1)
    expect(sent[0]?.MessageGroupId).toBe('g')
    expect(sent[0]?.MessageAttributes?.['x-znight-id']?.StringValue).toBe('a b é')
    expect(deleted).toEqual(['receipt-1'])
  })

  it('removes the characters SQS refuses from the error, without splitting a surrogate pair', async () => {
    const message = `Unexpected token '\u0001' ${'x'.repeat(1001)}\u{1F600}${'y'.repeat(40)}`
    const { failure, sent, deleted } = await deadLetter(
      'orders',
      { body: 'AQ==', attributes: { 'x-znight-encoding': 'base64' } },
      new Error(message),
    )
    expect(failure).toBeUndefined()
    const error = sent[0]?.MessageAttributes?.['x-znight-error']?.StringValue ?? ''
    expect(error.startsWith("Unexpected token '\uFFFD' ")).toBe(true)
    expect(SQS_TEXT.test(error)).toBe(true)
    expect(deleted).toEqual(['receipt-1'])
  })

  it('falls back to a copy without the error and the headers when SQS refuses the full copy', async () => {
    const { failure, sent, deleted, logger } = await deadLetter(
      'orders',
      { body: 'x'.repeat(1500), attributes: { 'x-znight-type': 'order.created', 'x-tenant': 't'.repeat(400) } },
      new Error('e'.repeat(1000)),
      2048,
    )
    expect(failure).toBeUndefined()
    expect(sent).toHaveLength(1)
    const attributes = sent[0]?.MessageAttributes ?? {}
    expect(Object.keys(attributes).sort()).toEqual([
      'x-znight-attempts',
      'x-znight-dead-letter-reason',
      'x-znight-original-queue',
      'x-znight-type',
    ])
    expect(deleted).toEqual(['receipt-1'])
    expect(logger.entries.some(entry => entry.level === 'warn' && entry.message.includes('refused'))).toBe(true)
  })
})

describe('FIFO groups on stop', () => {
  it('closes once the messages queued behind their group were handed over and settled', async () => {
    const calls: string[] = []
    let closed = false
    let delivered = false
    const client = {
      send(command: unknown, sendOptions?: { abortSignal?: AbortSignal }): Promise<unknown> {
        if (command instanceof GetQueueAttributesCommand) return Promise.resolve({ Attributes: {} })
        if (command instanceof ReceiveMessageCommand) {
          if (!delivered) {
            delivered = true
            return Promise.resolve({
              Messages: [1, 2, 3].map(index => ({
                MessageId: `m${index}`,
                ReceiptHandle: `receipt-${index}`,
                Body: '{}',
                Attributes: { ApproximateReceiveCount: '1', MessageGroupId: 'g' },
                MessageAttributes: {},
              })),
            })
          }
          return new Promise((_resolve, reject) => {
            sendOptions?.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          })
        }
        let label = 'unexpected'
        if (command instanceof DeleteMessageCommand) label = `delete ${command.input.ReceiptHandle}`
        if (command instanceof ChangeMessageVisibilityCommand) {
          label = `visibility ${command.input.VisibilityTimeout} ${command.input.ReceiptHandle}`
        }
        if (closed) calls.push(`after close: ${label}`)
        return new Promise(resolve =>
          setTimeout(() => {
            calls.push(label)
            resolve({})
          }, 5),
        )
      },
    }
    const driver = sqs({
      client: client as unknown as SQSClient,
      queueUrls: { 'orders.fifo': `${URL}.fifo` },
      waitTimeSeconds: 0,
      extendVisibility: false,
    })
    await driver.connect({ logger: memoryLogger() })
    const first = deferred()
    let stopping = false
    const subscription = await driver.subscribe(
      'orders.fifo',
      async (delivery: DriverDelivery) => {
        // what the runtime does: handle the first message, release the ones handed over once stopping
        if (stopping) return delivery.release()
        await first.promise
        await delivery.ack()
      },
      { ...options, concurrency: 3 },
    )
    while (!delivered) await new Promise(resolve => setTimeout(resolve, 2))
    stopping = true
    await subscription.cancel()
    first.resolve()
    await subscription.close()
    await driver.close()
    closed = true
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(calls).toEqual(['delete receipt-1', 'visibility 0 receipt-2', 'visibility 0 receipt-3'])
  })
})
