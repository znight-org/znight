import { Config } from '@znight/config'

/** Settings of the daily digest: `DIGEST_<PROPERTY>`. Its schedule is `DIGEST_CRON` (`ScheduleConfig`). */
@Config('digest')
export class DigestConfig {
  /** `DIGEST_RECIPIENTS`: comma-separated addresses. */
  recipients: string[] = ['ops@example.com']
}
