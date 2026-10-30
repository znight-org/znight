import type { HttpPlugin } from '@znight/http'
import type { NoteService } from '../notes/note.service.js'
import type { PasswordHasher } from '../security/password-hasher.js'

import { Controller, Get } from '@znight/http'

import { Public, Roles } from '../auth/access.js'

export interface StatusDetails {
  readonly status: 'ok'
  readonly uptime: number
  readonly runtime: string
  /** Requests being handled, this one included (they are drained on shutdown). */
  readonly inflightRequests: number
  readonly notes: number
  /** Password hashes running and queued (`PasswordHasher` bounds them). */
  readonly passwordHashing: { readonly running: number; readonly waiting: number }
}

/**
 * The former fail-open case. `@Public()` on the controller and `@Roles(['admin'])` on one route used
 * to be merged into `{ public: true, roles: ['admin'] }`, and a guard checking `public` first served
 * the admin route to anyone. Both decorators are now decisions of the "access" group: the route's
 * decision replaces the controller's, and `GET /status/details` is admin only (401, then 403).
 */
@Controller('/status')
@Public()
export class StatusController {
  readonly #startedAt = performance.now()

  constructor(
    private readonly http: HttpPlugin,
    private readonly notes: NoteService,
    private readonly hasher: PasswordHasher,
  ) {}

  /** GET /status: public. */
  @Get()
  status(): { status: 'ok'; uptime: number } {
    return { status: 'ok', uptime: this.#uptime() }
  }

  /** GET /status/details: administrators only. */
  @Get('/details')
  @Roles(['admin'])
  async details(): Promise<StatusDetails> {
    return {
      status: 'ok',
      uptime: this.#uptime(),
      runtime: process.versions.bun === undefined ? `node ${process.version}` : `bun ${process.versions.bun}`,
      inflightRequests: this.http.inflight,
      notes: (await this.notes.all()).length,
      passwordHashing: this.hasher.stats,
    }
  }

  #uptime(): number {
    return Math.round((performance.now() - this.#startedAt) / 1000)
  }
}
