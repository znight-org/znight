import { Config } from '@znight/config'

/** Settings of the probes and of their results: `PROBES_<PROPERTY>`. */
@Config('probes')
export class ProbesConfig {
  /** `PROBES_RETENTION_DAYS`: results older than this are deleted by `probes.purge` every night. */
  retentionDays = 30

  /** `PROBES_PURGE_BATCH_SIZE`: rows deleted per statement, so that the purge never holds the table for long. */
  purgeBatchSize = 1000

  /** `PROBES_USER_AGENT`: sent with every probe, so that the monitored services can recognise them. */
  userAgent = 'znight-uptime-monitor/0.1'
}
