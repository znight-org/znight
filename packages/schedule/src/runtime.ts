/**
 * The scheduler (RFC 0004 §7): one timer for every job, a heap of deadlines, the run pipeline
 * (overlap → lease → scope → hooks → settle) and the graceful shutdown.
 *
 * - **One timer.** Deadlines live in a binary heap (ties broken by job name). A single timer is armed
 *   for the earliest deadline, capped at 60 s; every wake-up re-reads the clock and fires what is due.
 *   The cap handles delays over 2^31 − 1 ms, wall-clock jumps and monotonic timers stopped by sleep.
 *   While the scheduler runs, the timer is always armed: it keeps the process alive.
 * - **Occurrences.** Cron: the engine's next occurrence; intervals: the multiples of `every` since
 *   the epoch; timeouts: once, `delay` after the start. A late wake-up runs a job once, for its
 *   latest missed occurrence; an occurrence never runs twice in a process (backward clock jumps).
 *   The next occurrence is armed when one fires, not when its run settles.
 */
import type { Container, CoreLogger, Hooks, ScheduledRunEvent, Token } from '@znight/core'
import type { ScheduleClock } from './clock.ts'
import type { JobContext, JobHandler, RunOutcome, RunTrigger } from './context.ts'
import type { CronEngine } from './cron/schedule.ts'
import type { Duration } from './duration.ts'
import type { JobAbortReason } from './errors.ts'
import type { LockLease, ScheduleLockStore } from './lock.ts'
import type { OverlapPolicy } from './options.ts'
import type { JobRunResult, JobState, ScheduledJob } from './registry.ts'
import type { JobKind } from './validate.ts'

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

import { compileExpression } from './cron.ts'
import { formatDuration } from './duration.ts'
import {
  duplicateJobError,
  JobAbortedError,
  missingLockStoreError,
  notAvailableError,
  unknownJobError,
} from './errors.ts'
import { ScheduleTokens } from './tokens.ts'
import { assertLockOverlap, describe, durationMs, invalid } from './validate.ts'

/** Lock settings resolved from the plugin options. */
export interface ResolvedLock {
  readonly store: ScheduleLockStore
  readonly keyPrefix: string
  readonly ttlMs: number
  readonly owner: string
}

/** Settings resolved from the plugin options. */
export interface RuntimeSettings {
  readonly enabled: boolean
  /** Default zone of cron jobs, as written. */
  readonly timeZone: string
  readonly lock: ResolvedLock | undefined
  readonly drainTimeoutMs: number
  readonly clock: ScheduleClock
}

/** What the runtime needs from the application. */
export interface RuntimeServices {
  readonly container: Container
  readonly hooks: Hooks
  readonly logger: CoreLogger
}

/** How a job is scheduled. */
export type JobSchedule =
  | {
      readonly kind: 'cron'
      readonly cron: string
      /** Effective zone, as written. */
      readonly timeZone: string
      /** The zone given by the job itself (`undefined`: the plugin's). */
      readonly ownZone: string | undefined
      readonly engine: CronEngine
    }
  | { readonly kind: 'interval'; readonly every: number }
  | { readonly kind: 'timeout'; readonly delay: number }

/** A job to register (static or dynamic). */
export interface JobInit {
  readonly name: string
  readonly origin: 'decorator' | 'dynamic'
  /** Display name of the host class (`undefined` for dynamic jobs). */
  readonly host: string | undefined
  readonly method: string | undefined
  readonly token: Token | undefined
  readonly schedule: JobSchedule
  readonly overlap: OverlapPolicy
  /** `undefined`: the plugin rule. */
  readonly lock: boolean | undefined
  readonly maxDuration: number | undefined
  readonly enabled: boolean
  readonly runOnStart: boolean
  readonly invoke: JobHandler
}

/** State of the runtime (the plugin's `state` once bootstrapped). */
export type RuntimeState = 'bootstrapped' | 'running' | 'stopping' | 'stopped'

const RESYNC_MS = 60_000
const DAY = 86_400_000
const MAX_DRAIN_MS = 2 ** 31 - 1

/** The run in progress, for `stop()` called from inside a run (it must not wait for itself). */
const currentRun = new AsyncLocalStorage<RunRecord>()

export interface PendingRun {
  scheduledAt: number
  /** A manual `trigger()` waits for it: it runs even if the job is paused meanwhile. */
  manual: boolean
  readonly waiters: ((result: JobRunResult) => void)[]
}

/** Internal state of one job. */
export class JobRecord {
  readonly name: string
  readonly origin: 'decorator' | 'dynamic'
  readonly host: string | undefined
  readonly method: string | undefined
  readonly invoke: JobHandler
  readonly runOnStart: boolean
  readonly lockOption: boolean | undefined
  readonly handle: ScheduledJob
  schedule: JobSchedule
  overlap: OverlapPolicy
  locked: boolean
  maxDuration: number | undefined
  state: JobState
  readonly running: Set<RunRecord> = new Set()
  pending: PendingRun | undefined
  lastRun: JobRunResult | undefined
  previous: { readonly scheduledAt: Date; readonly outcome: RunOutcome } | undefined
  /** The armed occurrence. */
  deadline: number | undefined
  /** The latest occurrence fired (monotonic per job). */
  lastOccurrence: number | undefined
  /** Timeouts: the instant of the occurrence once armed. */
  timeoutAt: number | undefined
  fired = false
  /** Bumped whenever the armed deadline is cancelled (stale heap entries are skipped). */
  generation = 0

  constructor(init: JobInit, locked: boolean, runtime: ScheduleRuntime) {
    this.name = init.name
    this.origin = init.origin
    this.host = init.host
    this.method = init.method
    this.invoke = init.invoke
    this.runOnStart = init.runOnStart
    this.lockOption = init.lock
    this.schedule = init.schedule
    this.overlap = init.overlap
    this.locked = locked
    this.maxDuration = init.maxDuration
    this.state = init.enabled ? 'scheduled' : 'disabled'
    this.handle = new JobHandle(this, runtime)
  }

