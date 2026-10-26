/**
 * Validation schemas of the request bodies. Any Standard Schema library works (Zod, Valibot,
 * ArkType...): `@Body(CreateBook)` validates the body and injects the schema **output** (trimmed
 * strings, normalised ISBN), and a failure answers `400` with one entry per issue.
 *
 * Schemas are referenced by decorators, so they must be exported: the generated code imports them.
 */
import { z } from 'zod'

/** ISBN-10 or ISBN-13; hyphens and spaces are removed (`978-0-547-92822-7` → `9780547928227`). */
export const Isbn = z
  .string()
  .trim()
  .transform(value => value.replace(/[\s-]/g, '').toUpperCase())
  .pipe(z.string().regex(/^(?:\d{9}[\dX]|\d{13})$/, 'Expected an ISBN-10 or ISBN-13'))

const Title = z.string().trim().min(1).max(200)
const Author = z.string().trim().min(1).max(200)
const PublishedYear = z
  .number()
  .int()
  .min(-3000)
  .max(new Date().getFullYear() + 1)
const Tags = z.array(z.string().trim().toLowerCase().min(1).max(40)).max(10)

/** Body of `POST /books`. */
export const CreateBook = z.object({
  isbn: Isbn,
  title: Title,
  author: Author,
  publishedYear: PublishedYear.optional(),
  tags: Tags.optional(),
})
export type CreateBook = z.output<typeof CreateBook>

/** Body of `PATCH /books/:id`: any subset of the fields, at least one. */
export const UpdateBook = z
  .object({ isbn: Isbn, title: Title, author: Author, publishedYear: PublishedYear, tags: Tags })
  .partial()
  .refine(changes => Object.keys(changes).length > 0, 'Expected at least one field to update')
export type UpdateBook = z.output<typeof UpdateBook>
