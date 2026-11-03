import type { GraphQLOperationEvent } from '@znight/core'
import type { GraphQLContext, GraphQLGuard, ResolverContext } from '../src/index.ts'

import { GraphQLException, GraphQLTokens, MemoryPubSub, type PubSub } from '../src/index.ts'
import { executorOf } from '../src/plugin.ts'
import { bind, boot, field, graphqlMetadata } from './support/app.ts'
import { describe, expect, it } from 'bun:test'

interface Events {
  tick: number
}

let guardRuns = 0
class TickGuard implements GraphQLGuard {
  canResolve(ctx: ResolverContext): boolean {
    guardRuns++
    return ctx.args['deny'] !== true
  }
}

/** An asynchronous guard (a token check): the source starts after an await. */
class AsyncTickGuard implements GraphQLGuard {
  async canResolve(ctx: ResolverContext): Promise<boolean> {
    await Bun.sleep(1)
    return ctx.args['deny'] !== true
  }
}

class Ticks {
  constructor(readonly pubsub: PubSub<Events>) {}
  now(): number {
    return 0
  }
  ticks(_args: unknown, _parent: unknown, ctx: GraphQLContext): AsyncIterableIterator<number> {
    return this.pubsub.subscribe('tick', { signal: ctx.signal })
  }
  async *failing(): AsyncGenerator<number> {
    yield await Promise.resolve(1)
    throw new Error('source broke')
  }
}

function metadata() {
  return graphqlMetadata({
    providers: [{ class: Ticks, deps: ['@znight/graphql#PubSub'] }, TickGuard, AsyncTickGuard],
    types: [
      { kind: 'object', name: 'Query', fields: [field('now', 'Int', bind(Ticks, 'now'))] },
      {
        kind: 'object',
        name: 'Subscription',
        fields: [
          field('ticks', 'Int', bind(Ticks, 'ticks', { operation: 'subscription', guards: [TickGuard] }), {
            args: [{ name: 'deny', type: 'Boolean' }],
          }),
          field('failing', 'Int', bind(Ticks, 'failing', { operation: 'subscription' })),
          field('guardedTicks', 'Int', bind(Ticks, 'ticks', { operation: 'subscription', guards: [AsyncTickGuard] }), {
            args: [{ name: 'deny', type: 'Boolean' }],
          }),
        ],
      },
    ],
  })
}

/** Waits until `pubsub` has `count` subscribers. */
async function subscribers(pubsub: MemoryPubSub<Events>, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && pubsub.subscribers !== count; attempt++) await Bun.sleep(1)
}

describe('MemoryPubSub', () => {
  it('fans events out to every subscriber of a topic', async () => {
    const pubsub = new MemoryPubSub<Events>()
    const a = pubsub.subscribe('tick')
    const b = pubsub.subscribe('tick')
    await pubsub.publish('tick', 1)
    await pubsub.publish('tick', 2)
    expect([(await a.next()).value, (await a.next()).value, (await b.next()).value]).toEqual([1, 2, 1])
    expect(pubsub.subscribers).toBe(2)
    await a.return?.()
    expect(pubsub.subscribers).toBe(1)
    pubsub.close()
    expect(await b.next()).toEqual({ done: false, value: 2 })
    expect(await b.next()).toEqual({ done: true, value: undefined })
    expect(await pubsub.subscribe('tick').next()).toEqual({ done: true, value: undefined })
  })

  it('ends a subscriber that falls behind with SUBSCRIPTION_OVERFLOW, after its buffer', async () => {
    const pubsub = new MemoryPubSub<Events>({ bufferSize: 2 })
    const slow = pubsub.subscribe('tick')
    const fast = pubsub.subscribe('tick')
    for (let n = 1; n <= 3; n++) {
      await pubsub.publish('tick', n)
      await fast.next()
    }
    expect((await slow.next()).value).toBe(1)
    expect((await slow.next()).value).toBe(2)
    const error = await slow.next().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(GraphQLException)
    expect(error).toMatchObject({ code: 'SUBSCRIPTION_OVERFLOW' })
    expect(await slow.next()).toEqual({ done: true, value: undefined })
    expect(pubsub.subscribers).toBe(1)
  })

  it('ends a subscription when its signal aborts', async () => {
    const pubsub = new MemoryPubSub<Events>()
    const controller = new AbortController()
    const events = pubsub.subscribe('tick', { signal: controller.signal })
    const pending = events.next()
    controller.abort()
    expect(await pending).toEqual({ done: true, value: undefined })
    expect(pubsub.subscribers).toBe(0)
  })

  it('validates bufferSize', () => {
    expect(() => new MemoryPubSub({ bufferSize: 0 })).toThrow(TypeError)
  })
})

