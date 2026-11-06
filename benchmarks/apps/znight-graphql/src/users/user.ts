import type { ID, StandardSchemaV1 } from '@znight/graphql'

import { z } from 'zod'

/** A user: the GraphQL `User` type. */
export interface User {
  readonly id: ID
  readonly name: string
  readonly email: string
}

/** Input of `Mutation.createUser`: the GraphQL `CreateUserInput` type. */
export interface CreateUserInput {
  readonly name: string
  readonly email: string
}

/** The rules of the HTTP benchmark's `POST /users` body. */
export const CreateUserInput: StandardSchemaV1<unknown, CreateUserInput> = z.object({
  name: z.string().min(1).max(100),
  email: z.email(),
})
