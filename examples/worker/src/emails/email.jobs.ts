/**
 * The contract of the "emails.send" queue: queue name, message type and payload schema. Shared by the
 * consumer (validation with `@Message(SendEmailJob)`) and the producers (scripts/publish.ts, the
 * report consumer), so this module only imports zod.
 */
import { z } from 'zod'

/** Queue consumed by EmailConsumer (dead letters go to `emails.send.dlq`, the driver default). */
export const EMAILS_QUEUE = 'emails.send'

/** Message type of a templated email. */
export const SEND_EMAIL = 'email.send'

/** Templates rendered by EmailRenderer. */
export const EmailTemplate = z.enum(['welcome', 'password-reset', 'report-ready'])
export type EmailTemplate = z.output<typeof EmailTemplate>

/** Payload of a `email.send` message. */
export const SendEmailJob = z.object({
  to: z.email(),
  template: EmailTemplate,
  locale: z.enum(['en', 'fr']).default('en'),
  /** Template variables (`name`, `resetUrl`, `reportUrl`...). */
  data: z.record(z.string(), z.string()).default({}),
})
/** What the handler receives: the schema output, defaults applied. */
export type SendEmailJob = z.output<typeof SendEmailJob>
/** What a producer sends: `locale` and `data` are optional. */
export type SendEmailInput = z.input<typeof SendEmailJob>
