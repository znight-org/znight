import { Injectable } from '@znight/core'
import { BaseRepository, type Repository } from './repository.ts'
import type { User } from './user.model.ts'

export interface UserRepository extends Repository<User> {}

@Injectable()
export class PgUserRepository extends BaseRepository<User> implements UserRepository {}
