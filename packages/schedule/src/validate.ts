/**
 * Runtime validation of job options, shared by the plugin (metadata, `jobs` overrides) and the
 * registry (dynamic jobs). Every problem is a ZNIGHT040 `InvalidScheduleError`.
 */
import type { OverlapPolicy } from './options.ts'

import { checkDuration } from './duration.ts'
import { InvalidScheduleError } from './errors.ts'
import { closest, isJobName, JOB_NAME_RULE } from './names.ts'
import { OVERLAP_POLICIES } from './options.ts'

/** Kind of a job. */
export type JobKind = 'cron' | 'interval' | 'timeout'

/** Options of a job once validated. */
export interface NormalizedJobOptions {
  readonly enabled: boolean
  /** `undefined`: the plugin rule. */
  readonly lock: boolean | undefined
  readonly maxDuration: number | undefined
  readonly overlap: OverlapPolicy
  readonly runOnStart: boolean
  readonly timeZone: string | undefined
}

const COMMON_KEYS = ['enabled', 'lock', 'maxDuration']
const KEYS: Readonly<Record<JobKind, readonly string[]>> = {
  cron: [...COMMON_KEYS, 'timeZone', 'overlap', 'runOnStart'],
  interval: [...COMMON_KEYS, 'overlap', 'runOnStart'],
  timeout: COMMON_KEYS,
}

/** Validates the options of a dynamic job (`registry.addCron(name, expression, handler, options)`). */
export function normalizeJobOptions(kind: JobKind, options: unknown, where: string): NormalizedJobOptions {
  if (options === undefined) return defaults()
  if (!isRecord(options)) throw invalid(`${where}: options must be an object, got ${describe(options)}`)
  for (const key of Object.keys(options)) {
    if (KEYS[kind].includes(key)) continue
    throw unknownOption(kind, key, where)
  }
  const enabled = options['enabled']
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw invalid(`${where}: 'enabled' must be a boolean, got ${describe(enabled)}`)
  }
  const lock = options['lock']
  if (lock !== undefined && typeof lock !== 'boolean') {
    throw invalid(`${where}: 'lock' must be a boolean, got ${describe(lock)}`)
  }
  const overlap = options['overlap']
  if (overlap !== undefined && !OVERLAP_POLICIES.includes(overlap as OverlapPolicy)) {
    throw invalid(`${where}: 'overlap' must be 'skip', 'queue' or 'allow', got ${describe(overlap)}`)
  }
  const runOnStart = options['runOnStart']
  if (runOnStart !== undefined && typeof runOnStart !== 'boolean') {
    throw invalid(`${where}: 'runOnStart' must be a boolean, got ${describe(runOnStart)}`)
  }
  const timeZone = options['timeZone']
  if (timeZone !== undefined && (typeof timeZone !== 'string' || timeZone === '')) {
    throw invalid(`${where}: 'timeZone' must be a non-empty string, got ${describe(timeZone)}`)
  }
  const raw = options['maxDuration']
  const maxDuration = raw === undefined ? undefined : durationMs(raw, `${where}: 'maxDuration'`, 1)
  const result: NormalizedJobOptions = {
    enabled: enabled ?? true,
    lock,
    maxDuration,
    overlap: (overlap as OverlapPolicy | undefined) ?? 'skip',
    runOnStart: runOnStart ?? false,
    timeZone,
  }
  assertLockOverlap(result, where)
  return result
}

/** `lock: true` with `overlap: 'allow'` is contradictory (concurrent runs cannot share one lease). */
export function assertLockOverlap(options: Pick<NormalizedJobOptions, 'lock' | 'overlap'>, where: string): void {
  if (options.lock === true && options.overlap === 'allow') {
    throw invalid(`${where}: lock: true cannot be combined with overlap: 'allow'`, [
      "Concurrent runs cannot share one lock: use overlap: 'skip' or 'queue', or drop lock: true",
    ])
  }
}

/** A duration in milliseconds, at least `min`. */
export function durationMs(value: unknown, label: string, min: number): number {
  const result = checkDuration(value)
  if (!result.ok) throw invalid(`${label}: ${result.message}`, result.hint === undefined ? [] : [result.hint])
  if (result.ms < min) throw invalid(`${label} must be at least ${min} ms, got ${describe(value)}`)
  return result.ms
}

/** A valid job name (ZNIGHT040 otherwise). */
export function assertJobName(name: unknown, where: string): asserts name is string {
  if (!isJobName(name)) throw invalid(`${where}: invalid job name ${describe(name)}`, [`Job names: ${JOB_NAME_RULE}`])
}

function unknownOption(kind: JobKind, key: string, where: string): InvalidScheduleError {
  if (key === 'timeZone' && kind !== 'cron') {
    return invalid(`${where}: unknown option 'timeZone'`, [
      'Intervals and timeouts are durations: use a cron job for wall-clock schedules',
    ])
  }
  if ((key === 'overlap' || key === 'runOnStart') && kind === 'timeout') {
    return invalid(`${where}: unknown option '${key}'`, ['A timeout runs once: overlap and runOnStart do not apply'])
  }
  if (key === 'name') return invalid(`${where}: unknown option 'name'`, ['The name is the first argument'])
  const suggestion = closest(key, KEYS[kind])
  return invalid(
    `${where}: unknown option '${key}'${suggestion === undefined ? '' : ` (did you mean '${suggestion}'?)`}`,
    [`Options: ${KEYS[kind].join(', ')}`],
  )
}

function defaults(): NormalizedJobOptions {
  return {
    enabled: true,
    lock: undefined,
    maxDuration: undefined,
    overlap: 'skip',
    runOnStart: false,
    timeZone: undefined,
  }
}

/** Shorthand for a ZNIGHT040 error. */
export function invalid(message: string, hints: readonly string[] = []): InvalidScheduleError {
  return new InvalidScheduleError(message, { hints })
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Short description of a value for messages. */
export function describe(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'function') return 'a function'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'object') return 'an object'
  return String(value)
}
