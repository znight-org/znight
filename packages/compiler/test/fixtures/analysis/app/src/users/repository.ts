import type { Pool } from 'pg-lite'
import type { Clock } from '../core/clock.ts'

export interface Repository<T, ID = string> {
  find(id: ID): Promise<T | undefined>
}

export abstract class BaseRepository<T> implements Repository<T> {
  constructor(
    protected readonly pool: Pool,
    protected readonly clock: Clock,
  ) {}

  async find(_id: string): Promise<T | undefined> {
    return undefined
  }
}
