import type { Note } from './note.js'
import type { NoteRepository } from './note.repository.js'

import { Injectable } from '@znight/core'

/** Notes in memory, oldest first. Asynchronous like a database, so that callers do not change. */
@Injectable()
export class InMemoryNoteRepository implements NoteRepository {
  readonly #notes = new Map<string, Note>()

  find(id: string): Promise<Note | undefined> {
    return Promise.resolve(this.#notes.get(id))
  }

  listByOwner(ownerId: string): Promise<Note[]> {
    return Promise.resolve([...this.#notes.values()].filter(note => note.ownerId === ownerId))
  }

  list(): Promise<Note[]> {
    return Promise.resolve([...this.#notes.values()])
  }

  save(note: Note): Promise<void> {
    this.#notes.set(note.id, note)
    return Promise.resolve()
  }

  remove(id: string): Promise<void> {
    this.#notes.delete(id)
    return Promise.resolve()
  }
}
