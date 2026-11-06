import { Module } from '@nestjs/common'

import { UsersModule } from '../users/users.module.js'
import { BookRepository } from './book.repository.js'
import { BookResolver } from './book.resolver.js'
import { BookService } from './book.service.js'

@Module({ imports: [UsersModule], providers: [BookResolver, BookService, BookRepository] })
export class BooksModule {}
