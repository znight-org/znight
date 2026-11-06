import type { BatchLoad, ID } from '@znight/graphql'
import type { User } from './user.js'
import type { UserService } from './user.service.js'

import { Injectable } from '@znight/core'
import { orderByKeys } from '@znight/graphql'

/** Loads users by id in batches: `books { author { name } }` calls `UserService.findMany` once per request. */
@Injectable()
export class UsersById implements BatchLoad<ID, User> {
  constructor(private readonly users: UserService) {}

  load(ids: readonly ID[]): Promise<readonly (User | Error)[]> {
    return Promise.resolve(orderByKeys(ids, this.users.findMany(ids), user => user.id))
  }
}
