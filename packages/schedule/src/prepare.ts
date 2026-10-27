/**
 * Boot-time validation (RFC 0004 §6.3, §7.1): plugin options, the schedule section of the metadata
 * (it may be hand-written), `jobs` overrides and lock requirements. Expressions and zones are checked
 * again with this runtime's `Intl`.
 */
import type { Container, ProviderDefinition, Token } from '@znight/core'
import type { ScheduleClock } from './clock.ts'
import type { JobContext } from './context.ts'
import type { Duration } from './duration.ts'
import type { ScheduleLockOptions, ScheduleLockStore } from './lock.ts'
import type { OverlapPolicy } from './options.ts'
import type { JobInit, ResolvedLock, RuntimeSettings } from './runtime.ts'
import type { JobKind } from './validate.ts'

import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { displayName, ErrorCode, ZnightError } from '@znight/core'

import { isScheduleClock, MAX_TIMER_DELAY, systemClock } from './clock.ts'
import { compileExpression, zoneOrThrow } from './cron.ts'
import { duplicateJobError, missingLockStoreError, unknownJobError } from './errors.ts'
import { closest } from './names.ts'
import { OVERLAP_POLICIES } from './options.ts'
import { normalizeCron } from './runtime.ts'
import { assertJobName, assertLockOverlap, describe, durationMs, invalid, isRecord } from './validate.ts'

/** Options of `SchedulePlugin.configure()`. */
export interface SchedulePluginOptions {
  /** `false`: nothing is scheduled. The registry still lists, triggers and adds jobs. Default `true`. */
  readonly enabled?: boolean
  /** Default zone of cron jobs. Default `'UTC'`. */
  readonly timeZone?: string
  /** Lock store for single-runner jobs, or the store with its settings. Default: none. */
  readonly lock?: ScheduleLockStore | ScheduleLockOptions
  /** Per-job overrides, by job name. */
  readonly jobs?: Readonly<Record<string, JobOverride>>
  /** Maximum wait for running jobs on shutdown, in ms; keep it below `shutdown.hookTimeoutMs`. `Infinity`: no limit of its own. Default 4000. */
  readonly drainTimeoutMs?: number
  /** Time source and timers. Default: the system clock. Tests: `createTestClock()`. */
  readonly clock?: ScheduleClock
}

/** The kind of a job never changes: `cron` and `timeZone` apply to cron jobs, `every` to intervals, `delay` to timeouts. */
export interface JobOverride {
  readonly enabled?: boolean
  readonly cron?: string
  readonly timeZone?: string
  readonly every?: Duration
  readonly delay?: Duration
  readonly overlap?: OverlapPolicy
  readonly lock?: boolean
  readonly maxDuration?: Duration | false
}

/** Settings plus the raw overrides (checked against the metadata). */
export interface ResolvedOptions {
  readonly settings: RuntimeSettings
  readonly overrides: Readonly<Record<string, JobOverride>>
}

const OPTION_KEYS = ['enabled', 'timeZone', 'lock', 'jobs', 'drainTimeoutMs', 'clock']
const LOCK_KEYS = ['store', 'keyPrefix', 'ttl', 'owner']
const OVERRIDE_KEYS = ['enabled', 'cron', 'timeZone', 'every', 'delay', 'overlap', 'lock', 'maxDuration']
const DEFAULT_DRAIN_MS = 4000
const DEFAULT_TTL_MS = 30_000
const DEFAULT_KEY_PREFIX = 'znight:schedule:'

