import type { MemoryPubSub } from '@znight/graphql'

import { executeOperation, subscribeOperation } from '@znight/graphql/testing'

import { createTestApp, EDITOR, graphqlOf, READER, subscribers } from './support/app.js'
import { ADD_BOOK, DISPOSSESSED, dune, FELLOWSHIP } from './support/fixtures.js'
import { describe, expect, test as it } from 'bun:test'

/*
 * Subscriptions over Server-Sent Events, in memory: `subscribeOperation()` streams through
 * `app.injectStream()` (the whole HTTP pipeline, the access guard included, no socket) and parses the
 * `next` events into results.
 */

const ADD_REVIEW = 'mutation Add($input: NewReviewInput!) { addReview(input: $input) { id } }'

describe('Subscription.bookAdded', () => {
  it('streams the books added from now on, with their field resolvers', async () => {
    await using app = await createTestApp()
    await using events = await subscribeOperation(app, {
      query: 'subscription { bookAdded { title author { name } } }',
      headers: READER,
    })
    expect(events.status).toBe(200)
    const first = events.next() // reading starts the resolver's generator: it subscribes to the PubSub
    await subscribers(app, 1)

    await executeOperation(app, { query: ADD_BOOK, variables: { input: FELLOWSHIP }, headers: EDITOR })

    expect((await first).value).toEqual({
      data: { bookAdded: { title: 'The Fellowship of the Ring', author: { name: 'J. R. R. Tolkien' } } },
    })
  })

  it('filters by genre in the generator', async () => {
    await using app = await createTestApp()
    await using fantasy = await subscribeOperation(app, {
      query: 'subscription { bookAdded(genre: Fantasy) { title genre } }',
      headers: READER,
    })
    const first = fantasy.next()
    await subscribers(app, 1)

    await executeOperation(app, { query: ADD_BOOK, variables: { input: DISPOSSESSED }, headers: EDITOR }) // science fiction
    await executeOperation(app, { query: ADD_BOOK, variables: { input: FELLOWSHIP }, headers: EDITOR })

    expect((await first).value).toEqual({
      data: { bookAdded: { title: 'The Fellowship of the Ring', genre: 'Fantasy' } },
    })
  })

  it('return() disconnects: the generator and its PubSub subscription close', async () => {
    await using app = await createTestApp()
    const plugin = graphqlOf(app)
    const pubsub = plugin.pubsub as MemoryPubSub // the default: in-process fan-out
    const events = await subscribeOperation(app, { query: 'subscription { bookAdded { id } }', headers: READER })
    const pending = events.next({ timeoutMs: 5_000 })
    await subscribers(app, 1)
    expect(plugin.activeSubscriptions).toBe(1)
    expect((await app.inject({ url: '/health' })).json()).toMatchObject({ subscriptions: 1 })

    await events.return() // the server sees a client abort: ctx.signal, then the source's return()
    await subscribers(app, 0)

    expect(pubsub.subscribers).toBe(0)
    expect(plugin.activeSubscriptions).toBe(0)
    expect((await pending).done).toBe(true)
  })
})

describe('Subscription.reviewAdded', () => {
  it('streams the reviews of one book only', async () => {
    await using app = await createTestApp()
    await using reviews = await subscribeOperation(app, {
      query: `subscription { reviewAdded(bookId: "${dune.id}") { rating reviewer } }`,
      headers: READER,
    })
    const first = reviews.next()
    await subscribers(app, 1)

    for (const input of [
      { bookId: 'b5', rating: 2, reviewer: 'other@example.org' },
      { bookId: dune.id, rating: 5, reviewer: 'ada@example.org' },
    ]) {
      await executeOperation(app, { query: ADD_REVIEW, variables: { input }, headers: READER })
    }

    expect((await first).value).toEqual({ data: { reviewAdded: { rating: 5, reviewer: 'ada@example.org' } } })
  })
})

describe('shutdown', () => {
  it('ends the streams without complete, so that clients reconnect to another instance', async () => {
    const app = await createTestApp()
    const stream = await app.injectSse({
      method: 'POST',
      url: '/graphql',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...READER },
      body: JSON.stringify({ query: 'subscription { bookAdded { title } }' }),
    })
    const first = stream.next()
    await subscribers(app, 1)
    await executeOperation(app, { query: ADD_BOOK, variables: { input: FELLOWSHIP }, headers: EDITOR })
    expect((await first).event).toBe('next')

    const closing = app.close()
    const events: string[] = []
    for await (const message of stream) events.push(message.event)
    await closing

    expect(events).not.toContain('complete')
    expect(stream.retry).toBeGreaterThan(0) // a jittered retry: clients do not all come back at once
  })
})
