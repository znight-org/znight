import { Field, ID, Int, ObjectType } from '@nestjs/graphql'

/** A book; `author` is resolved by BookResolver from `authorId`, which is not in the schema. */
@ObjectType()
export class Book {
  @Field(() => ID)
  id!: string

  @Field()
  title!: string

  @Field(() => Int)
  year!: number

  authorId!: string
}