/** Validates `SchedulePlugin` options (ZNIGHT040). */
export function resolvePluginOptions(raw: unknown): ResolvedOptions {
  const where = 'SchedulePlugin.configure()'
  const options = raw === undefined ? {} : raw
  if (!isRecord(options)) throw invalid(`${where}: options must be an object, got ${describe(options)}`)
  checkKeys(options, OPTION_KEYS, `${where}: unknown option`)
  const enabled = options['enabled']
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw invalid(`${where}: 'enabled' must be a boolean, got ${describe(enabled)}`)
  }
  const timeZone = options['timeZone'] ?? 'UTC'
  if (typeof timeZone !== 'string') throw invalid(`${where}: 'timeZone' must be a string, got ${describe(timeZone)}`)
  zoneOrThrow(timeZone, `${where}: invalid 'timeZone'`)
  const drain = options['drainTimeoutMs'] ?? DEFAULT_DRAIN_MS
  if (typeof drain !== 'number' || Number.isNaN(drain) || drain < 0) {
    throw invalid(
      `${where}: 'drainTimeoutMs' must be a number of milliseconds >= 0 (or Infinity), got ${describe(drain)}`,
    )
  }
  const clock = options['clock'] ?? systemClock
  if (!isScheduleClock(clock)) {
    throw invalid(`${where}: 'clock' must be a ScheduleClock ({ now, setTimer, clearTimer })`, [
      "Use createTestClock() from '@znight/schedule/testing' in tests",
    ])
  }
  const jobs = options['jobs'] ?? {}
  if (!isRecord(jobs)) throw invalid(`${where}: 'jobs' must be an object keyed by job name, got ${describe(jobs)}`)
  return {
    settings: {
      enabled: enabled ?? true,
      timeZone,
      lock: resolveLock(options['lock'], where),
      drainTimeoutMs: drain === Number.POSITIVE_INFINITY ? drain : Math.min(drain, MAX_TIMER_DELAY),
      clock,
    },
    overrides: jobs as Readonly<Record<string, JobOverride>>,
  }
}

function resolveLock(value: unknown, where: string): ResolvedLock | undefined {
  if (value === undefined) return undefined
  if (isLockStore(value))
    return { store: value, keyPrefix: DEFAULT_KEY_PREFIX, ttlMs: DEFAULT_TTL_MS, owner: defaultOwner() }
  if (!isRecord(value) || !isLockStore(value['store'])) {
    throw invalid(`${where}: 'lock' must be a lock store ({ name, acquire }) or { store, keyPrefix?, ttl?, owner? }`, [
      'memoryLockStore() works within one process; the guide has Postgres and Redis stores',
    ])
  }
  checkKeys(value, LOCK_KEYS, `${where}: unknown 'lock' option`)
  const keyPrefix = value['keyPrefix'] ?? DEFAULT_KEY_PREFIX
  if (typeof keyPrefix !== 'string')
    throw invalid(`${where}: 'lock.keyPrefix' must be a string, got ${describe(keyPrefix)}`)
  const owner = value['owner'] ?? defaultOwner()
  if (typeof owner !== 'string' || owner === '') {
    throw invalid(`${where}: 'lock.owner' must be a non-empty string, got ${describe(owner)}`)
  }
  const ttl = value['ttl'] === undefined ? DEFAULT_TTL_MS : durationMs(value['ttl'], `${where}: 'lock.ttl'`, 1000)
  return { store: value['store'], keyPrefix, ttlMs: ttl, owner }
}

function isLockStore(value: unknown): value is ScheduleLockStore {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Partial<ScheduleLockStore>).acquire === 'function' &&
    typeof (value as Partial<ScheduleLockStore>).name === 'string'
  )
}

/** `<hostname>:<pid>:<8 random hex>`. */
function defaultOwner(): string {
  let host = 'unknown'
  try {
    host = hostname()
  } catch {
    // keep the placeholder
  }
  return `${host}:${globalThis.process?.pid ?? 0}:${randomBytes(4).toString('hex')}`
}

/** The jobs of the metadata section, validated, overrides applied (ZNIGHT001, ZNIGHT040–043). */
export function prepareJobs(section: unknown, container: Container, options: ResolvedOptions): JobInit[] {
  const definitions = readSection(section)
  const settings = options.settings
  const byName = new Map<string, Readonly<Record<string, unknown>>>()
  for (const [index, definition] of definitions.entries()) {
    if (!isRecord(definition)) throw invalid(`Invalid schedule metadata: job #${index} is not an object`, REGENERATE)
    assertJobName(definition['name'], `Invalid schedule metadata (job #${index})`)
    if (byName.has(definition['name'])) throw duplicateJobError(definition['name'], REGENERATE)
    byName.set(definition['name'], definition)
  }
  for (const name of Object.keys(options.overrides)) {
    if (!byName.has(name)) throw unknownJobError(name, byName.keys(), "SchedulePlugin option 'jobs': no job")
  }
  const jobs: JobInit[] = []
  const lockRequired: string[] = []
  for (const [name, definition] of byName) {
    const job = prepareJob(name, definition, options.overrides[name], container, settings)
    if (job.lock === true && settings.lock === undefined) lockRequired.push(name)
    jobs.push(job)
  }
  if (lockRequired.length > 0) throw missingLockStoreError(lockRequired)
  return jobs
}

