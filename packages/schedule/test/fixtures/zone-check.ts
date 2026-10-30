/**
 * Runtime check (RFC 0004 §12.2): prints, as JSON, a table of occurrences computed by the engine and
 * a short run of the scheduler on the system clock. `runtime.test.ts` runs it with Node.js and Bun
 * and compares both outputs with the expected values.
 */

import { Application, silentLogger } from '@znight/core'
import { createMetadata } from '@znight/testing'

import { parseCronSpec } from '../../src/cron/parse.ts'
import { compileCron } from '../../src/cron/schedule.ts'
import { resolveTimeZone } from '../../src/cron/zone.ts'
import { SchedulePlugin, SchedulerRegistry } from '../../src/index.ts'

const CASES: readonly (readonly [string, string, string, number])[] = [
  ['30 2 * * *', 'Europe/Paris', '2027-03-27T00:00:00Z', 3],
  ['*/30 * * * *', 'Europe/Paris', '2027-03-27T23:45:00Z', 5],
  ['30 2 * * *', 'Europe/Paris', '2026-10-24T00:00:00Z', 3],
  ['*/30 * * * *', 'Europe/Paris', '2026-10-24T23:45:00Z', 6],
  ['30 2 * * *', 'America/New_York', '2026-03-07T00:00:00Z', 3],
  ['45 1 * * *', 'Australia/Lord_Howe', '2026-04-03T00:00:00Z', 3],
  ['0 9 * * *', 'Asia/Kathmandu', '2026-06-01T00:00:00Z', 2],
  ['0 0 * * *', 'America/Sao_Paulo', '2018-11-03T00:00:00Z', 3],
  ['0 12 * * *', 'Pacific/Apia', '2011-12-29T00:00:00Z', 3],
  ['0 12 * * *', 'US/Eastern', '2026-07-01T00:00:00Z', 1],
  ['0 9 * * *', '+05:30', '2026-06-01T00:00:00Z', 1],
  ['0 12 * * *', 'local', '2026-07-01T00:00:00Z', 1],
  ['0 12 * * *', 'local', '2026-01-01T00:00:00Z', 1],
]

const occurrences: Record<string, string[]> = {}
for (const [expression, zoneName, from, count] of CASES) {
  const parsed = parseCronSpec(expression)
  const zone = resolveTimeZone(zoneName)
  if (!parsed.ok || !zone.ok) throw new Error(`invalid case ${expression} ${zoneName}`)
  const engine = compileCron(parsed.spec, zone.zone)
  const runs: string[] = []
  let cursor = Date.parse(from)
  for (let index = 0; index < count; index++) {
    const next = engine.next(cursor)
    if (next === undefined) break
    runs.push(new Date(next).toISOString())
    cursor = next
  }
  occurrences[`${expression} ${zoneName} ${from}`] = runs
}

// the scheduler on the system clock: an epoch-aligned interval, a timeout, a manual trigger
const app = await Application.create({
  metadata: createMetadata({}),
  plugins: [SchedulePlugin.configure({ drainTimeoutMs: 1000 })],
  logger: silentLogger,
  shutdown: { signals: false },
})
const registry = app.get(SchedulerRegistry)
const ticks: number[] = []
registry.addInterval('tick', '100ms', ctx => {
  if (ctx.trigger === 'schedule') ticks.push(ctx.scheduledAt.getTime())
})
let warmed = false
registry.addTimeout('warm', 0, () => {
  warmed = true
})
await app.start()
await new Promise(resolve => setTimeout(resolve, 450))
const manual = await registry.trigger('tick')
await app.stop()

process.stdout.write(
  JSON.stringify({
    occurrences,
    scheduler: {
      ticks: ticks.length >= 3 && ticks.length <= 6,
      aligned: ticks.every(tick => tick % 100 === 0),
      increasing: ticks.every((tick, index) => index === 0 || tick > (ticks[index - 1] as number)),
      warmed,
      manual: manual.outcome,
    },
  }),
)