describe('subscriptions', () => {
  it('streams one result per event; guards run once, when the subscription starts', async () => {
    await using booted = await boot(metadata())
    const pubsub = booted.app.container.get(GraphQLTokens.PubSub) as MemoryPubSub<Events>
    expect(pubsub).toBeInstanceOf(MemoryPubSub)
    guardRuns = 0
    const stream = await booted.plugin.subscribe({ query: 'subscription { ticks }' })
    await subscribers(pubsub, 1)
    await pubsub.publish('tick', 1)
    await pubsub.publish('tick', 2)
    expect((await stream.next()).value).toEqual({ data: { ticks: 1 } })
    expect((await stream.next()).value).toEqual({ data: { ticks: 2 } })
    expect(guardRuns).toBe(1)
    expect(await stream.return()).toEqual({ done: true, value: undefined })
    expect(pubsub.subscribers).toBe(0)
    expect(await stream.next()).toEqual({ done: true, value: undefined })
  })

  it('gives a single error result when the subscription cannot start', async () => {
    await using booted = await boot(metadata())
    const stream = await booted.plugin.subscribe({ query: 'subscription { ticks(deny: true) }' })
    const first = await stream.next()
    expect(first.value?.errors?.[0]?.extensions).toEqual({ code: 'FORBIDDEN' })
    expect(await stream.next()).toEqual({ done: true, value: undefined })
    expect(booted.plugin.activeSubscriptions).toBe(0)
  })

  it('ends with a final error result when the source fails', async () => {
    await using booted = await boot(metadata())
    const stream = await booted.plugin.subscribe({ query: 'subscription { failing }' })
    expect((await stream.next()).value).toEqual({ data: { failing: 1 } })
    const last = await stream.next()
    expect(last.value).toEqual({
      errors: [{ message: 'Unexpected error.', path: ['failing'], extensions: { code: 'INTERNAL_SERVER_ERROR' } }],
    })
    expect(await stream.next()).toEqual({ done: true, value: undefined })
    expect(booted.logs.messages('error')).toEqual(['GraphQL: unexpected error in Subscription.failing'])
  })

  it('ends with SUBSCRIPTION_OVERFLOW when the subscriber falls behind', async () => {
    await using booted = await boot(metadata(), { subscriptions: { bufferSize: 1 } })
    const pubsub = booted.app.container.get(GraphQLTokens.PubSub) as MemoryPubSub<Events>
    const stream = await booted.plugin.subscribe({ query: 'subscription { ticks }' })
    await subscribers(pubsub, 1)
    for (let n = 1; n <= 3; n++) await pubsub.publish('tick', n)
    expect((await stream.next()).value).toEqual({ data: { ticks: 1 } })
    expect((await stream.next()).value?.errors?.[0]).toMatchObject({ extensions: { code: 'SUBSCRIPTION_OVERFLOW' } })
    expect((await stream.next()).done).toBe(true)
  })

  it('sends a query as a stream of one result', async () => {
    await using booted = await boot(metadata())
    const stream = await booted.plugin.subscribe({ query: '{ now }' })
    expect(await stream.next()).toEqual({ done: false, value: { data: { now: 0 } } })
    expect((await stream.next()).done).toBe(true)
    const invalid = await booted.plugin.subscribe({ query: 'subscription { nope }' })
    expect((await invalid.next()).value?.errors?.[0]?.extensions).toEqual({ code: 'GRAPHQL_VALIDATION_FAILED' })
  })

  it('caps active subscriptions (503)', async () => {
    await using booted = await boot(metadata(), { subscriptions: { maxActive: 1 } })
    const executor = executorOf(booted.plugin)
    const first = await executor.subscribe({ query: 'subscription { ticks }' })
    const second = await executor.subscribe({ query: 'subscription { ticks }' })
    expect(second).toMatchObject({ status: 503, result: { errors: [{ extensions: { code: 'SERVICE_UNAVAILABLE' } }] } })
    expect(booted.plugin.activeSubscriptions).toBe(1)
    await (first as { return(): Promise<unknown> }).return()
  })

  it('caps concurrent subscriptions whose source starts asynchronously, and frees failed starts', async () => {
    await using booted = await boot(metadata(), { subscriptions: { maxActive: 1 } })
    const executor = executorOf(booted.plugin)
    const query = 'subscription { guardedTicks }'
    const results = await Promise.all([1, 2, 3].map(() => executor.subscribe({ query })))
    const streams = results.filter(result => !('status' in result))
    expect(streams).toHaveLength(1)
    expect(results.filter(result => 'status' in result && result.status === 503)).toHaveLength(2)
    expect(booted.plugin.activeSubscriptions).toBe(1)
    await (streams[0] as { return(): Promise<unknown> }).return()
    expect(booted.plugin.activeSubscriptions).toBe(0)
    // a start that fails (guard) releases its slot
    const denied = await executor.subscribe({ query: 'subscription { guardedTicks(deny: true) }' })
    expect('status' in denied).toBe(false)
    expect((await (denied as AsyncIterator<{ errors?: unknown }>).next()).value?.errors).toBeDefined()
    const next = await executor.subscribe({ query })
    expect('status' in next).toBe(false)
    expect(booted.plugin.activeSubscriptions).toBe(1)
    await (next as { return(): Promise<unknown> }).return()
  })

  it('ends when the caller signal aborts', async () => {
    await using booted = await boot(metadata())
    const controller = new AbortController()
    const stream = await booted.plugin.subscribe({ query: 'subscription { ticks }' }, { signal: controller.signal })
    const pending = stream.next()
    controller.abort()
    expect(await pending).toEqual({ done: true, value: undefined })
    expect(booted.plugin.activeSubscriptions).toBe(0)
  })

  it('reports one hook event for the whole subscription', async () => {
    await using booted = await boot(metadata())
    const events: GraphQLOperationEvent[] = []
    let wrapped = 0
    booted.app.hooks.wrap('graphql:operation', async (_event, next) => {
      wrapped++
      await next()
    })
    booted.app.hooks.on('graphql:operation', event => {
      events.push({ ...event })
    })
    const pubsub = booted.app.container.get(GraphQLTokens.PubSub) as MemoryPubSub<Events>
    const stream = await booted.plugin.subscribe({ query: 'subscription Ticks { ticks }' })
    await subscribers(pubsub, 1)
    await pubsub.publish('tick', 1)
    await stream.next()
    expect(events).toEqual([])
    await stream.return()
    await Bun.sleep(0)
    expect(wrapped).toBe(1)
    expect(events.map(event => [event.operationType, event.operationName, event.outcome])).toEqual([
      ['subscription', 'Ticks', 'success'],
    ])
  })

  it('ends direct subscriptions on stop, and closes its own PubSub on dispose', async () => {
    const booted = await boot(metadata())
    const pubsub = booted.app.container.get(GraphQLTokens.PubSub) as MemoryPubSub<Events>
    const stream = await booted.plugin.subscribe({ query: 'subscription { ticks }' })
    const raw = pubsub.subscribe('tick')
    const pending = stream.next()
    await booted.app.stop()
    expect(await pending).toEqual({ done: true, value: undefined })
    expect(booted.plugin.activeSubscriptions).toBe(0)
    expect(await raw.next()).toEqual({ done: true, value: undefined })
  })

  it('does not close a PubSub given in the options', async () => {
    const own = new MemoryPubSub<Events>()
    const booted = await boot(metadata(), { pubsub: own })
    expect(booted.app.container.get(GraphQLTokens.PubSub)).toBe(own as never)
    const raw = own.subscribe('tick')
    await booted.app.stop()
    await own.publish('tick', 7)
    expect((await raw.next()).value).toBe(7)
    own.close()
  })
})
