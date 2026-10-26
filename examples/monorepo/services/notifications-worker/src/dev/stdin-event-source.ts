import type { MessageBroker } from '@znight/messaging'
import type { Logger } from '@znight/observability'
import type { WorkerConfig } from '../worker.config.js'

import { createInterface, type Interface } from 'node:readline'
import { Injectable, type OnReady, type OnStop } from '@znight/core'
import { USER_EVENTS_QUEUE } from '@znight-examples/shared'

/**
 * Development bridge (`WORKER_STDIN_EVENTS=true`): publishes the user events read from stdin to the
 * `user-events` queue, so the worker can be tried without a broker. One JSON object per line:
 *
 * ```json
 * {"type": "user.registered", "payload": {"id": "u1", "email": "ada@example.com", "name": "Ada", "at": "2026-01-01T00:00:00Z"}}
 * ```
 *
 * It goes through `MessageBroker` (injected like any provider; supplied by MessagingPlugin) exactly
 * like a producer service would, so messages are validated, retried and dead-lettered as usual.
 */
@Injectable()
export class StdinEventSource implements OnReady, OnStop {
  #lines: Interface | undefined
  readonly #pending = new Set<Promise<void>>()

  constructor(
    private readonly config: WorkerConfig,
    private readonly broker: MessageBroker,
    private readonly logger: Logger,
  ) {}

  /** Once everything started (consumers subscribed). */
  onReady(): void {
    if (!this.config.stdinEvents) return
    this.#lines = createInterface({ input: process.stdin })
    this.#lines.on('line', line => {
      const publishing = this.#publish(line).finally(() => this.#pending.delete(publishing))
      this.#pending.add(publishing)
    })
    this.logger.info('Reading user events from stdin, one JSON object per line')
  }

  async onStop(): Promise<void> {
    if (this.#lines === undefined) return
    this.#lines.close()
    process.stdin.pause() // let the process exit
    await Promise.all(this.#pending)
  }

  async #publish(line: string): Promise<void> {
    if (line.trim() === '') return
    try {
      const { type, payload } = JSON.parse(line) as { type?: unknown; payload?: unknown }
      if (typeof type !== 'string') throw new Error('expected {"type": "...", "payload": {...}}')
      const { id } = await this.broker.publish(USER_EVENTS_QUEUE, payload, { type })
      this.logger.debug('User event published', { id, type })
    } catch (error) {
      this.logger.warn('Invalid stdin line ignored', { line, error: error instanceof Error ? error.message : error })
    }
  }
}
