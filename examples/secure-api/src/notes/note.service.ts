import type { Note, NoteInput } from './note.js'
import type { NoteRepository } from './note.repository.js'

import { randomUUID } from 'node:crypto'
import { Injectable } from '@znight/core'

/**
 * The use cases of notes. It knows nothing about HTTP nor about who may do what: the access
 * decisions and `NoteOwnerPolicy` have checked the caller before any method runs.
 */
@Injectable()
export class NoteService {
  constructor(private readonly notes: NoteRepository) {}

  listOwnedBy(ownerId: string): Promise<Note[]> {
    return this.notes.listByOwner(ownerId)
  }

  all(): Promise<Note[]> {
    return this.notes.list()
  }

  find(id: string): Promise<Note | undefined> {
    return this.notes.find(id)
  }

  async create(ownerId: string, input: NoteInput): Promise<Note> {
    const now = new Date()
    const note: Note = { id: randomUUID(), ownerId, text: input.text, createdAt: now, updatedAt: now }
    await this.notes.save(note)
    return note
  }

  /** The updated note, or `undefined` when it no longer exists. */
  async update(id: string, input: NoteInput): Promise<Note | undefined> {
    const note = await this.notes.find(id)
    if (note === undefined) return undefined
    const updated: Note = { ...note, text: input.text, updatedAt: new Date() }
    await this.notes.save(updated)
    return updated
  }

  remove(id: string): Promise<void> {
    return this.notes.remove(id)
  }
}
