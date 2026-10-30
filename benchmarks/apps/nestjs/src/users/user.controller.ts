import type { User } from './user.js'

import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  StandardSchemaValidationPipe,
} from '@nestjs/common'

import { CreateUser } from './user.js'
// A value import: NestJS reads the constructor parameter types from the decorator metadata
import { UserService } from './user.service.js'

@Controller('users')
export class UserController {
  constructor(private readonly users: UserService) {}

  @Get(':id')
  findById(@Param('id', ParseIntPipe) id: number): User {
    const user = this.users.findById(id)
    if (user === undefined) throw new NotFoundException(`User ${id} not found`)
    return user
  }

  /** `201 Created` with the new user; an invalid body is a `400 Bad Request` (NestJS 12 Standard Schema pipe). */
  @Post()
  create(@Body({ schema: CreateUser, pipes: [StandardSchemaValidationPipe] }) input: CreateUser): User {
    return this.users.create(input)
  }
}
