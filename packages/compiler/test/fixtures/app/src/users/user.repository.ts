import type { Repository } from '../generics.ts'
import type { User } from './user.model.ts'

export interface UserRepository extends Repository<User> {}

export class PgUserRepository implements UserRepository {
  find(id: string): User {
    return { id, name: 'x' }
  }
}
