import { Injectable, type OnStart, type OnStop } from '@znight/core'
import { events } from './events.js'
import { UserService } from './users/user.service.js'

@Injectable()
export class Scheduler implements OnStart, OnStop {
  readonly users: UserService

  constructor(users: UserService) {
    this.users = users
  }

  onStart(): void {
    events.push('Scheduler.onStart')
  }

  onStop(): void {
    events.push('Scheduler.onStop')
  }
}
