/**
 * Non-gating benchmark of the engine (RFC 0004 §7.12, §12.2): 10,000 `next()` calls on random
 * expressions and zones. Run with `bun test/bench/next.bench.ts` or
 * `node --conditions=@znight/source test/bench/next.bench.ts`.
 */
import type { CronEngine } from '../../src/cron/schedule.ts'

import { neverFires } from '../../src/cron/analysis.ts'
import { parseCronSpec } from '../../src/cron/parse.ts'
import { compileCron } from '../../src/cron/schedule.ts'
import { resolveTimeZone } from '../../src/cron/zone.ts'

const EXPRESSIONS = [
  '* * * * *',
  '*/15 * * * *',
  '0 8 * * MON-FRI',
  '30 2 * * *',
  '0 0 L * *',
  '0 0 * * 5L',
  '0 9 * * MON#2',
  '*/10 * * * * *',
  '0 0 13 * FRI',
  '@daily',
]
const ZONES = ['UTC', 'Europe/Paris', 'America/New_York', 'Australia/Lord_Howe', 'Asia/Kathmandu', '+05:30']

let seed = 42
const random = (): number => {
  seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31
  return seed / 2 ** 31
}

const engines: CronEngine[] = []
for (const expression of EXPRESSIONS) {
  for (const name of ZONES) {
    const parsed = parseCronSpec(expression)
    const zone = resolveTimeZone(name)
    if (!parsed.ok || !zone.ok || neverFires(parsed.spec) !== undefined) throw new Error(`invalid ${expression}`)
    engines.push(compileCron(parsed.spec, zone.zone))
  }
}
const start = Date.parse('2026-01-01T00:00:00Z')
const instants = Array.from({ length: 10_000 }, () => start + Math.floor(random() * 365 * 86_400_000))
const picks = instants.map(() => engines[Math.floor(random() * engines.length)] as CronEngine)

// warm-up: Intl formatters and the yearly transition caches
for (let index = 0; index < 10_000; index++) picks[index]?.next(instants[index] as number)
const begin = performance.now()
let checksum = 0
for (let index = 0; index < 10_000; index++) checksum += (picks[index]?.next(instants[index] as number) ?? 0) % 7
const elapsed = performance.now() - begin
const runtime = typeof Bun === 'undefined' ? `node ${process.version}` : `bun ${Bun.version}`
console.log(
  `${runtime}: 10,000 next() in ${elapsed.toFixed(1)} ms (${((elapsed * 1000) / 10_000).toFixed(2)} µs each, checksum ${checksum})`,
)
