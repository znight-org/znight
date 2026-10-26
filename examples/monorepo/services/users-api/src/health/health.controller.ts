import type { Clock, UserDirectory } from '@znight-examples/shared'

import { Controller, Get } from '@znight/http'

/** Health of the service. */
@Controller('/health')
export class HealthController {
  constructor(
    // an interface of the shared library: bound at build time to SystemClock (the only Clock)
    private readonly clock: Clock,
    private readonly directory: UserDirectory,
  ) {}

  /** GET /health */
  @Get()
  check(): { status: 'ok'; time: string; users: number } {
    return { status: 'ok', time: this.clock.now().toISOString(), users: this.directory.size }
  }
}
