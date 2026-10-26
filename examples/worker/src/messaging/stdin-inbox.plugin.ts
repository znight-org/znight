import type { Readable } from 'node:stream'
import type { Plugin, PluginContext, PluginOptions } from '@znight/core'

import { createInterface, type Interface } from 'node:readline'
import { resolveOptions } from '@znight/core'
import { MessageBroker } from '@znight/messaging'
import { z } from 'zod'

/** One line of the inbox: what to publish, and where. */
export const InboxEntry = z.object({
  queue: z.string().min(1),
  type: z.string().min(1).optional(),
  payload: z.unknown(),
  id: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
})
export type InboxEntry = z.output<typeof InboxEntry>

/** Options of {@link StdinInboxPlugin.configure}. */
export interface StdinInboxOptions {
  /** Read the input. Default: `true`. */
  readonly enabled?: boolean
  /** Where jobs are read from. Default: `process.stdin`. */
  readonly input?: Readable
}

/**
 * A custom plugin: an ingress publishing the jobs read from the standard input (one JSON object per
 * line, see {@link InboxEntry}) through the MessageBroker. It is how jobs reach the in-memory broker
 * from outside the process; with RabbitMQ, producers publish to the broker directly
 * (scripts/publish.ts).
 *
 * ```sh
 * echo '{"queue":"emails.send","type":"email.send","payload":{"to":"ada@example.com","template":"welcome","data":{"name":"Ada"}}}' \
 *   | WORKER_STDIN_INBOX=true node dist/main.js
 * ```
 *
 * Lifecycle: it starts reading in `onStart`, after MessagingPlugin subscribed the consumers (plugins
 * start in order), and stops in `onStop`, before MessagingPlugin drains them (plugins stop in reverse
 * order): ingress first, then the in-flight work.
 */
export const StdinInboxPlugin: { configure(options?: PluginOptions<StdinInboxOptions>): Plugin } = {
  configure(options = {}) {
    let settings: StdinInboxOptions = {}
    let reader: Interface | undefined
    // lines are published one after the other, in order
    let publishing: Promise<void> = Promise.resolve()

    return {
      name: 'stdin-inbox',

      onBootstrap(ctx) {
        // plugin options may be a function of the container, evaluated here by convention
        settings = resolveOptions(options, ctx.container)
      },

      onStart(ctx) {
        if (settings.enabled === false) return
        const input = settings.input ?? process.stdin
        const broker = ctx.container.get(MessageBroker)
        let lineNumber = 0
        reader = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
        reader.on('line', line => {
          lineNumber += 1
          const current = lineNumber
          publishing = publishing.then(() => publishLine(ctx, broker, line, current))
        })
        reader.on('close', () => ctx.logger.debug('Stdin inbox: input closed'))
        ctx.logger.info('Stdin inbox: reading jobs from the standard input, one JSON object per line')
      },

      async onStop() {
        if (reader === undefined) return
        reader.close()
        reader = undefined
        // stop reading for good, so that the input does not keep the process alive
        ;(settings.input ?? process.stdin).destroy()
        await publishing
      },
    }
  },
}

async function publishLine(ctx: PluginContext, broker: MessageBroker, line: string, lineNumber: number): Promise<void> {
  const text = line.trim()
  if (text === '' || text.startsWith('#')) return
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    ctx.logger.warn('Stdin inbox: ignored a line that is not JSON', { line: lineNumber })
    return
  }
  const parsed = InboxEntry.safeParse(json)
  if (!parsed.success) {
    ctx.logger.warn('Stdin inbox: ignored an invalid entry', {
      line: lineNumber,
      issues: z.prettifyError(parsed.error),
    })
    return
  }
  const { queue, payload, type, id, headers } = parsed.data
  try {
    const result = await broker.publish(queue, payload, { type, id, headers })
    ctx.logger.info('Stdin inbox: job enqueued', { queue, type, jobId: result.id })
  } catch (error) {
    ctx.logger.error('Stdin inbox: failed to enqueue a job', { line: lineNumber, queue, err: error })
  }
}