  get kind(): JobKind {
    return this.schedule.kind
  }
}

/** One run in flight. */
export interface RunRecord {
  readonly runtime: ScheduleRuntime
  readonly job: JobRecord
  readonly runId: string
  readonly controller: AbortController
  /** Started by `trigger()` (directly or queued): runs even when the job is paused. */
  readonly manual: boolean
  /** Clock time when the run was dispatched. */
  readonly dispatchedAt: number
  promise: Promise<JobRunResult>
  event: ScheduledRunEvent | undefined
  aborted: JobAbortReason | undefined
  abandoned: boolean
  settled: boolean
  timeout: unknown
  heartbeat: unknown
  /** Fires when `ttl` elapsed since the last successful extension of the lease (`lock-lost`). */
  leaseDeadline: unknown
  /** Bounds the lock store call in progress (`acquire`, `release`). */
  storeTimer: unknown
  abort: (reason: JobAbortReason) => void
}

interface HeapEntry {
  readonly deadline: number
  readonly name: string
  readonly job: JobRecord
  readonly generation: number
}

/** The scheduler of one application. */
export class ScheduleRuntime {
  readonly settings: RuntimeSettings
  readonly #services: RuntimeServices
  readonly #jobs = new Map<string, JobRecord>()
  readonly #inflight = new Set<RunRecord>()
  readonly #heap = new DeadlineHeap()
  /** Async context of the bootstrap: timers never inherit the context of whoever armed them. */
  readonly #context: <R>(fn: () => R) => R
  #state: RuntimeState = 'bootstrapped'
  #active = false
  #timer: unknown
  #disposed = false

  constructor(settings: RuntimeSettings, services: RuntimeServices) {
    this.settings = settings
    this.#services = services
    this.#context = AsyncLocalStorage.snapshot()
  }

  get state(): RuntimeState {
    return this.#state
  }

  get clock(): ScheduleClock {
    return this.settings.clock
  }

