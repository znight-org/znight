import { Config } from '@znight/config'

/**
 * Settings of the worker, validated at boot by ConfigPlugin. Read from the environment or a .env
 * file: `WORKER_<PROPERTY>` (`stdinEvents` → `WORKER_STDIN_EVENTS`).
 */
@Config('worker')
export class WorkerConfig {
  /**
   * Publish the user events read from stdin, one JSON object per line (WORKER_STDIN_EVENTS): local
   * development without a broker. See `StdinEventSource`.
   */
  stdinEvents = false

  /** Interval of the liveness log line, in milliseconds (WORKER_HEARTBEAT_MS). */
  heartbeatMs = 60_000
}
