import { z } from 'zod'

/**
 * Query of `GET /users`. A local Zod schema: services pick their own validation library, next to
 * the Standard Schema DTOs of the shared package (any Standard Schema works with @Query / @Body).
 */
export const ListUsersQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  after: z.string().min(1).optional(),
})
export type ListUsersQuery = z.output<typeof ListUsersQuery>
