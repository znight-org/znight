import { MAX_TICKETS_PER_USER, TicketStore } from '../src/auth/tickets.js'
import { afterEach, describe, expect, test as it, setSystemTime } from 'bun:test'

const BOB = { name: 'bob', roles: [] }

describe('TicketStore', () => {
  afterEach(() => {
    setSystemTime()
  })

  it('consumes a ticket once, within 30 s', () => {
    const store = new TicketStore()
    const once = store.issue(BOB)
    expect(store.consume(once)).toEqual(BOB)
    expect(store.consume(once)).toBeUndefined()

    const start = Date.now()
    setSystemTime(start)
    const late = store.issue(BOB)
    setSystemTime(start + 30_001)
    expect(store.consume(late)).toBeUndefined()
    expect(store.size).toBe(0)
  })

  it('drops expired tickets that were never presented', () => {
    const store = new TicketStore()
    const start = Date.now()
    setSystemTime(start)
    for (let i = 0; i < 1000; i++) store.issue({ name: `user-${i}`, roles: [] })
    expect(store.size).toBe(1000)

    setSystemTime(start + 30_001)
    store.issue(BOB)
    expect(store.size).toBe(1)
  })

  it(`keeps at most ${MAX_TICKETS_PER_USER} outstanding tickets per user, dropping the oldest`, () => {
    const store = new TicketStore()
    const tickets = Array.from({ length: 50 }, () => store.issue(BOB))
    expect(store.size).toBe(MAX_TICKETS_PER_USER)
    expect(store.consume(tickets[0] ?? '')).toBeUndefined()
    expect(store.consume(tickets.at(-1) ?? '')).toEqual(BOB)
    expect(store.size).toBe(MAX_TICKETS_PER_USER - 1)
  })
})
