import type { LoggerLevel } from './levels.ts'
import type { LogTransport } from './transport.ts'

import { consoleTransport, withLevel } from './transport.ts'

/** Pino timestamp function writing `"timestamp":"<ISO 8601>"`. */
export function isoTimestamp(): string {
  return `,"timestamp":"${new Date().toISOString()}"`
}

/** Options of {@link cloudwatchTransport}. */
export interface CloudWatchTransportOptions {
  /** File descriptor: `1` (stdout, default) or `2` (stderr). */
  readonly fd?: 1 | 2
  /**
   * Synchronous writes. Default `true`: AWS Lambda freezes the process as soon as the handler
   * returns, so asynchronously buffered entries could be lost or delayed to the next invocation.
   */
  readonly sync?: boolean
  /** Keep pino's `pid` and `hostname` fields. Default `false` (the log stream identifies the source). */
  readonly includeProcessInfo?: boolean
  /** Minimum level written to this transport. */
  readonly level?: LoggerLevel
}

/**
 * Structured JSON on stdout, shaped for Amazon CloudWatch Logs and AWS Lambda:
 *
 * - one JSON object per line, written synchronously (safe with Lambda's freeze/thaw);
 * - `timestamp`: RFC 3339 / ISO 8601 string, `level`: upper-case (`INFO`, `ERROR`...), `message`:
 *   the message. These are the keys Lambda's JSON log format uses for log-level filtering
 *   (`AWS_LAMBDA_LOG_LEVEL`) and that CloudWatch Logs Insights discovers automatically;
 * - no `pid`/`hostname` noise by default.
 *
 * No AWS SDK call is made: the CloudWatch agent, the Lambda runtime, ECS (`awslogs` driver) or
 * Fluent Bit ship stdout to CloudWatch.
 */
export function cloudwatchTransport(options: CloudWatchTransportOptions = {}): LogTransport {
  const console = consoleTransport({ fd: options.fd ?? 1, sync: options.sync ?? true })
  return withLevel(
    {
      ...console,
      name: 'cloudwatch',
      loggerOptions: {
        messageKey: 'message',
        timestamp: isoTimestamp,
        ...(options.includeProcessInfo === true ? {} : { base: null }),
        formatters: { level: label => ({ level: label.toUpperCase() }) },
      },
    },
    options.level,
  )
}