const REGENERATE = ['Regenerate the metadata with the @znight/schedule compiler extension']

function readSection(section: unknown): readonly unknown[] {
  if (section === undefined) return []
  if (!isRecord(section) || !Array.isArray(section['jobs'])) {
    throw invalid('Invalid schedule metadata: "jobs" must be an array', REGENERATE)
  }
  return section['jobs']
}

function prepareJob(
  name: string,
  definition: Readonly<Record<string, unknown>>,
  override: unknown,
  container: Container,
  settings: RuntimeSettings,
): JobInit {
  const where = `Job '${name}'`
  const token = definition['token']
  const method = definition['method']
  const invoke = definition['invoke']
  const kind = definition['kind']
  if (typeof token !== 'string' || token === '')
    throw invalid(`${where}: invalid metadata (missing host token)`, REGENERATE)
  if (typeof method !== 'string' || method === '')
    throw invalid(`${where}: invalid metadata (missing method)`, REGENERATE)
  if (typeof invoke !== 'function') throw invalid(`${where}: invalid metadata (no invoker)`, REGENERATE)
  if (kind !== 'cron' && kind !== 'interval' && kind !== 'timeout') {
    throw invalid(`${where}: invalid metadata (kind ${describe(kind)})`, REGENERATE)
  }
  if (!container.has(token)) {
    throw new ZnightError(ErrorCode.MissingProvider, `${where}: no provider is registered for its host ${token}`, {
      hints: ['Regenerate the metadata: the host class of a job must be a compiled provider'],
    })
  }

  // the definition, then the override
  const merged = applyOverride(kind, definition, override, where)
  const overlap = merged.overlap
  const lock = merged.lock
  assertLockOverlap({ lock, overlap }, where)

  let schedule: JobInit['schedule']
  switch (kind) {
    case 'cron': {
      if (typeof merged.cron !== 'string') throw invalid(`${where}: invalid metadata (cron)`, REGENERATE)
      const ownZone = merged.timeZone
      const zone = ownZone ?? settings.timeZone
      schedule = {
        kind,
        cron: normalizeCron(merged.cron),
        timeZone: zone,
        ownZone,
        engine: compileExpression(merged.cron, zone, `${where}: invalid cron expression`),
      }
      break
    }
    case 'interval':
      schedule = { kind, every: durationMs(merged.every, `${where}: the interval`, 1) }
      break
    case 'timeout':
      schedule = { kind, delay: durationMs(merged.delay, `${where}: the delay`, 0) }
      break
  }

  const provider: ProviderDefinition | undefined = Object.hasOwn(container.metadata.providers, token)
    ? container.metadata.providers[token]
    : undefined
  const call = definition['invoke'] as (host: unknown, ctx: JobContext) => unknown
  // a singleton host is resolved once, at bootstrap; other scopes in each run's scope
  let invokeJob: (ctx: JobContext) => unknown
  if (provider === undefined || provider.scope === 'singleton') {
    const host = container.get(token as Token)
    invokeJob = ctx => call(host, ctx)
  } else {
    invokeJob = ctx => call(container.get(token as Token), ctx)
  }
  return {
    name,
    origin: 'decorator',
    host: displayName(token),
    method,
    token,
    schedule,
    overlap,
    lock,
    maxDuration: merged.maxDuration,
    enabled: merged.enabled,
    runOnStart: merged.runOnStart,
    invoke: invokeJob,
  }
}

interface MergedDefinition {
  readonly cron: unknown
  readonly timeZone: string | undefined
  readonly every: unknown
  readonly delay: unknown
  readonly overlap: OverlapPolicy
  readonly lock: boolean | undefined
  readonly maxDuration: number | undefined
  readonly enabled: boolean
  readonly runOnStart: boolean
}

