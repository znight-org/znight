import type { Database } from '../db/database.js'

import { Controller, Get, ServiceUnavailableException } from '@znight/http'
import { sql } from 'drizzle-orm'

import { Public } from '../auth/auth.decorators.js'

/** Liveness / readiness probe for load balancers and orchestrators: no API key required. */
@Controller('/health')
@Public()
export class HealthController {
  constructor(private readonly db: Database) {}

  /** GET /health: 200 when the database answers, 503 otherwise. */
  @Get()
  async check(): Promise<{ status: 'ok'; uptime: number }> {
    try {
      await this.db.execute(sql`select 1`)
    } catch (error) {
      throw new ServiceUnavailableException('Database unavailable', undefined, { cause: error })
    }
    return { status: 'ok', uptime: Math.round(process.uptime()) }
  }
}
