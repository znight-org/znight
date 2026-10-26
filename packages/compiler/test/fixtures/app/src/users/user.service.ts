import { Logger as AppLogger } from '@fixture/lib'
import type * as models from './user.model.ts'
import type { UserRepository } from './user.repository.ts'

export class UserService {
  constructor(
    readonly repository: UserRepository,
    readonly logger: AppLogger,
    readonly fallback?: models.User,
  ) {}
}