function applyOverride(
  kind: JobKind,
  definition: Readonly<Record<string, unknown>>,
  override: unknown,
  where: string,
): MergedDefinition {
  // what the metadata says (validated like an override, since it may be hand-written)
  const base = checkFields(kind, definition, `${where} (metadata)`, true)
  if (override === undefined) return base
  if (!isRecord(override))
    throw invalid(`SchedulePlugin option 'jobs' of ${where}: expected an object, got ${describe(override)}`)
  checkKeys(override, OVERRIDE_KEYS, `SchedulePlugin option 'jobs' of ${where}: unknown key`)
  const label = `SchedulePlugin option 'jobs' of ${where}`
  if (kind !== 'cron' && (override['cron'] !== undefined || override['timeZone'] !== undefined)) {
    throw invalid(
      `${label}: 'cron' and 'timeZone' apply to cron jobs, this job is a${kind === 'interval' ? 'n interval' : ' timeout'}`,
    )
  }
  if (kind !== 'interval' && override['every'] !== undefined) {
    throw invalid(`${label}: 'every' applies to intervals, this job is a ${kind === 'cron' ? 'cron job' : 'timeout'}`)
  }
  if (kind !== 'timeout' && override['delay'] !== undefined) {
    throw invalid(`${label}: 'delay' applies to timeouts, this job is a${kind === 'cron' ? ' cron job' : 'n interval'}`)
  }
  if (kind === 'timeout' && override['overlap'] !== undefined)
    throw invalid(`${label}: a timeout has no overlap policy`)
  const patch = checkFields(kind, override, label, false)
  const maxDuration = override['maxDuration'] === false ? undefined : (patch.maxDuration ?? base.maxDuration)
  return {
    cron: override['cron'] ?? base.cron,
    timeZone: patch.timeZone ?? base.timeZone,
    every: override['every'] ?? base.every,
    delay: override['delay'] ?? base.delay,
    overlap: override['overlap'] === undefined ? base.overlap : patch.overlap,
    lock: patch.lock ?? base.lock,
    maxDuration,
    enabled: override['enabled'] === undefined ? base.enabled : patch.enabled,
    runOnStart: base.runOnStart,
  }
}

/** Checks the scheduling fields of a definition or an override. */
function checkFields(
  kind: JobKind,
  value: Readonly<Record<string, unknown>>,
  where: string,
  metadata: boolean,
): MergedDefinition {
  const cron = value['cron']
  if (cron !== undefined && typeof cron !== 'string')
    throw invalid(`${where}: 'cron' must be a string, got ${describe(cron)}`)
  const timeZone = value['timeZone']
  if (timeZone !== undefined) {
    if (typeof timeZone !== 'string' || timeZone === '') {
      throw invalid(`${where}: 'timeZone' must be a non-empty string, got ${describe(timeZone)}`)
    }
    zoneOrThrow(timeZone, `${where}: invalid 'timeZone'`)
  }
  const overlap = value['overlap']
  if (overlap !== undefined && !OVERLAP_POLICIES.includes(overlap as OverlapPolicy)) {
    throw invalid(`${where}: 'overlap' must be 'skip', 'queue' or 'allow', got ${describe(overlap)}`)
  }
  const lock = value['lock']
  if (lock !== undefined && typeof lock !== 'boolean')
    throw invalid(`${where}: 'lock' must be a boolean, got ${describe(lock)}`)
  const enabled = value['enabled']
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw invalid(`${where}: 'enabled' must be a boolean, got ${describe(enabled)}`)
  }
  const raw = value['maxDuration']
  const maxDuration = raw === undefined || raw === false ? undefined : durationMs(raw, `${where}: 'maxDuration'`, 1)
  if (raw === false && metadata) throw invalid(`${where}: 'maxDuration' must be a number of milliseconds`)
  const runOnStart = value['runOnStart']
  if (metadata && runOnStart !== undefined && (runOnStart !== true || kind === 'timeout')) {
    throw invalid(`${where}: invalid 'runOnStart' ${describe(runOnStart)}`, REGENERATE)
  }
  return {
    cron,
    timeZone,
    every: value['every'],
    delay: value['delay'],
    overlap: (overlap as OverlapPolicy | undefined) ?? 'skip',
    lock,
    maxDuration,
    enabled: enabled ?? true,
    runOnStart: runOnStart === true,
  }
}

function checkKeys(value: Readonly<Record<string, unknown>>, known: readonly string[], prefix: string): void {
  for (const key of Object.keys(value)) {
    if (known.includes(key)) continue
    const suggestion = closest(key, known)
    throw invalid(`${prefix} '${key}'${suggestion === undefined ? '' : ` (did you mean '${suggestion}'?)`}`, [
      `Known: ${known.join(', ')}`,
    ])
  }
}
