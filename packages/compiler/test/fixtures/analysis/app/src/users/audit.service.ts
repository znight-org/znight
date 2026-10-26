import { Injectable } from '@znight/core'
import { UserService } from './user.service.ts'

@Injectable()
export class AuditService {
  constructor(readonly users: UserService) {}
}
