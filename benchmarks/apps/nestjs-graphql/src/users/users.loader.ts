import type { User } from './user.model.js'

import { Injectable, NotFoundException, Scope } from '@nestjs/common'
import DataLoader from 'dataloader'

// A value import: NestJS reads the constructor parameter types from the decorator metadata
import { UserService } from './user.service.js'

/**
 * Users by id, batched: one `UserService.findMany` per request, whatever the number of books. The
 * NestJS recipe: a request-scoped provider, so each request gets its own DataLoader (and cache).
 */
@Injectable({ scope: Scope.REQUEST })
export class UsersLoader extends DataLoader<string, User> {
  constructor(users: UserService) {
    super(ids => {
      const found = new Map(users.findMany(ids).map(user => [user.id, user]))
      return Promise.resolve(ids.map(id => found.get(id) ?? new NotFoundException(`User ${id} not found`)))
    })
  }
}