  /** Jobs sorted by name. */
  jobs(): JobRecord[] {
    return [...this.#jobs.values()].sort((a, b) => compare(a.name, b.name))
  }

  get(name: string): JobRecord | undefined {
    return this.#jobs.get(name)
  }

  /** Registers a job: ZNIGHT041 for a taken name, ZNIGHT043 / ZNIGHT040 for its lock settings. */
  add(init: JobInit): JobRecord {
    if (this.#jobs.has(init.name)) throw duplicateJobError(init.name)
    const job = new JobRecord(init, this.#locked(init.name, init.lock, init.overlap), this)
    this.#jobs.set(job.name, job)
    if (this.#active && job.state === 'scheduled') {
      const now = this.clock.now()
      if (job.kind === 'timeout') job.timeoutAt = now + (job.schedule as { delay: number }).delay
      this.#arm(job, now)
      if (job.runOnStart) void this.#dispatch(job, now, 'start')
      this.#rearm()
    }
    return job
  }

  /** Whether a job with these options is locked (ZNIGHT043 when it requires a lock without store). */
  #locked(name: string, lock: boolean | undefined, overlap: OverlapPolicy): boolean {
    assertLockOverlap({ lock, overlap }, `Job '${name}'`)
    if (lock === true && this.settings.lock === undefined) throw missingLockStoreError([name])
    return lock ?? (this.settings.lock !== undefined && overlap !== 'allow')
  }

  // ------------------------------------------------------------------------------------- lifecycle

  /** Arms every job (`onReady`): first occurrences, timeout deadlines, `runOnStart` runs. */
  start(): void {
    if (this.#state !== 'bootstrapped') return
    this.#state = 'running'
    if (!this.settings.enabled) return
    this.#active = true
    const now = this.clock.now()
    const jobs = this.jobs()
    for (const job of jobs) {
      if (job.kind === 'timeout' && job.timeoutAt === undefined) {
        job.timeoutAt = now + (job.schedule as { delay: number }).delay
      }
      this.#arm(job, now)
    }
    for (const job of jobs) {
      if (job.runOnStart && job.state === 'scheduled') void this.#dispatch(job, now, 'start')
    }
    this.#wake()
  }

  /** The earliest armed occurrence. */
  nextDeadline(): { readonly job: string; readonly at: number } | undefined {
    const top = this.#heap.peekValid()
    return top === undefined ? undefined : { job: top.name, at: top.deadline }
  }

  /**
   * `onStop`: stops arming, drops queued runs, aborts every running run (`shutdown`), waits up to
   * `drainTimeoutMs`, then abandons the runs still in flight (their leases are not released).
   */
  async stop(): Promise<void> {
    if (this.#state === 'stopping' || this.#state === 'stopped') return
    this.#state = 'stopping'
    this.#deactivate()
    for (const job of this.#jobs.values()) this.#dropPending(job)
    const caller = currentRun.getStore()
    const runs = [...this.#inflight]
    for (const run of runs) run.abort('shutdown')
    // a stop() called from a run never waits for that run (it would wait for itself)
    const waited = runs.filter(run => run !== caller)
    if (waited.length > 0) {
      const drained = await settleWithin(
        waited.map(run => run.promise),
        this.settings.drainTimeoutMs,
      )
      if (!drained) {
        const now = this.clock.now()
        for (const run of waited) {
          if (run.settled) continue
          run.abandoned = true
          this.#stopTimers(run)
          this.#services.logger.warn(
            `Schedule: run ${run.runId} of job '${run.job.name}' abandoned after ${now - run.dispatchedAt} ms: it did not settle within drainTimeoutMs`,
            { job: run.job.name, runId: run.runId, durationMs: now - run.dispatchedAt },
          )
        }
      }
    }
    this.#state = 'stopped'
  }

  /** `onDispose`: clears every timer (lock store calls in flight go on unbounded). */
  dispose(): void {
    this.#disposed = true
    this.#state = 'stopped'
    this.#deactivate()
    for (const run of this.#inflight) {
      this.#stopTimers(run)
      if (run.storeTimer !== undefined) this.clock.clearTimer(run.storeTimer)
      run.storeTimer = undefined
    }
  }

  #deactivate(): void {
    this.#active = false
    if (this.#timer !== undefined) this.clock.clearTimer(this.#timer)
    this.#timer = undefined
    for (const job of this.#jobs.values()) {
      job.generation++
      job.deadline = undefined
    }
    this.#heap.clear()
  }

  // ------------------------------------------------------------------------------------- registry

  /** Whether the scheduler accepts new jobs and manual runs. */
  assertOpen(action: string): void {
    if (this.#state === 'stopping' || this.#state === 'stopped') throw notAvailableError(action, this.#state)
  }

  trigger(job: JobRecord): Promise<JobRunResult> {
    try {
      this.assertOpen(`trigger('${job.name}')`)
      if (job.state === 'removed') throw unknownJobError(job.name, this.#jobs.keys())
    } catch (error) {
      return Promise.reject(error)
    }
    return this.#dispatch(job, this.clock.now(), 'manual')
  }

  remove(name: string, abort: boolean): void {
    const job = this.#jobs.get(name)
    if (job === undefined) throw unknownJobError(name, this.#jobs.keys())
    job.state = 'removed'
    this.#disarm(job)
    this.#jobs.delete(name)
    this.#dropPending(job)
    if (abort) for (const run of job.running) run.abort('removed')
  }

  pause(job: JobRecord): void {
    if (job.state === 'removed') throw unknownJobError(job.name, this.#jobs.keys())
    if (job.state !== 'scheduled') return
    job.state = 'paused'
    this.#disarm(job)
    // a queued occurrence has not started: it is dropped like the next ones
    this.#dropPending(job)
  }

  resume(job: JobRecord): void {
    if (job.state === 'removed') throw unknownJobError(job.name, this.#jobs.keys())
    if (job.state !== 'paused') return
    job.state = 'scheduled'
    if (!this.#active) return
    const now = this.clock.now()
    this.#arm(job, Math.max(now, job.lastOccurrence ?? now))
    this.#rearm()
  }

  reschedule(job: JobRecord, schedule: unknown, options: unknown): void {
    if (job.state === 'removed') throw unknownJobError(job.name, this.#jobs.keys())
    const where = `reschedule() of job '${job.name}'`
    if (options !== undefined && (options === null || typeof options !== 'object')) {
      throw invalid(`${where}: options must be an object, got ${describe(options)}`)
    }
    const timeZone = (options as { readonly timeZone?: unknown } | undefined)?.timeZone
    const now = this.clock.now()
    const current = job.schedule
    switch (current.kind) {
      case 'cron': {
        if (typeof schedule !== 'string') {
          throw invalid(`${where}: a cron job takes a cron expression, got ${describe(schedule)}`)
        }
        if (timeZone !== undefined && (typeof timeZone !== 'string' || timeZone === '')) {
          throw invalid(`${where}: 'timeZone' must be a non-empty string, got ${describe(timeZone)}`)
        }
        const ownZone = (timeZone as string | undefined) ?? current.ownZone
        const zone = ownZone ?? this.settings.timeZone
        job.schedule = {
          kind: 'cron',
          cron: normalizeCron(schedule),
          timeZone: zone,
          ownZone,
          engine: compileExpression(schedule, zone, `${where}: invalid cron expression`),
        }
        // a job without further occurrence is armed again with its new expression
        if (job.state === 'done') job.state = 'scheduled'
        break
      }
      case 'interval':
        if (timeZone !== undefined) throw invalid(`${where}: intervals have no time zone`)
        job.schedule = { kind: 'interval', every: durationMs(schedule, `${where}: the interval`, 1) }
        break
      case 'timeout':
        if (timeZone !== undefined) throw invalid(`${where}: timeouts have no time zone`)
        job.schedule = { kind: 'timeout', delay: durationMs(schedule, `${where}: the delay`, 0) }
        job.fired = false
        // a new occurrence, after the one fired (`reschedule(0)` from the run itself, same millisecond)
        job.timeoutAt = Math.max(now + job.schedule.delay, (job.lastOccurrence ?? Number.NEGATIVE_INFINITY) + 1)
        if (job.state === 'done') job.state = 'scheduled'
        break
    }
    this.#disarm(job)
    if (this.#active && job.state === 'scheduled') {
      this.#arm(job, Math.max(now, job.lastOccurrence ?? now))
      this.#rearm()
    }
  }

  /** Resolves once no run is in flight (queued runs included). */
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight].map(run => run.promise))
  }

  /** The next `count` occurrences of a job after `from`. */
  nextRuns(job: JobRecord, count: number, from: number): number[] {
    const runs: number[] = []
    const schedule = job.schedule
    if (schedule.kind === 'timeout') {
      const at = job.fired ? undefined : (job.timeoutAt ?? from + schedule.delay)
      return at !== undefined && at > from && count > 0 ? [at] : []
    }
    let cursor = from
    for (let index = 0; index < count; index++) {
      const next =
        schedule.kind === 'cron'
          ? schedule.engine.next(cursor)
          : (Math.floor(cursor / schedule.every) + 1) * schedule.every
      if (next === undefined) break
      runs.push(next)
      cursor = next
    }
    return runs
  }

  // ------------------------------------------------------------------------------------ scheduling

  /** Cancels the armed occurrence of `job`, if any (the heap stops referencing the job). */
  #disarm(job: JobRecord): void {
    job.generation++
    job.deadline = undefined
    this.#heap.delete(job)
  }

  /** Arms the next occurrence of `job` strictly after `after`. */
  #arm(job: JobRecord, after: number): void {
    if (!this.#active || job.state !== 'scheduled') return
    this.#disarm(job)
    const schedule = job.schedule
    let deadline: number | undefined
    switch (schedule.kind) {
      case 'cron':
        deadline = schedule.engine.next(after)
        if (deadline === undefined) {
          job.state = 'done'
          this.#services.logger.warn(`Schedule: job '${job.name}' has no further occurrence within 400 years`, {
            job: job.name,
          })
          return
        }
        break
      case 'interval':
        deadline = (Math.floor(after / schedule.every) + 1) * schedule.every
        break
      case 'timeout':
        if (job.fired) {
          job.state = 'done'
          return
        }
        deadline = job.timeoutAt ?? after + schedule.delay
        break
    }
    job.deadline = deadline
    this.#heap.push({ deadline, name: job.name, job, generation: job.generation })
  }

  /** Re-arms the single timer after a change made outside a wake-up. */
  #rearm(): void {
    if (this.#active) this.#armTimer(this.clock.now())
  }

  #armTimer(now: number): void {
    if (this.#timer !== undefined) this.clock.clearTimer(this.#timer)
    this.#timer = undefined
    if (!this.#active) return
    const top = this.#heap.peekValid()
    const delay = top === undefined ? RESYNC_MS : Math.min(Math.max(0, top.deadline - now), RESYNC_MS)
    this.#timer = this.clock.setTimer(() => this.#context(() => this.#wake()), delay)
  }

  /** Fires every due occurrence, then re-arms the timer. */
  #wake(): void {
    this.#timer = undefined
    if (!this.#active) return
    const now = this.clock.now()
    for (;;) {
      const top = this.#heap.peek()
      if (top === undefined || top.deadline > now) break
      this.#heap.pop()
      const job = top.job
      if (top.generation !== job.generation || job.state !== 'scheduled') continue
      job.deadline = undefined
      const { latest, missed } = this.#latest(job, top.deadline, now)
      if (missed > 0) {
        this.#services.logger.debug(
          `Schedule: job '${job.name}' woke up late: ${missed} missed occurrence(s) skipped, running the latest`,
          { job: job.name, missed, scheduledAt: new Date(latest).toISOString() },
        )
      }
      const fire = job.lastOccurrence === undefined || latest > job.lastOccurrence
      if (job.kind === 'timeout') {
        // done before its run starts: a reschedule() from the run itself (even before its first
        // await) arms the timeout again
        job.fired = true
        job.state = 'done'
      }
      if (fire) {
        job.lastOccurrence = latest
        void this.#dispatch(job, latest, 'schedule')
      }
      if (job.kind === 'timeout') continue
      this.#arm(job, Math.max(now, job.lastOccurrence ?? now))
    }
    this.#armTimer(now)
  }

  /** The latest occurrence `<= now` from `deadline`, and how many were skipped before it. */
  #latest(job: JobRecord, deadline: number, now: number): { latest: number; missed: number } {
    const schedule = job.schedule
    if (schedule.kind === 'timeout') return { latest: deadline, missed: 0 }
    if (schedule.kind === 'interval') {
      const latest = Math.max(deadline, Math.floor(now / schedule.every) * schedule.every)
      return { latest, missed: Math.round((latest - deadline) / schedule.every) }
    }
    const engine = schedule.engine
    let latest = deadline
    let missed = 0
    for (; missed < 1000; missed++) {
      const next = engine.next(latest)
      if (next === undefined || next > now) return { latest, missed }
      latest = next
    }
    // many missed occurrences (a long sleep): look for the latest one close to now
    for (const window of [RESYNC_MS, 3_600_000, DAY, 32 * DAY, 367 * DAY]) {
      const first = engine.next(Math.max(latest, now - window))
      if (first === undefined || first > now) continue
      let candidate = first
      for (let step = 0; step < 100_000; step++) {
        const next = engine.next(candidate)
        if (next === undefined || next > now) break
        candidate = next
      }
      return { latest: candidate, missed: missed + 1 }
    }
    return { latest, missed }
  }

  // -------------------------------------------------------------------------------------- pipeline

  /** Overlap policy, then the run. Never rejects. */
  #dispatch(job: JobRecord, scheduledAt: number, trigger: RunTrigger): Promise<JobRunResult> {
    if (job.running.size > 0 && job.overlap !== 'allow') {
      if (job.overlap === 'queue') return this.#enqueue(job, scheduledAt, trigger === 'manual')
      return Promise.resolve(this.#skip(job, scheduledAt, trigger))
    }
    return this.#execute(job, scheduledAt, trigger, trigger === 'manual')
  }

  #enqueue(job: JobRecord, scheduledAt: number, manual: boolean): Promise<JobRunResult> {
    return new Promise(resolve => {
      const pending = job.pending
      if (pending === undefined) {
        job.pending = { scheduledAt, manual, waiters: [resolve] }
      } else {
        // a later occurrence replaces the queued one: one pending run, the latest occurrence
        pending.scheduledAt = Math.max(pending.scheduledAt, scheduledAt)
        pending.manual ||= manual
        pending.waiters.push(resolve)
      }
    })
  }

  /** Overlap `skip`: the occurrence is dropped (emitted, logged at `warn`). */
  #skip(job: JobRecord, scheduledAt: number, trigger: RunTrigger): JobRunResult {
    const runId = randomUUID()
    const now = this.clock.now()
    const oldest = Math.min(...[...job.running].map(run => run.dispatchedAt))
    this.#services.logger.warn(
      `Schedule: job '${job.name}' skipped: its previous run has been running for ${now - oldest} ms`,
      { job: job.name, runId, scheduledAt: new Date(scheduledAt).toISOString(), runningMs: now - oldest },
    )
    return this.#notExecuted(job, runId, scheduledAt, trigger, 'skipped', performance.now())
  }

  #dropPending(job: JobRecord): void {
    const pending = job.pending
    if (pending === undefined) return
    job.pending = undefined
    const result = this.#result(job, randomUUID(), pending.scheduledAt, 'queued', 'skipped', undefined, undefined)
    for (const waiter of pending.waiters) waiter(result)
  }

  /** A pending queued run starts when the current one settles. */
  #afterRun(job: JobRecord): void {
    const pending = job.pending
    if (pending === undefined || job.running.size > 0) return
    if (this.#state === 'stopping' || this.#state === 'stopped' || job.state === 'removed') {
      this.#dropPending(job)
      return
    }
    job.pending = undefined
    void this.#execute(job, pending.scheduledAt, 'queued', pending.manual).then(result => {
      for (const waiter of pending.waiters) waiter(result)
    })
  }

  #execute(job: JobRecord, scheduledAt: number, trigger: RunTrigger, manual: boolean): Promise<JobRunResult> {
    const controller = new AbortController()
    const run: RunRecord = {
      runtime: this,
      job,
      runId: randomUUID(),
      controller,
      manual,
      dispatchedAt: this.clock.now(),
      promise: undefined as unknown as Promise<JobRunResult>,
      event: undefined,
      aborted: undefined,
      abandoned: false,
      settled: false,
      timeout: undefined,
      heartbeat: undefined,
      leaseDeadline: undefined,
      storeTimer: undefined,
      abort: reason => this.#abort(run, reason),
    }
    job.running.add(run)
    this.#inflight.add(run)
    run.promise = this.#run(run, scheduledAt, trigger)
      .catch((error: unknown) => {
        // defensive: #run handles its failures
        this.#services.logger.error(`Schedule: unexpected failure of job '${job.name}'`, { err: error })
        return this.#result(job, run.runId, scheduledAt, trigger, 'failed', undefined, undefined, error)
      })
      .then(result => {
        run.settled = true
        this.#stopTimers(run)
        job.running.delete(run)
        this.#inflight.delete(run)
        this.#afterRun(job)
        return result
      })
    this.clock.track?.(run.promise)
    return run.promise
  }

  async #run(run: RunRecord, scheduledAt: number, trigger: RunTrigger): Promise<JobRunResult> {
    const { job } = run
    const { container, hooks, logger } = this.#services
    const startTime = performance.now()
    const lock = this.settings.lock
    let lease: LockLease | undefined
    const claimedAt = this.clock.now()
    if (job.locked && lock !== undefined) {
      try {
        lease = await this.#acquire(run, lock, scheduledAt)
      } catch (error) {
        logger.error(`Schedule: job '${job.name}' did not run: the ${lock.store.name} lock store failed`, {
          job: job.name,
          runId: run.runId,
          ...this.#errorContext(error),
        })
        return this.#notExecuted(job, run.runId, scheduledAt, trigger, 'failed', startTime, error)
      }
      if (lease === undefined) {
        logger.debug(`Schedule: job '${job.name}' not run: another instance holds the lock`, {
          job: job.name,
          runId: run.runId,
          scheduledAt: new Date(scheduledAt).toISOString(),
        })
        return this.#notExecuted(job, run.runId, scheduledAt, trigger, 'not-acquired', startTime)
      }
    }
    // the lease took time: the job may have been removed or paused, or the scheduler stopped meanwhile
    const dropped = this.#dropReason(run)
    if (dropped !== undefined) {
      // released even for a run abandoned at shutdown: its job never started
      if (lease !== undefined && lock !== undefined) await this.#release(run, lease, lock.ttlMs)
      return this.#drop(run, scheduledAt, trigger, startTime, dropped)
    }

    const startedAt = this.clock.now()
    const context: JobContext = Object.freeze({
      job: job.name,
      runId: run.runId,
      trigger,
      scheduledAt: new Date(scheduledAt),
      startedAt: new Date(startedAt),
      previous: job.previous,
      signal: run.controller.signal,
    })
    const event: ScheduledRunEvent = {
      job: job.name,
      kind: job.kind,
      host: job.host,
      method: job.method,
      runId: run.runId,
      trigger,
      scheduledAt,
      context,
      startTime,
    }
    if (run.aborted !== undefined) event.aborted = run.aborted
    run.event = event
    if (job.maxDuration !== undefined) {
      const limit = job.maxDuration
      run.timeout = this.clock.setTimer(() => {
        run.timeout = undefined
        if (run.settled || run.controller.signal.aborted) return
        logger.warn(
          `Schedule: run ${run.runId} of job '${job.name}' exceeded its maxDuration (${limit} ms): aborting it`,
          {
            job: job.name,
            runId: run.runId,
          },
        )
        run.abort('timeout')
      }, limit)
    }
    if (lease !== undefined && lock !== undefined) this.#heartbeat(run, lease, lock, claimedAt)

    let executed = false
    let vetoed: string | undefined
    let after: unknown
    try {
      await currentRun.run(run, () =>
        container.runInScope(
          () =>
            hooks.run('schedule:run', event, async () => {
              // hook wrappers may wait before calling next(): same check as after the lease
              vetoed = this.#dropReason(run)
              if (vetoed !== undefined) return
              executed = true
              try {
                await job.invoke(context)
              } catch (error) {
                event.outcome = 'failed'
                event.error = error
                throw error
              }
              event.outcome = 'completed'
            }),
          [[ScheduleTokens.JobContext, context]],
        ),
      )
    } catch (error) {
      if (event.outcome === undefined) {
        // a hook wrapper failed before the job, or the run scope could not be opened
        event.outcome = 'failed'
        event.error = error
      } else if (error !== event.error) {
        after = error // a wrapper or the disposal of request-scoped instances failed after the job
      }
    }
    if (event.outcome === undefined) event.outcome = 'skipped' // a hook wrapper did not call next()
    this.#stopTimers(run)
    const finishedAt = this.clock.now()
    if (lease !== undefined && lock !== undefined && (!run.abandoned || !executed)) {
      await this.#release(run, lease, lock.ttlMs)
    }
    if (vetoed !== undefined) {
      logger.debug(`Schedule: job '${job.name}' did not run: ${vetoed}`, { job: job.name, runId: run.runId })
    }
    const outcome = event.outcome
    const result = this.#result(
      job,
      run.runId,
      scheduledAt,
      trigger,
      outcome,
      startedAt,
      finishedAt,
      event.error,
      run.aborted,
    )
    job.lastRun = result
    if (executed) job.previous = Object.freeze({ scheduledAt: context.scheduledAt, outcome })
    if (hooks.hasListeners('schedule:run')) hooks.emit('schedule:run', event)
    if (outcome === 'failed') {
      logger.error(`Schedule: job '${job.name}' failed`, {
        job: job.name,
        runId: run.runId,
        trigger,
        ...this.#errorContext(event.error),
      })
    }
    if (after !== undefined) {
      logger.error(`Schedule: error after the run ${run.runId} of job '${job.name}'`, { job: job.name, err: after })
    }
    return result
  }

  /**
   * Why a dispatched run must not start its job (RFC 0004 §7.4), or `undefined`: its signal was
   * aborted (shutdown, `remove(name, { abort: true })`), the scheduler stops, the job was removed, or
   * paused (manual runs excepted). Checked once the lease is acquired and when the hook wrappers call
   * the job, since both may wait.
   */
  #dropReason(run: RunRecord): string | undefined {
    const reason = run.aborted ?? (run.controller.signal.aborted ? 'aborted' : undefined)
    if (reason !== undefined) return `its run was aborted (${reason}) before it started`
    if (this.#disposed || this.#state === 'stopping' || this.#state === 'stopped') return 'the scheduler is stopping'
    if (run.job.state === 'removed') return 'it was removed'
    if (run.job.state === 'paused' && !run.manual) return 'it was paused'
    return undefined
  }

  /** A run dropped before its job started: outcome `skipped` (logged at `debug`, emitted). */
  #drop(run: RunRecord, scheduledAt: number, trigger: RunTrigger, startTime: number, why: string): JobRunResult {
    const { job } = run
    this.#services.logger.debug(`Schedule: job '${job.name}' did not run: ${why}`, { job: job.name, runId: run.runId })
    return this.#notExecuted(job, run.runId, scheduledAt, trigger, 'skipped', startTime, undefined, run.aborted)
  }

  /** `store.acquire()`, bounded by the ttl: a store that does not answer fails closed (RFC 0004 §7.6). */
  async #acquire(run: RunRecord, lock: ResolvedLock, occurrence: number): Promise<LockLease | undefined> {
    const claim = Promise.resolve(
      lock.store.acquire(`${lock.keyPrefix}${run.job.name}`, { owner: lock.owner, occurrence, ttlMs: lock.ttlMs }),
    )
    const answer = await this.#bounded(run, claim, lock.ttlMs)
    if (answer.done) return answer.value
    // the claim may still succeed: its lease is released then, since the run did not start
    claim.then(
      late => (late === undefined ? undefined : Promise.resolve(late.release()).catch(() => undefined)),
      () => undefined,
    )
    throw new Error(`the ${lock.store.name} lock store did not answer within the lock ttl (${lock.ttlMs} ms)`)
  }

  /** `lease.release()`: a failure, or no answer within the ttl, is logged (the lease expires after its ttl). */
  async #release(run: RunRecord, lease: LockLease, ttl: number): Promise<void> {
    const { job } = run
    const { logger } = this.#services
    try {
      const call = Promise.resolve(lease.release())
      // no timer once disposed: the call goes on alone
      const answer = this.#disposed ? { done: true as const, value: await call } : await this.#bounded(run, call, ttl)
      if (!answer.done) {
        logger.warn(
          `Schedule: releasing the lock of job '${job.name}' did not answer within ${ttl} ms (it expires after its ttl)`,
          { job: job.name, runId: run.runId },
        )
      }
    } catch (error) {
      logger.warn(`Schedule: releasing the lock of job '${job.name}' failed (it expires after its ttl)`, {
        job: job.name,
        runId: run.runId,
        err: error,
      })
    }
  }

  /** Waits for a lock store call, at most `ms` on the scheduler clock. Rejections pass through. */
  #bounded<T>(
    run: RunRecord,
    call: Promise<T>,
    ms: number,
  ): Promise<{ readonly done: true; readonly value: T } | { readonly done: false }> {
    return new Promise((resolve, reject) => {
      const timer = this.clock.setTimer(() => {
        if (run.storeTimer === timer) run.storeTimer = undefined
        resolve({ done: false })
      }, ms)
      run.storeTimer = timer
      const clear = (): void => {
        this.clock.clearTimer(timer)
        if (run.storeTimer === timer) run.storeTimer = undefined
      }
      call.then(
        value => {
          clear()
          resolve({ done: true, value })
        },
        (error: unknown) => {
          clear()
          reject(error)
        },
      )
    })
  }

  /** An occurrence that did not execute: `skipped` (overlap, dropped), `not-acquired`, or a lock store failure. */
  #notExecuted(
    job: JobRecord,
    runId: string,
    scheduledAt: number,
    trigger: RunTrigger,
    outcome: RunOutcome,
    startTime: number,
    error?: unknown,
    aborted?: JobAbortReason,
  ): JobRunResult {
    const result = this.#result(job, runId, scheduledAt, trigger, outcome, undefined, undefined, error, aborted)
    job.lastRun = result
    const hooks = this.#services.hooks
    if (hooks.hasListeners('schedule:run')) {
      const event: ScheduledRunEvent = {
        job: job.name,
        kind: job.kind,
        host: job.host,
        method: job.method,
        runId,
        trigger,
        scheduledAt,
        context: undefined,
        startTime,
        outcome,
      }
      if (error !== undefined) event.error = error
      if (aborted !== undefined) event.aborted = aborted
      hooks.emit('schedule:run', event)
    }
    return result
  }

  #result(
    job: JobRecord,
    runId: string,
    scheduledAt: number,
    trigger: RunTrigger,
    outcome: RunOutcome,
    startedAt: number | undefined,
    finishedAt: number | undefined,
    error?: unknown,
    aborted?: JobAbortReason,
  ): JobRunResult {
    return Object.freeze({
      job: job.name,
      runId,
      trigger,
      scheduledAt: new Date(scheduledAt),
      startedAt: startedAt === undefined ? undefined : new Date(startedAt),
      finishedAt: finishedAt === undefined ? undefined : new Date(finishedAt),
      outcome,
      ...(error === undefined ? {} : { error }),
      ...(aborted === undefined ? {} : { aborted }),
    })
  }

  /**
   * The error of a failed run in the scheduler's log entry: the error itself (with its stack), or its
   * message when a `schedule:run` wrapper is installed (the observer logs the stack once).
   */
  #errorContext(error: unknown): { readonly err: unknown } | { readonly error: string } {
    return this.#services.hooks.hasWrappers('schedule:run') ? { error: errorMessage(error) } : { err: error }
  }

  #abort(run: RunRecord, reason: JobAbortReason): void {
    if (run.controller.signal.aborted) return
    run.aborted = reason
    if (run.event !== undefined) run.event.aborted = reason
    run.controller.abort(new JobAbortedError(run.job.name, run.runId, reason))
  }

  /**
   * Extends the lease every `ttl / 3`; aborts the run (`lock-lost`) once it is lost: `extend()`
   * answers `false`, or `ttl` elapsed since the last successful extension (counted from the call).
   * The deadline is a timer of its own, so an `extend()` that never answers (a partitioned store
   * client queuing commands) still loses the lease on time. A beat skips the store while the
   * previous extension is pending.
   */
  #heartbeat(run: RunRecord, lease: LockLease, lock: ResolvedLock, claimedAt: number): void {
    const { logger } = this.#services
    const ttl = lock.ttlMs
    let extending = false
    let lost = false
    const live = (): boolean => !lost && !run.settled && !run.abandoned
    const lose = (): void => {
      if (!live()) return
      lost = true
      this.#stopLease(run)
      logger.warn(`Schedule: run ${run.runId} of job '${run.job.name}' lost its lock: aborting it`, {
        job: run.job.name,
        runId: run.runId,
      })
      run.abort('lock-lost')
    }
    /** The lease is lost `ttl` after `since` (a successful claim or extension call). */
    const deadline = (since: number): void => {
      if (run.leaseDeadline !== undefined) this.clock.clearTimer(run.leaseDeadline)
      run.leaseDeadline = this.clock.setTimer(
        () => {
          run.leaseDeadline = undefined
          lose()
        },
        Math.max(0, since + ttl - this.clock.now()),
      )
    }
    const extend = async (): Promise<void> => {
      extending = true
      const calledAt = this.clock.now()
      let extended: boolean | undefined
      try {
        extended = await lease.extend(ttl)
      } catch (error) {
        if (live()) {
          logger.warn(`Schedule: extending the lock of job '${run.job.name}' failed, retrying`, {
            job: run.job.name,
            runId: run.runId,
            err: error,
          })
        }
      } finally {
        extending = false
      }
      if (!live()) return
      if (extended === true) deadline(calledAt)
      else if (extended === false) lose()
    }
    const beat = (): void => {
      run.heartbeat = this.clock.setTimer(
        () => {
          run.heartbeat = undefined
          if (!live()) return
          beat() // the next beat never waits for this extension
          if (!extending) void extend()
        },
        Math.max(1, Math.floor(ttl / 3)),
      )
    }
    deadline(claimedAt)
    beat()
  }

  #stopLease(run: RunRecord): void {
    if (run.heartbeat !== undefined) this.clock.clearTimer(run.heartbeat)
    if (run.leaseDeadline !== undefined) this.clock.clearTimer(run.leaseDeadline)
    run.heartbeat = undefined
    run.leaseDeadline = undefined
  }

  #stopTimers(run: RunRecord): void {
    if (run.timeout !== undefined) this.clock.clearTimer(run.timeout)
    run.timeout = undefined
    this.#stopLease(run)
  }

  /** Whether the runtime was disposed. */
  get disposed(): boolean {
    return this.#disposed
  }
}

