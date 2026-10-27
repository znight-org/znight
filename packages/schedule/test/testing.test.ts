/**
 * `@znight/schedule/testing` (RFC 0004 §4.8): the virtual clock and job contexts for unit tests.
 */
import { readFile } from 'node:fs/promises'

import { JobAbortedError } from '../src/index.ts'
import { createJobContext, createTestClock } from '../src/testing/index.ts'
import { aborted, boot, metadataWith } from './helpers.ts'
import { describe, expect, test as it } from 'bun:test'

/** Real I/O of a job: the file system, then a real timer (a database round trip...). */
async function realIo(ms: number): Promise<void> {
  await readFile(import.meta.path)
  await new Promise(resolve => setTimeout(resolve, ms))
  await readFile(import.meta.path)
}

describe('createTestClock', () => {
  it('starts at the given date (default 2026-01-01T00:00:00Z) and only moves when advanced', async () => {
    expect(createTestClock().date.toISOString()).toBe('2026-01-01T00:00:00.000Z')
    const clock = createTestClock(new Date('2027-03-26T06:00:00Z'))
    expect(clock.now()).toBe(Date.parse('2027-03-26T06:00:00Z'))
    await clock.advance('1.5h')
    expect(clock.date.toISOString()).toBe('2027-03-26T07:30:00.000Z')
    await clock.advanceTo('2027-03-29T07:00:00Z')
    expect(clock.date.toISOString()).toBe('2027-03-29T07:00:00.000Z')
    expect(createTestClock(0).now()).toBe(0)
  })

  it('fires due timers in order (ties in arming order), at their own time', async () => {
    const clock = createTestClock('2026-01-01T00:00:00Z')
    const fired: string[] = []
    clock.setTimer(() => fired.push(`b@${clock.date.toISOString().slice(11, 19)}`), 2000)
    clock.setTimer(() => fired.push(`a@${clock.date.toISOString().slice(11, 19)}`), 1000)
    clock.setTimer(() => fired.push(`c@${clock.date.toISOString().slice(11, 19)}`), 2000)
    const cancelled = clock.setTimer(() => fired.push('cancelled'), 1500)
    clock.clearTimer(cancelled)
    clock.clearTimer(cancelled)
    expect(clock.pendingTimers).toBe(3)
    await clock.advance('1999ms')
    expect(fired).toEqual(['a@00:00:01'])
    await clock.advance(1)
    expect(fired).toEqual(['a@00:00:01', 'b@00:00:02', 'c@00:00:02'])
    expect(clock.pendingTimers).toBe(0)
  })

  it('waits for the runs it tracks, and stops waiting for runs that wait for the clock', async () => {
    const clock = createTestClock()
    let done = false
    clock.setTimer(() => {
      clock.track(
        (async () => {
          await Promise.resolve()
          await new Promise(resolve => setImmediate(resolve))
          done = true
        })(),
      )
    }, 10)
    await clock.advance(10)
    expect(done).toBe(true)
    const quick = createTestClock(0, { settleTimeoutMs: 30 })
    quick.track(new Promise(() => undefined)) // never settles
    const started = performance.now()
    await quick.settle()
    expect(performance.now() - started).toBeGreaterThanOrEqual(29)
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('waits for runs doing real I/O (no sleep needed in tests)', async () => {
    const clock = createTestClock('2026-01-01T00:00:00Z')
    const completed: string[] = []
    await using booted = await boot({
      clock,
      metadata: metadataWith([
        {
          name: 'sync',
          kind: 'cron',
          cron: '* * * * *',
          run: async ctx => {
            await realIo(25)
            completed.push(ctx.scheduledAt.toISOString().slice(11, 16))
          },
        },
      ]),
    })
    await clock.advance('1m')
    expect(completed).toEqual(['00:01'])
    // the run of each occurrence settles before the next one fires: none is skipped by overlap
    await clock.advance('4m')
    expect(completed).toEqual(['00:01', '00:02', '00:03', '00:04', '00:05'])
    expect(booted.logs.messages('warn')).toEqual([])
  })

  it('gives up on runs idle for settleTimeoutMs (waiting for a later timer or for the test)', async () => {
    const clock = createTestClock('2026-01-01T00:00:00Z', { settleTimeoutMs: 50 })
    let reason: unknown
    await using booted = await boot({
      clock,
      metadata: metadataWith([
        {
          name: 'bounded',
          kind: 'cron',
          cron: '* * * * *',
          maxDuration: 30_000,
          run: async ctx => {
            reason = await aborted(ctx.signal)
          },
        },
      ]),
    })
    const started = performance.now()
    await clock.advance('90s') // waits 50 ms for the run, then fires its maxDuration timer
    expect(reason).toMatchObject({ reason: 'timeout' })
    expect(performance.now() - started).toBeLessThan(1000)
    expect(booted.registry.get('bounded')?.running).toBe(0)
    expect(() => createTestClock(0, { settleTimeoutMs: -1 })).toThrow('settleTimeoutMs must be')
  })

  it('moves the wall clock without firing timers (clock jumps)', async () => {
    const clock = createTestClock('2026-01-01T00:00:00Z')
    let firedAt: string | undefined
    clock.setTimer(() => {
      firedAt = clock.date.toISOString()
    }, 60_000)
    clock.setWallClock('2026-01-01T05:00:00Z')
    expect(firedAt).toBeUndefined()
    await clock.advance('1m')
    expect(firedAt).toBe('2026-01-01T05:01:00.000Z')
  })

  it('refuses to go backwards and invalid inputs', async () => {
    const clock = createTestClock('2026-01-01T00:00:00Z')
    await expect(clock.advanceTo('2025-12-31T00:00:00Z')).rejects.toThrow('use setWallClock()')
    await expect(clock.advance('5 min' as never)).rejects.toThrow("use '5m'")
    await expect(clock.advanceTo('not a date')).rejects.toThrow('invalid date')
    expect(() => createTestClock('nope')).toThrow('invalid date')
  })
})

describe('createJobContext', () => {
  it('builds a context with defaults and an abort helper', () => {
    const before = Date.now()
    const ctx = createJobContext()
    expect(ctx).toMatchObject({ job: 'test-job', trigger: 'manual', previous: undefined })
    expect(ctx.runId).toMatch(/^[0-9a-f-]{36}$/)
    expect(ctx.scheduledAt.getTime()).toBeGreaterThanOrEqual(before)
    expect(ctx.startedAt).toBe(ctx.scheduledAt)
    expect(ctx.signal.aborted).toBe(false)
    ctx.abort()
    ctx.abort('timeout')
    expect(ctx.signal.reason).toBeInstanceOf(JobAbortedError)
    expect(ctx.signal.reason).toMatchObject({ reason: 'shutdown', job: 'test-job', code: 'ZNIGHT044' })
  })

  it('takes the fields of the run', () => {
    const scheduledAt = new Date('2027-03-26T07:00:00Z')
    const ctx = createJobContext({
      job: 'digest.daily',
      runId: 'run-1',
      trigger: 'schedule',
      scheduledAt,
      startedAt: new Date('2027-03-26T07:00:01Z'),
      previous: { scheduledAt: new Date('2027-03-25T07:00:00Z'), outcome: 'completed' },
    })
    expect(ctx).toMatchObject({ job: 'digest.daily', runId: 'run-1', trigger: 'schedule', scheduledAt })
    ctx.abort('timeout')
    expect(ctx.signal.reason).toMatchObject({ reason: 'timeout', runId: 'run-1' })
  })
})
