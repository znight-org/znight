import { Body, Controller, Delete, Get, HttpResponse, Param, Patch, Post, Query } from '@znight/http'
import { CreateUserInput, UpdateUserInput, type User, type UserDirectory, type UserPage } from '@znight-examples/shared'

import { ListUsersQuery } from './list-users.query.js'

/**
 * Users CRUD, on top of `UserDirectory`, a provider of the shared library injected **by class**.
 * Request bodies are validated by the shared DTO schemas; domain errors (`UserNotFoundError`,
 * `EmailAlreadyUsedError`) become 404 / 409 through `UserErrorMapper`.
 */
@Controller('/users')
export class UserController {
  constructor(private readonly directory: UserDirectory) {}

  /** GET /users?limit=20&after=<id>: a page of users, by creation date (ids are time-ordered). */
  @Get()
  list(@Query(ListUsersQuery) query: ListUsersQuery): UserPage {
    return this.directory.list(query)
  }

  /** GET /users/:id */
  @Get('/:id')
  find(@Param('id') id: string): User {
    return this.directory.get(id)
  }

  /** POST /users {"email": "ada@example.com", "name": "Ada"}: 201 with a location header. */
  @Post()
  create(@Body(CreateUserInput) input: CreateUserInput): HttpResponse<User | undefined> {
    const user = this.directory.register(input)
    return HttpResponse.created(user, `/users/${user.id}`)
  }

  /** PATCH /users/:id {"name": "Ada Lovelace"}: only the given fields change. */
  @Patch('/:id')
  update(@Param('id') id: string, @Body(UpdateUserInput) changes: UpdateUserInput): User {
    return this.directory.update(id, changes)
  }

  /** DELETE /users/:id: 204 No Content. */
  @Delete('/:id')
  remove(@Param('id') id: string): void {
    this.directory.remove(id)
  }
}
