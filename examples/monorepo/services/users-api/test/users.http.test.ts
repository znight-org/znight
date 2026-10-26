import { TestApp } from '@znight/testing'
import { CLOCK, type Clock, IdGenerator, type User } from '@znight-examples/shared'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { usersHttpPlugin } from '../src/http.js'
import { SortableIdGenerator } from '../src/ids/sortable-id.generator.js'
import { afterEach, beforeEach, describe, expect, test as it } from 'bun:test'

const NOW = '2026-01-01T00:00:00.000Z'

/** A clock frozen at {@link NOW}. */
const frozenClock: Clock = { now: () => new Date(NOW) }

// TestApp starts the real application (without signal handlers) and sends requests in memory
// through the Express adapter and the whole HTTP pipeline.
describe('users API', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await TestApp.create({
      metadata,
      plugins: [usersHttpPlugin({ port: 0 })],
      // A runtime override of a library provider: every consumer of Clock (UserDirectory and
      // SortableIdGenerator from the library, HealthController here) receives the frozen clock.
      overrides: [[CLOCK, frozenClock]],
    })
  })

  afterEach(async () => {
    await app.close()
  })

  const create = (body: unknown) => app.inject({ method: 'POST', url: '/users', body })

  it('POST /users registers a user (201, location header)', async () => {
    const response = await create({ email: ' Ada@Example.com ', name: 'Ada' })

    expect(response.status).toBe(201)
    const user = response.json<User>()
    expect(user).toEqual({
      id: expect.any(String),
      email: 'ada@example.com',
      name: 'Ada',
      createdAt: NOW,
      updatedAt: NOW,
    })
    expect(response.headers.location).toBe(`/users/${user.id}`)
    expect((await app.inject({ url: `/users/${user.id}` })).json()).toEqual(user)
  })

  it('the request body is validated by the shared schema', async () => {
    const response = await create({ email: 'not-an-email', name: '  ' })

    expect(response.status).toBe(400)
    expect(response.json()).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Invalid body',
      details: [
        { path: 'email', message: 'Invalid email address' },
        { path: 'name', message: 'Must contain at least 1 character(s)' },
      ],
    })
  })

  it('domain errors of the library are mapped to 409 and 404', async () => {
    await create({ email: 'ada@example.com', name: 'Ada' })

    const duplicate = await create({ email: 'ADA@example.com', name: 'Ada again' })
    expect(duplicate.status).toBe(409)
    expect(duplicate.json()).toMatchObject({ error: 'Conflict', details: { email: 'ada@example.com' } })

    const missing = await app.inject({ url: '/users/unknown' })
    expect(missing.status).toBe(404)
    expect(missing.json()).toMatchObject({ message: 'User unknown not found' })
  })

  it('GET /users pages through the users in creation order', async () => {
    const names = ['Ada', 'Grace', 'Margaret']
    for (const name of names) await create({ email: `${name.toLowerCase()}@example.com`, name })

    const first = await app.inject({ url: '/users?limit=2' })
    const page = first.json<{ items: User[]; next: string }>()
    expect(page.items.map(user => user.name)).toEqual(['Ada', 'Grace'])

    const second = await app.inject({ url: `/users?limit=2&after=${page.next}` })
    expect(second.json()).toEqual({ items: [expect.objectContaining({ name: 'Margaret' })] })

    // the query is validated by the local Zod schema
    expect((await app.inject({ url: '/users?limit=0' })).status).toBe(400)
  })

  it('PATCH /users/:id and DELETE /users/:id', async () => {
    const { id } = (await create({ email: 'ada@example.com', name: 'Ada' })).json<User>()

    const updated = await app.inject({ method: 'PATCH', url: `/users/${id}`, body: { name: 'Ada Lovelace' } })
    expect(updated.status).toBe(200)
    expect(updated.json()).toMatchObject({ id, email: 'ada@example.com', name: 'Ada Lovelace' })

    expect((await app.inject({ method: 'DELETE', url: `/users/${id}` })).status).toBe(204)
    expect((await app.inject({ url: `/users/${id}` })).status).toBe(404)
  })

  it('GET /health reads the (overridden) Clock', async () => {
    const response = await app.inject({ url: '/health' })

    expect(response.json()).toEqual({ status: 'ok', time: NOW, users: 0 })
  })

  it('the library IdGenerator is the @Primary implementation of this service', () => {
    // IdGenerator is an abstract class of the library: it is also a runtime key
    expect(app.get(IdGenerator)).toBeInstanceOf(SortableIdGenerator)
  })
})
