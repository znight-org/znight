import { Module } from '@nestjs/common'

import { UserRepository } from './user.repository.js'
import { UserResolver } from './user.resolver.js'
import { UserService } from './user.service.js'
import { UsersLoader } from './users.loader.js'

@Module({ providers: [UserResolver, UserService, UserRepository, UsersLoader], exports: [UsersLoader] })
export class UsersModule {}
