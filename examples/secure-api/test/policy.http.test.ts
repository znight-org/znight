import type { TestApp } from '@znight/testing'
import type { Note } from '../src/notes/note.js'

import { bearer, createTestApp } from './support/app.js'
import { mintToken } from './support/tokens.js'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

/** `NoteOwnerPolicy`, a guard with a repository dependency, on the routes of one note. */
describe('note ownership', () => {
  let app: TestApp
  let alice: Record<string, string>
  let bob: Record<string, string>
  let admin: Record<string, string>

  beforeAll(async () => {
    app = await createTestApp()
    alice = bearer(await mintToken({ sub: 'u-alice', roles: ['editor'] }))
    bob = bearer(await mintToken({ sub: 'u-bob', roles: ['editor'] }))
    admin = bearer(await mintToken({ sub: 'u-admin', roles: ['admin'] }))
  })

  afterAll(async () => {
    await app.close()
  })

  async function create(headers: Record<string, string>, text: string): Promise<Note> {
    const response = await app.inject({ method: 'POST', url: '/notes', headers, body: { text } })
    expect(response.status).toBe(201)
    return response.json<Note>()
  }

  it('lets the owner read, change and delete the note', async () => {
    const note = await create(alice, '  Buy milk  ')
    expect(note).toMatchObject({ ownerId: 'u-alice', text: 'Buy milk' }) // validated and trimmed by the schema

    expect((await app.inject({ url: `/notes/${note.id}`, headers: alice })).json()).toMatchObject({ id: note.id })
    const patched = await app.inject({
      method: 'PATCH',
      url: `/notes/${note.id}`,
      headers: alice,
      body: { text: 'Buy oat milk' },
    })
    expect(patched.json()).toMatchObject({ text: 'Buy oat milk' })
    expect((await app.inject({ method: 'DELETE', url: `/notes/${note.id}`, headers: alice })).status).toBe(204)
    expect((await app.inject({ url: `/notes/${note.id}`, headers: alice })).status).toBe(404)
  })

  it("answers 404, not 403, for another user's note: its existence stays secret", async () => {
    const note = await create(alice, 'Private')

    for (const method of ['GET', 'PATCH', 'DELETE'] as const) {
      const response = await app.inject({ method, url: `/notes/${note.id}`, headers: bob, body: { text: 'Mine now' } })
      expect(response.status).toBe(404)
      expect(response.json()).toMatchObject({ message: `Note ${note.id} not found` })
    }
    // exactly what a note that does not exist answers
    expect((await app.inject({ url: '/notes/does-not-exist', headers: bob })).json()).toMatchObject({
      statusCode: 404,
      message: 'Note does-not-exist not found',
    })
    // still there
    expect((await app.inject({ url: `/notes/${note.id}`, headers: alice })).json()).toMatchObject({ text: 'Private' })
  })

  it('lists the notes of the caller only', async () => {
    const mine = await create(bob, 'Bob only')

    const listed = (await app.inject({ url: '/notes', headers: bob })).json<Note[]>()

    expect(listed.map(note => note.id)).toContain(mine.id)
    expect(listed.every(note => note.ownerId === 'u-bob')).toBe(true)
  })

  it('lets administrators read every note, and change none', async () => {
    const note = await create(alice, 'Audited')

    expect((await app.inject({ url: `/notes/${note.id}`, headers: admin })).status).toBe(200)
    expect((await app.inject({ url: '/admin/notes', headers: admin })).json<Note[]>().map(n => n.id)).toContain(note.id)
    const patch = await app.inject({ method: 'PATCH', url: `/notes/${note.id}`, headers: admin, body: { text: 'x' } })
    expect(patch.status).toBe(403)
    expect((await app.inject({ method: 'DELETE', url: `/notes/${note.id}`, headers: admin })).status).toBe(403)
  })

  it('validates the body after the guards', async () => {
    const note = await create(alice, 'Valid')

    const invalid = await app.inject({ method: 'PATCH', url: `/notes/${note.id}`, headers: alice, body: { text: '' } })
    expect(invalid.status).toBe(400)
    // another user's note: the policy answers first, the body is never read
    const hidden = await app.inject({ method: 'PATCH', url: `/notes/${note.id}`, headers: bob, body: { text: '' } })
    expect(hidden.status).toBe(404)
  })
})
