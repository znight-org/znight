import type { Application } from '@znight/core'
import type { MessagingPluginInstance } from '@znight/messaging'

import { Controller, Get, HttpResponse } from '@znight/http'

export interface Health {
  readonly status: 'ok' | 'unavailable'
  readonly uptime: number
  readonly consumers: readonly { readonly queue: string; readonly state: string; readonly inFlight: number }[]
}

@Controller('/health')
export class HealthController {
  /** `Application` is a core built-in: any provider can inject it. */
  constructor(private readonly app: Application) {}

  /**
   * `GET /health`: readiness probe. `503` until every consumer is subscribed, and again while the
   * service shuts down, so that the load balancer stops routing traffic to it.
   */
  @Get()
  check(): HttpResponse<Health> {
    const consumers = (this.app.getPlugin<MessagingPluginInstance>('messaging')?.consumers() ?? []).map(consumer => ({
      queue: consumer.queue,
      state: consumer.state,
      inFlight: consumer.inFlight,
    }))
    const ready = this.app.state === 'ready' && consumers.every(consumer => consumer.state === 'running')
    return new HttpResponse<Health>(
      { status: ready ? 'ok' : 'unavailable', uptime: Math.round(process.uptime()), consumers },
      { status: ready ? 200 : 503 },
    )
  }
}
