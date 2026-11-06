import type { Lazy } from '@znight/core'
import type { RequestUser } from './request-user.js'
import type { TicketStore } from './tickets.js'

import { Controller, HttpCode, Post } from '@znight/http'

import { Authenticated } from './access.js'

@Controller('/ws/tickets')
@Authenticated()
export class TicketController {
  constructor(
    private readonly tickets: TicketStore,
    private readonly user: Lazy<RequestUser>,
  ) {}

  /** A single-use ticket for a browser WebSocket (`/chat?ticket=...`). */
  @Post()
  @HttpCode(201)
  issue(): { ticket: string } {
    return { ticket: this.tickets.issue(this.user.get().principal) }
  }
}
