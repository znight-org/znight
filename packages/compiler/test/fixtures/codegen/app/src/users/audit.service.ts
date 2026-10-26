import { Injectable } from '@znight/core'
import { UserService } from './user.service.js'

@Injectable()
export class AuditService {
  readonly entries: string[] = []
  readonly users: UserService

  constructor(users: UserService) {
    this.users = users
  }

  record(entry: string): void {
    this.entries.push(entry)
  }
}
