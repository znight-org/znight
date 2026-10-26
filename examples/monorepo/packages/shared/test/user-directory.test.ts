import { type Clock, EmailAlreadyUsedError, IdGenerator, UserDirectory, UserNotFoundError } from '../src/index.ts'
import { describe, expect, test as it } from 'bun:test'

/** A clock that only moves when told to. */
class ManualClock implements Clock {
  current = new Date('2026-01-01T00:00:00.000Z')

  now(): Date {
    return this.current
  }
}

/** Sequential ids: `u1`, `u2`... */
class SequentialIds extends IdGenerator {
  #count = 0

  next(): string {
    this.#count += 1
    return `u${this.#count}`
  }
}

// Providers are plain classes: unit tests of a library construct them directly, no container needed
// (the applications test the wiring, see services/*/test).
function setUp() {
  const clock = new ManualClock()
  return { clock, directory: new UserDirectory(clock, new SequentialIds()) }
}

describe('UserDirectory', () => {
  it('registers users with generated ids and the current time', () => {
    const { directory } = setUp()

    const ada = directory.register({ email: 'Ada@Example.com', name: 'Ada' })

    expect(ada).toEqual({
      id: 'u1',
      email: 'ada@example.com',
      name: 'Ada',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(directory.get('u1')).toEqual(ada)
    expect(directory.findByEmail('ADA@example.com')).toEqual(ada)
    expect(directory.size).toBe(1)
  })

  it('email addresses are unique, whatever their case', () => {
    const { directory } = setUp()
    directory.register({ email: 'ada@example.com', name: 'Ada' })

    expect(() => directory.register({ email: 'ADA@example.com', name: 'Other' })).toThrow(EmailAlreadyUsedError)
  })

  it('update changes the given fields and the update date', () => {
    const { directory, clock } = setUp()
    const ada = directory.register({ email: 'ada@example.com', name: 'Ada' })
    clock.current = new Date('2026-01-02T00:00:00.000Z')

    const updated = directory.update(ada.id, { name: 'Ada Lovelace' })

    expect(updated).toEqual({ ...ada, name: 'Ada Lovelace', updatedAt: '2026-01-02T00:00:00.000Z' })
    expect(() => directory.update('nope', {})).toThrow(UserNotFoundError)
  })

  it('update keeps email addresses unique and frees the previous one', () => {
    const { directory } = setUp()
    const ada = directory.register({ email: 'ada@example.com', name: 'Ada' })
    directory.register({ email: 'grace@example.com', name: 'Grace' })

    expect(() => directory.update(ada.id, { email: 'grace@example.com' })).toThrow(EmailAlreadyUsedError)
    directory.update(ada.id, { email: 'countess@example.com' })
    expect(directory.register({ email: 'ada@example.com', name: 'New Ada' }).id).toBe('u3')
  })

  it('list pages through the users sorted by id', () => {
    const { directory } = setUp()
    for (const name of ['a', 'b', 'c']) directory.register({ email: `${name}@example.com`, name })

    const first = directory.list({ limit: 2 })
    expect(first.items.map(user => user.id)).toEqual(['u1', 'u2'])
    expect(first.next).toBe('u2')
    expect(directory.list({ limit: 2, after: first.next })).toEqual({ items: [directory.get('u3')] })
  })

  it('upsert keeps the id of users created elsewhere (projections, snapshots)', () => {
    const { directory } = setUp()
    const user = {
      id: 'external-1',
      email: 'ada@example.com',
      name: 'Ada',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    }

    directory.upsert(user)
    directory.upsert({ ...user, email: 'countess@example.com' })

    expect(directory.get('external-1').email).toBe('countess@example.com')
    expect(directory.findByEmail('ada@example.com')).toBeUndefined()
  })

  it('remove forgets the user and their email address', () => {
    const { directory } = setUp()
    const ada = directory.register({ email: 'ada@example.com', name: 'Ada' })

    expect(directory.remove(ada.id)).toEqual(ada)
    expect(directory.find(ada.id)).toBeUndefined()
    expect(() => directory.remove(ada.id)).toThrow(UserNotFoundError)
    expect(directory.register({ email: 'ada@example.com', name: 'Ada' }).id).toBe('u2')
  })
})
