import { Field, ID, InputType, ObjectType } from '@nestjs/graphql'
import { z } from 'zod'

@ObjectType()
export class User {
  @Field(() => ID)
  id!: string

  @Field()
  name!: string

  @Field()
  email!: string
}

@InputType()
export class CreateUserInput {
  @Field()
  name!: string

  @Field()
  email!: string
}

/** The rules of the HTTP benchmark's `POST /users` body. */
export const CreateUserSchema = z.object({ name: z.string().min(1).max(100), email: z.email() })
