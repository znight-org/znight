/**
 * The contract of the "reports.generate" queue: queue names, message type and payload schema. Shared
 * by the consumer and the producers (scripts/publish.ts), so this module only imports zod.
 */
import { z } from 'zod'

/** Queue consumed by ReportConsumer. */
export const REPORTS_QUEUE = 'reports.generate'

/** Dead-letter queue of REPORTS_QUEUE (instead of the driver default `reports.generate.dlq`). */
export const REPORTS_DEAD_LETTER_QUEUE = 'reports.failed'

/** Message type of a report request. */
export const GENERATE_REPORT = 'report.generate'

/** Payload of a `report.generate` message. */
export const GenerateReportJob = z
  .object({
    /** Idempotency key chosen by the producer, also the name of the generated file. */
    reportId: z.string().regex(/^[\w-]{1,64}$/, 'letters, digits, "-" and "_" only'),
    kind: z.enum(['sales', 'inventory']),
    /** First day of the period (YYYY-MM-DD). */
    from: z.iso.date(),
    /** Last day of the period, inclusive (YYYY-MM-DD). */
    to: z.iso.date(),
    format: z.enum(['csv', 'json']).default('csv'),
    /** Who is emailed once the report is ready. */
    notify: z.email().optional(),
  })
  .refine(job => job.from <= job.to, { message: 'must not be before "from"', path: ['to'] })
/** What the handler receives: the schema output, defaults applied. */
export type GenerateReportJob = z.output<typeof GenerateReportJob>
/** What a producer sends. */
export type GenerateReportInput = z.input<typeof GenerateReportJob>