/** Whitespace collapsed to single spaces (the generated metadata keeps expressions that way). */
export function normalizeCron(expression: string): string {
  return expression.trim().split(/\s+/).join(' ')
}

/** Human-readable schedule of a job. */
export function describeSchedule(schedule: JobSchedule): string {
  switch (schedule.kind) {
    case 'cron':
      return `${schedule.cron} (${schedule.timeZone})`
    case 'interval':
      return `every ${formatDuration(schedule.every)}`
    case 'timeout':
      return `once after ${formatDuration(schedule.delay)}`
  }
}

/** The public view of a job. */
class JobHandle implements ScheduledJob {
  readonly #job: JobRecord
  readonly #runtime: ScheduleRuntime

  constructor(job: JobRecord, runtime: ScheduleRuntime) {
    this.#job = job
    this.#runtime = runtime
  }

  get name(): string {
    return this.#job.name
  }

  get kind(): JobKind {
    return this.#job.kind
  }

  get origin(): 'decorator' | 'dynamic' {
    return this.#job.origin
  }

  get schedule(): string {
    return describeSchedule(this.#job.schedule)
  }

  get cron(): string | undefined {
    const schedule = this.#job.schedule
    return schedule.kind === 'cron' ? schedule.cron : undefined
  }

  get timeZone(): string | undefined {
    const schedule = this.#job.schedule
    return schedule.kind === 'cron' ? schedule.timeZone : undefined
  }

  get every(): number | undefined {
    const schedule = this.#job.schedule
    return schedule.kind === 'interval' ? schedule.every : undefined
  }

  get delay(): number | undefined {
    const schedule = this.#job.schedule
    return schedule.kind === 'timeout' ? schedule.delay : undefined
  }

  get overlap(): OverlapPolicy {
    return this.#job.overlap
  }

  get locked(): boolean {
    return this.#job.locked
  }

  get maxDuration(): number | undefined {
    return this.#job.maxDuration
  }

  get state(): JobState {
    return this.#job.state
  }

  get running(): number {
    return this.#job.running.size
  }

  get nextRun(): Date | undefined {
    const deadline = this.#job.deadline
    return deadline === undefined || this.#job.state !== 'scheduled' ? undefined : new Date(deadline)
  }

  get lastRun(): JobRunResult | undefined {
    return this.#job.lastRun
  }

  nextRuns(count: number, from?: Date): Date[] {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw invalid(`nextRuns(count): count must be a non-negative integer, got ${describe(count)}`)
    }
    const start = from === undefined ? this.#runtime.clock.now() : from.getTime()
    if (!Number.isFinite(start)) throw invalid('nextRuns(count, from): from must be a valid Date')
    return this.#runtime.nextRuns(this.#job, count, start).map(at => new Date(at))
  }

