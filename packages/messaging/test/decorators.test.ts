import type { InboundMessage } from '../src/index.ts'

import { z } from 'zod'

import { Consumer, Ctx, Headers, Message, OnError, OnMessage, Retry } from '../src/index.ts'
import { describe, expect, it } from 'bun:test'

const OrderCreated = z.object({ id: z.number() })

describe('decorators', () => {
  it('are no-op markers usable with experimentalDecorators', () => {
    @Consumer('orders')
    class OrderConsumer {
      calls = 0

      @OnMessage('order.created')
      @Retry({ attempts: 3, backoff: 'exponential', delay: 100, maxDelay: 1000 })
      created(@Message(OrderCreated) _order: z.output<typeof OrderCreated>, @Headers('x-tenant') _tenant?: string) {
        this.calls++
      }

      @OnMessage()
      fallback(
        @Message() _payload: unknown,
        @Headers() _headers: Record<string, string>,
        @Ctx() _message: InboundMessage,
      ) {
        this.calls++
      }

      @OnError()
      onError(_error: unknown, message: InboundMessage) {
        return message.attempt > 1 ? 'ack' : undefined
      }
    }

    @Consumer({ queue: 'jobs', scope: 'request', concurrency: 4, deadLetter: false, groupId: 'workers' })
    class JobConsumer {
      @OnMessage()
      handle() {}

      @OnError()
      async onError() {
        await Promise.resolve()
      }
    }

    const consumer = new OrderConsumer()
    consumer.created({ id: 1 })
    consumer.fallback(1, {}, {} as InboundMessage)
    expect(consumer.calls).toBe(2)
    expect(new JobConsumer()).toBeInstanceOf(JobConsumer)
    expect(Consumer('x')).toBe(Consumer({ queue: 'y' }))
    expect(OnMessage()).toBe(Retry({ attempts: 1 }))
    expect(Message()).toBe(Headers())
    expect(Ctx()).toBe(Message(OrderCreated))
  })

  it('type-checks @OnError signatures', () => {
    class Checked {
      // @ts-expect-error -- an error handler may only return 'ack' or nothing
      @OnError()
      wrongResult(): string {
        return 'nack'
      }

      // @ts-expect-error -- the second parameter receives an InboundMessage
      @OnError()
      wrongMessage(_error: unknown, _message: number) {}

      @OnError()
      narrowError(_error: Error) {
        return 'ack' as const
      }
    }
    expect(new Checked().narrowError(new Error())).toBe('ack')
  })

  it('type-checks decorator arguments', () => {
    // @ts-expect-error -- the queue is required
    Consumer({ concurrency: 1 })
    // @ts-expect-error -- attempts is required
    Retry({ delay: 1 })
    // @ts-expect-error -- unknown backoff strategy
    Retry({ attempts: 2, backoff: 'linear' })
    // @ts-expect-error -- not a Standard Schema
    Message({ parse: () => 1 })
    expect(true).toBe(true)
  })
})
