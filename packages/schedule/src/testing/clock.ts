import type { ScheduleClock } from '../clock.ts'
import type { Duration } from '../duration.ts'

import { checkDuration } from '../duration.ts'

/** A virtual clock: time only moves when the test advances it. */
export interface TestClock extends ScheduleClock {
  /** The current time. */
  readonly date: Date
  /** Timers armed and not fired yet. */
  readonly pendingTimers: number
  /** Receives the runs the scheduler starts: {@link advance} and {@link settle} wait for them. */
  track(run: Promise<unknown>): void
  /**
   * Moves time forward by `duration`, firing the due timers in order. After each timer, and at the
   * end, it waits until the runs it started settle (or stop making progress: a run waiting for a later
   * timer, such as its `maxDuration`), so assertions need no sleep.
   */
  advance(duration: Duration): Promise<void>
  /** {@link advance} up to `date` (an ISO string, a `Date` or epoch milliseconds). Never backwards. */
  advanceTo(date: Date | string | number): Promise<void>
  /**
   * Sets the wall clock without firing anything (an NTP step, a suspended laptop, a manual change):
   * armed timers keep their remaining delays, as monotonic timers do.
   */
  setWallClock(date: Date | string | number): void
  /** Waits until the tracked runs settle or stop making progress. */
  settle(): Promise<void>
}

/** Event loop turns without a run settling after which {@link TestClock.settle} gives up waiting. */
const IDLE_TURNS = 50

interface VirtualTimer {
  readonly due: number
  readonly sequence: number
  readonly fn: () => void
  active: boolean
}

/**
 * Creates a virtual clock starting at `start` (default `2026-01-01T00:00:00Z`), to pass to
 * `SchedulePlugin.configure({ clock })` (and `memoryLockStore({ clock })`).
 *
 * ```ts
 * const clock = createTestClock('2027-03-26T06:00:00Z')
 * await using app = await TestApp.create({ metadata, plugins: [SchedulePlugin.configure({ clock })] })
 * await clock.advanceTo('2027-03-29T07:00:00Z')
 * ```
 */
export function createTestClock(start: Date | string | number = '2026-01-01T00:00:00Z'): TestClock {
  return new VirtualClock(toInstant(start, 'createTestClock()'))
}

class VirtualClock implements TestClock {
  #wall: number
  /** Monotonic time: timers fire on it. */
  #monotonic = 0
  #sequence = 0
  #timers: VirtualTimer[] = []
  readonly #runs = new Set<Promise<unknown>>()
  #settled = 0

  constructor(start: number) {
    this.#wall = start
  }

  get date(): Date {
    return new Date(this.#wall)
  }

  get pendingTimers(): number {
    return this.#timers.length
  }

  now(): number {
    return this.#wall
  }

  setTimer(fn: () => void, ms: number): unknown {
    const delay = Number.isFinite(ms) && ms > 0 ? ms : 0
    const timer: VirtualTimer = { due: this.#monotonic + delay, sequence: this.#sequence++, fn, active: true }
    this.#timers.push(timer)
    return timer
  }

  clearTimer(handle: unknown): void {
    const timer = handle as VirtualTimer | undefined
    if (timer === undefined || timer === null || !timer.active) return
    timer.active = false
    this.#timers = this.#timers.filter(entry => entry !== timer)
  }

  track(run: Promise<unknown>): void {
    this.#runs.add(run)
    const done = (): void => {
      this.#runs.delete(run)
      this.#settled++
    }
    run.then(done, done)
  }

  advance(duration: Duration): Promise<void> {
    const result = checkDuration(duration)
    if (!result.ok) return Promise.reject(new RangeError(`[znight] TestClock.advance(): ${result.message}`))
    return this.#advance(this.#monotonic + result.ms)
  }

  advanceTo(date: Date | string | number): Promise<void> {
    try {
      const target = toInstant(date, 'TestClock.advanceTo()')
      if (target < this.#wall) {
        throw new RangeError(
          `[znight] TestClock.advanceTo(): ${new Date(target).toISOString()} is before the current time ${this.date.toISOString()} (use setWallClock() to move the wall clock back)`,
        )
      }
      return this.#advance(this.#monotonic + (target - this.#wall))
    } catch (error) {
      return Promise.reject(error)
    }
  }

  setWallClock(date: Date | string | number): void {
    this.#wall = toInstant(date, 'TestClock.setWallClock()')
  }

  async settle(): Promise<void> {
    // one turn even without runs: timers may have started async work (lease extensions...)
    await nextTurn()
    let idle = 0
    while (this.#runs.size > 0 && idle < IDLE_TURNS) {
      const settled = this.#settled
      await Promise.race([Promise.allSettled([...this.#runs]), nextTurn()])
      idle = this.#settled === settled ? idle + 1 : 0
    }
  }

  async #advance(target: number): Promise<void> {
    await this.settle()
    for (;;) {
      const timer = this.#earliest(target)
      if (timer === undefined) break
      this.#wall += timer.due - this.#monotonic
      this.#monotonic = timer.due
      this.clearTimer(timer)
      timer.fn()
      await this.settle()
    }
    this.#wall += target - this.#monotonic
    this.#monotonic = target
    await this.settle()
  }

  #earliest(target: number): VirtualTimer | undefined {
    let found: VirtualTimer | undefined
    for (const timer of this.#timers) {
      if (timer.due > target) continue
      if (
        found === undefined ||
        timer.due < found.due ||
        (timer.due === found.due && timer.sequence < found.sequence)
      ) {
        found = timer
      }
    }
    return found
  }
}

function nextTurn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

function toInstant(value: Date | string | number, where: string): number {
  let time: unknown = value
  if (value instanceof Date) time = value.getTime()
  else if (typeof value === 'string') time = Date.parse(value)
  if (typeof time !== 'number' || !Number.isFinite(time)) {
    throw new RangeError(`[znight] ${where}: invalid date ${String(value)}`)
  }
  return time
}
