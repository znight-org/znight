import { Config, Env, Secret } from '@znight/config'

/** Log levels of the observability Logger. */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent'

/**
 * Settings of the worker process, validated by ConfigPlugin before anything starts. Values come from
 * the environment or from `.env` files (`.env`, `.env.local`, `.env.<NODE_ENV>`...), the real
 * environment winning. Names default to WORKER_<PROPERTY>; `@Env` / `@Secret` pick another name.
 */
@Config('worker')
export class WorkerConfig {
  /** LOG_LEVEL: level of the structured logs. */
  @Env('LOG_LEVEL')
  logLevel: LogLevel = 'info'

  /**
   * RABBITMQ_URL (`amqp://user:password@host:5672`): consume RabbitMQ when set, otherwise the
   * in-memory broker is used. A secret: it is masked in logs and error messages (the URL contains
   * credentials). Typed as a URL, so a malformed value fails the boot.
   */
  @Secret('RABBITMQ_URL')
  rabbitmqUrl?: URL

  /**
   * WORKER_STDIN_INBOX: also read jobs from the standard input, one JSON object per line
   * (`{"queue": "...", "type": "...", "payload": {...}}`). The way to feed the in-memory broker from
   * outside the process (local runs, end-to-end tests).
   */
  stdinInbox = false
}
