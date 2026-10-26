import { Config, Env } from '@znight/config'

/** Logging and metrics settings (`OBSERVABILITY_*` variables, plus the conventional `LOG_LEVEL`). */
@Config('observability')
export class ObservabilityConfig {
  /** Minimum level of the JSON logs written on stdout (`LOG_LEVEL`). */
  @Env('LOG_LEVEL')
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent' = 'info'

  /** Port of the Prometheus `/metrics` server (`METRICS_PORT`), separate from the API. `0` picks a free port. */
  @Env('METRICS_PORT')
  metricsPort = 9464

  /** Name of the service (`SERVICE_NAME`): `name` field of the logs, `service` label of the metrics. */
  @Env('SERVICE_NAME')
  serviceName = 'orders'
}
