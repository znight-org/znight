import { Injectable } from '@znight/core'
import type { Clock } from '../clock.js'
import type { Database } from '../infra/database.js'
import type { User } from './user.js'

export interface Repository<T> {
  find(id: string): T | undefined
}

export abstract class BaseRepository<T> implements Repository<T> {
  protected readonly items: Map<string, T> = new Map()
  readonly database: Database
  readonly clock: Clock

  constructor(database: Database, clock: Clock) {
    this.database = database
    this.clock = clock
  }

  find(id: string): T | undefined {
    return this.items.get(id)
  }
}

@Injectable()
export class UserRepository extends BaseRepository<User> {
  seed(user: User): void {
    this.items.set(user.id, user)
  }
}
