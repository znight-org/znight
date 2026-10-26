import { Inject, Injectable, Intercept, type Lazy, type OnReady, type OnStart, type OnStop } from '@znight/core'
import { Logged, type Logger } from '@fixture/logging'
import { FIND_TIMING } from '../aop/options.js'
import { TimingInterceptor } from '../aop/timing.interceptor.js'
import type { Clock } from '../clock.js'
import { events } from '../events.js'
import type { Plugin } from '../plugins.js'
import type { AuditService } from './audit.service.js'
import type { Repository } from './repository.js'
import type { User } from './user.js'

export interface Cache {
  get(key: string): unknown
}

@Injectable()
export class UserService implements OnStart, OnReady, OnStop {
  readonly repository: Repository<User>
  readonly clock: Clock
  readonly plugins: readonly Plugin[]
  readonly audit: Lazy<AuditService>
  readonly logger: Logger
  readonly cache: Cache | undefined

  constructor(
    repository: Repository<User>,
    @Inject('fixed') clock: Clock,
    plugins: readonly Plugin[],
    audit: Lazy<AuditService>,
    logger: Logger,
    cache?: Cache,
  ) {
    this.repository = repository
    this.clock = clock
    this.plugins = plugins
    this.audit = audit
    this.logger = logger
    this.cache = cache
  }

  onStart(): void {
    events.push('UserService.onStart')
  }

  onReady(): void {
    events.push('UserService.onReady')
  }

  onStop(): void {
    events.push('UserService.onStop')
  }

  @Intercept(TimingInterceptor, FIND_TIMING)
  @Logged({ prefix: 'log:' })
  find(id: string): User | undefined {
    this.audit.get().record(`find ${id}`)
    return this.repository.find(id)
  }

  @Intercept(TimingInterceptor, { label: 'count' })
  async count(): Promise<number> {
    await Promise.resolve()
    return this.plugins.length
  }
}
