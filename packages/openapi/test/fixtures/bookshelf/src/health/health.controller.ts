import { Controller, Get } from '@znight/http'
import { ApiExclude } from '@znight/openapi'

@Controller('/health')
@ApiExclude()
export class HealthController {
  @Get()
  check(): { status: 'ok' } {
    return { status: 'ok' }
  }
}
