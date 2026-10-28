import { Controller, Get } from '@znight/http'
import { ApiExclude } from '@znight/openapi'

import { Public } from '../auth/auth.decorators.js'

/**
 * Liveness probe for load balancers and orchestrators.
 *
 * `@ApiExclude()`: an operational endpoint, not part of the API contract. It is served like any
 * route (and still needs an access decision, `@Public()`), but absent from the OpenAPI document,
 * so from the generated client too.
 */
@Controller('/health')
@Public()
@ApiExclude()
export class HealthController {
  @Get()
  check(): { status: 'ok'; uptime: number } {
    return { status: 'ok', uptime: Math.round(process.uptime()) }
  }
}
