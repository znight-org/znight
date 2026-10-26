import { Inject, Injectable } from '@znight/core'
import { CacheService } from './excluded/cache.ts'
import { EmailService } from './legacy/email.service.ts'
import type { Notifier } from './notify/notifier.ts'
import type { Customer, Repo } from './orders/repo.ts'
import type { PaymentGateway } from './pay/payment.ts'
import type { Clock } from './core/clock.ts'
import type { Pool } from 'pg-lite'

@Injectable()
export class Consumer {
  constructor(
    readonly email: EmailService,
    readonly notifier: Notifier,
    readonly cache: CacheService,
    readonly gateway: PaymentGateway,
    readonly customers: Repo<Customer>,
    @Inject('missing') readonly clock: Clock,
    // @ts-expect-error Mailer is not imported
    readonly mailer: Mailer,
    @Inject('port') readonly port: number,
    readonly pool: Pool,
  ) {}
}
