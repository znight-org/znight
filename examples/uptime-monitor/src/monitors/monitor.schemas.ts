/**
 * Validation of `POST /monitors`. Schedules come from users here, not from decorators, so the
 * compiler cannot check them: the refinements below call the scheduler's own engine
 * (`parseDuration`, `parseCron`), so an accepted schedule is one `SchedulerRegistry` accepts, with
 * the same messages as the build-time diagnostics (`hour 25 is out of range (0-23)`).
 *
 * Schemas are referenced by decorators, so they must be exported: the generated code imports them.
 */
import { parseCron, parseDuration } from '@znight/schedule'
import { z } from 'zod'

const SECOND = 1000
const DAY = 86_400_000

/** The message of a ZNIGHT040 error without its code (`hour 25 is out of range (0-23)`). */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.replace(/^ZNIGHT\d+: /, '') : String(error)
}

/** A duration as the scheduler reads it: `'30s'`, `'5m'`, `'1.5h'` or milliseconds. Output: milliseconds. */
const Duration = z.union([z.number(), z.string()]).transform((value, ctx) => {
  try {
    return parseDuration(value)
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: messageOf(error) })
    return z.NEVER
  }
})

/** Body of `POST /monitors`: `every` (an interval) or `cron` (an expression, with an optional `timeZone`). */
export const CreateMonitor = z
  .object({
    name: z.string().trim().min(1).max(100),
    // http(s) only. Internal hosts (`localhost`, IP addresses) are allowed: monitoring them is the
    // point. Only administrators create monitors, since the probes run from inside the network.
    url: z.url({ protocol: /^https?$/ }),
    expectedStatus: z.int().min(100).max(599).default(200),
    every: Duration.pipe(
      z.number().min(SECOND, 'Probe at most every second').max(DAY, 'Probe at least daily'),
    ).optional(),
    cron: z.string().trim().min(1).optional(),
    timeZone: z.string().trim().min(1).optional(),
    timeout: Duration.pipe(
      z
        .number()
        .min(100, 'At least 100ms')
        .max(60 * SECOND, 'At most 60s'),
    ).default(10 * SECOND),
  })
  .superRefine((input, ctx) => {
    if ((input.every === undefined) === (input.cron === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['every'], message: 'Give either "every" (a duration) or "cron"' })
      return
    }
    if (input.cron === undefined) {
      if (input.timeZone !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['timeZone'],
          message: 'Intervals are durations: use "cron" for wall-clock schedules',
        })
      }
      return
    }
    // the expression first (in UTC), then the zone: each issue lands on its own field
    try {
      parseCron(input.cron)
    } catch (error) {
      ctx.addIssue({ code: 'custom', path: ['cron'], message: messageOf(error) })
      return
    }
    try {
      parseCron(input.cron, { timeZone: input.timeZone ?? 'UTC' })
    } catch (error) {
      ctx.addIssue({ code: 'custom', path: ['timeZone'], message: messageOf(error) })
    }
  })
  .transform(({ every, cron, timeZone, timeout, ...monitor }) => ({
    ...monitor,
    schedule: every === undefined ? { cron: cron ?? '', timeZone: timeZone ?? 'UTC' } : { every },
    timeoutMs: timeout,
  }))
export type CreateMonitor = z.output<typeof CreateMonitor>