  pause(): void {
    this.#runtime.pause(this.#job)
  }

  resume(): void {
    this.#runtime.resume(this.#job)
  }

  reschedule(schedule: string | Duration, options?: { readonly timeZone?: string }): void {
    this.#runtime.reschedule(this.#job, schedule, options)
  }

  trigger(): Promise<JobRunResult> {
    return this.#runtime.trigger(this.#job)
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      kind: this.kind,
      origin: this.origin,
      schedule: this.schedule,
      state: this.state,
      running: this.running,
      nextRun: this.nextRun,
      lastRun: this.lastRun,
    }
  }
}

/** Waits for `promises` to settle, at most `ms` (real time). `true` when they all settled. */
function settleWithin(promises: readonly Promise<unknown>[], ms: number): Promise<boolean> {
  const all = Promise.allSettled(promises).then(() => true)
  if (ms === Number.POSITIVE_INFINITY) return all
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), Math.min(ms, MAX_DRAIN_MS))
    void all.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/**
 * Binary min-heap of deadlines, ties broken by job name. Indexed by job: one entry per job at most
 * (pushing replaces the job's entry), removed in O(log n), so cancelled occurrences of removed,
 * paused or rescheduled jobs are not retained until their old deadline.
 */
class DeadlineHeap {
  readonly #items: HeapEntry[] = []
  readonly #positions = new Map<JobRecord, number>()

