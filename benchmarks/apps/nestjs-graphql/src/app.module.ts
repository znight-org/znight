import { YogaDriver, type YogaDriverConfig } from '@graphql-yoga/nestjs'
import { Module } from '@nestjs/common'
import { GraphQLModule } from '@nestjs/graphql'

import { BooksModule } from './books/books.module.js'
import { UsersModule } from './users/users.module.js'

@Module({
  imports: [
    // Code first: the schema is built from the decorated classes at boot (kept in memory). The Yoga
    // driver serves it on the Express or Fastify platform, with Yoga's defaults (parse and validation
    // caches, masked errors) besides GraphiQL and logging, off.
    GraphQLModule.forRoot<YogaDriverConfig>({
      driver: YogaDriver,
      autoSchemaFile: true,
      graphiql: false,
      logging: false,
    }),
    UsersModule,
    BooksModule,
  ],
})
export class AppModule {}
