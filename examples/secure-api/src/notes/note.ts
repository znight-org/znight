import { z } from 'zod'

/** A personal note: only its owner reads and changes it (administrators read every note). */
export interface Note {
  readonly id: string
  /** The `id` of the principal that created it. */
  readonly ownerId: string
  readonly text: string
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** The body of `POST /notes` and `PATCH /notes/:id`. */
export const NoteInput = z.object({ text: z.string().trim().min(1).max(10_000) })
export type NoteInput = z.output<typeof NoteInput>
