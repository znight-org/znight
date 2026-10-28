import type { Note } from './note.js'

/**
 * Where notes are stored. Injected by interface: the compiler binds it to its only implementation,
 * `InMemoryNoteRepository` (the data layer is the subject of the rest-api example).
 */
export interface NoteRepository {
  find(id: string): Promise<Note | undefined>
  listByOwner(ownerId: string): Promise<Note[]>
  list(): Promise<Note[]>
  save(note: Note): Promise<void>
  remove(id: string): Promise<void>
}