  /** Arms `entry`, replacing the entry of its job. */
  push(entry: HeapEntry): void {
    this.delete(entry.job)
    this.#items.push(entry)
    this.#up(this.#items.length - 1)
  }

  /** Removes the entry of `job`, if any. */
  delete(job: JobRecord): void {
    const index = this.#positions.get(job)
    if (index !== undefined) this.#removeAt(index)
  }

  peek(): HeapEntry | undefined {
    return this.#items[0]
  }

  /** The top entry, dropping stale ones first. */
  peekValid(): HeapEntry | undefined {
    for (;;) {
      const top = this.#items[0]
      if (top === undefined) return undefined
      if (top.generation === top.job.generation && top.job.state === 'scheduled') return top
      this.pop()
    }
  }

  pop(): HeapEntry | undefined {
    const top = this.#items[0]
    if (top !== undefined) this.#removeAt(0)
    return top
  }

  clear(): void {
    this.#items.length = 0
    this.#positions.clear()
  }

  #removeAt(index: number): void {
    const items = this.#items
    this.#positions.delete((items[index] as HeapEntry).job)
    const last = items.pop() as HeapEntry
    if (index === items.length) return
    items[index] = last
    this.#positions.set(last.job, index)
    if (index > 0 && before(last, items[(index - 1) >> 1] as HeapEntry)) this.#up(index)
    else this.#down(index)
  }

  #up(start: number): void {
    const items = this.#items
    const entry = items[start] as HeapEntry
    let index = start
    while (index > 0) {
      const parent = (index - 1) >> 1
      const above = items[parent] as HeapEntry
      if (!before(entry, above)) break
      items[index] = above
      this.#positions.set(above.job, index)
      index = parent
    }
    items[index] = entry
    this.#positions.set(entry.job, index)
  }

  #down(start: number): void {
    const items = this.#items
    const entry = items[start] as HeapEntry
    let index = start
    for (;;) {
      const left = 2 * index + 1
      if (left >= items.length) break
      const right = left + 1
      const child = right < items.length && before(items[right] as HeapEntry, items[left] as HeapEntry) ? right : left
      const below = items[child] as HeapEntry
      if (!before(below, entry)) break
      items[index] = below
      this.#positions.set(below.job, index)
      index = child
    }
    items[index] = entry
    this.#positions.set(entry.job, index)
  }
}

function before(a: HeapEntry, b: HeapEntry): boolean {
  return a.deadline < b.deadline || (a.deadline === b.deadline && a.name < b.name)
}

function compare(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  try {
    return String(error)
  } catch {
    return 'unknown error'
  }
}
