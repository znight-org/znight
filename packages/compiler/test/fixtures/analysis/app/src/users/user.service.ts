import { Inject, Injectable, Intercept, type Lazy, type OnStart, Optional } from '@znight/core'
import { Logged, Logger, Tracer } from '@znight/observability'
import { TimingInterceptor } from '../aop/timing.interceptor.ts'
import type { Clock } from '../core/clock.ts'
import { Plugin } from '../plugins/plugin.ts'
import type { AuditService } from './audit.service.ts'
import type { Repository } from './repository.ts'
import type { User } from './user.model.ts'
import { DYNAMIC, TIMING } from '../aop/options.ts'

export interface Cache {
  get(key: string): unknown
}

export const defaultCache: Cache = { get: () => undefined }

@Injectable()
export class UserService implements OnStart {
  constructor(
    readonly repository: Repository<User>,
    @Inject('fake') readonly clock: Clock,
    readonly logger: Logger,
    readonly plugins: readonly Plugin[],
    readonly audit: Lazy<AuditService>,
    readonly tracer: Tracer,
    readonly cache?: Cache,
    readonly maybe: Cache | undefined = undefined,
    readonly withDefault: Cache = defaultCache,
    @Optional() readonly explicit: Cache | null = null,
  ) {}

  onStart(): void {}

  @Logged({ level: 'debug' })
  @Intercept(TimingInterceptor, TIMING)
  async findById(id: string): Promise<User | undefined> {
    return this.repository.find(id)
  }

  @Intercept(TimingInterceptor, DYNAMIC)
  count(): number {
    return 0
  }
}
