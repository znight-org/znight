import { Controller, Get } from '@znight/http'

import { Public } from '../auth/access.js'

/** Probed by load balancers: public, and left out of the request logs (see `main.ts`). */
@Controller('/health')
@Public()
export class HealthController {
  /** GET /health */
  @Get()
  check(): { status: 'ok' } {
    return { status: 'ok' }
  }
}
