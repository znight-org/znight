import type { User } from './user.js'
import type { UserService } from './user.service.js'

import { Body, Controller, Get, NotFoundException, Param, Post } from '@znight/http'

import { CreateUser } from './user.js'

@Controller('/users')
export class UserController {
  constructor(private readonly users: UserService) {}

  @Get('/:id')
  findById(@Param('id') id: number): User {
    const user = this.users.findById(id)
    if (user === undefined) throw new NotFoundException(`User ${id} not found`)
    return user
  }

  /** `201 Created` with the new user; an invalid body is a `400 Bad Request`. */
  @Post()
  create(@Body(CreateUser) input: CreateUser): User {
    return this.users.create(input)
  }
}
