import { type } from 'arktype'
import * as v from 'valibot'
import { z } from 'zod'

/** Body of POST /books. */
export const CreateBook = z.object({
  title: z.string().trim().min(1),
  isbn: z.string().regex(/^\d{13}$/),
  tags: z.array(z.string()).default([]),
  year: z.string().transform(value => Number(value)),
})
export type CreateBook = z.output<typeof CreateBook>

export const SearchQuery = z.object({
  q: z.string().optional(),
  tags: z.array(z.string()).optional(),
})

export const NewOrder = v.object({
  bookId: v.pipe(v.number(), v.integer(), v.minValue(1)),
  quantity: v.pipe(v.number(), v.integer(), v.minValue(1)),
})
export type NewOrder = v.InferOutput<typeof NewOrder>

export const Rating = type({ stars: '1 <= number.integer <= 5', 'comment?': 'string' })

export const CoverForm = z.object({ caption: z.string().optional() })
