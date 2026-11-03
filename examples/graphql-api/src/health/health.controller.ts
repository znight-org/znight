import type { Application } from '@znight/core'
import type { GraphQLPlugin } from '@znight/graphql'

import { Controller, Get } from '@znight/http'

import { Public } from '../auth/access.js'

/** The answer of `GET /health`. */
export interface Health {
  readonly status: 'ok'
  readonly uptime: number
  /** Subscriptions streaming right now, on this instance. */
  readonly subscriptions: number
}

/**
 * A REST route next to GraphQL: liveness for load balancers and orchestrators. Controllers and
 * resolvers share the HTTP pipeline (guards, the `access` group, logs) and the services.
 */
@Controller('/health')
@Public()
export class HealthController {
  constructor(private readonly app: Application) {}

  /** GET /health */
  @Get()
  check(): Health {
    return {
      status: 'ok',
      uptime: Math.round(process.uptime()),
      subscriptions: this.app.getPlugin<GraphQLPlugin>('graphql')?.activeSubscriptions ?? 0,
    }
  }
}
