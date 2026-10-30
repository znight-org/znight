import { z } from 'zod'

export interface User {
  readonly id: number
  readonly name: string
  readonly email: string
}

/** Body of `POST /users`. */
export const CreateUser = z.object({ name: z.string().min(1).max(100), email: z.email() })
export type CreateUser = z.infer<typeof CreateUser>
