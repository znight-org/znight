import {
  type HookEvent,
  Hooks,
  type ScheduledRunAbortReason,
  type ScheduledRunEvent,
  type ScheduledRunOutcome,
  type ScheduledRunTrigger,
} from '../src/index.ts'
import { caught, memoryLogger, sleep } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

interface RequestEvent {
  path: string
  status?: number
  trail: string[]
}

declare module '../src/index.ts' {
  interface ZnightHooks {
    'test:request': RequestEvent
    'test:ping': { readonly count: number }
  }
}

const event = (): RequestEvent => ({ path: '/users', trail: [] })

describe('Hooks.on / emit', () => {
  it('calls listeners synchronously in registration order', () => {
    const hooks = new Hooks()
    const seen: string[] = []
    hooks.on('test:ping', e => seen.push(`a${e.count}`))
    hooks.on('test:ping', e => seen.push(`b${e.count}`))
    hooks.emit('test:ping', { count: 1 })
    expect(seen).toEqual(['a1', 'b1'])
  })

  it('does nothing without listeners', () => {
    const hooks = new Hooks()
    expect(() => hooks.emit('test:ping', { count: 1 })).not.toThrow()
    expect(hooks.hasListeners('test:ping')).toBe(false)
  })

  it('returns an idempotent unsubscribe function', () => {
    const hooks = new Hooks()
    const seen: number[] = []
    const listener = (e: { count: number }) => seen.push(e.count)
    const off1 = hooks.on('test:ping', listener)
    hooks.on('test:ping', listener)
    off1()
    off1()
    hooks.emit('test:ping', { count: 1 })
    expect(seen).toEqual([1])
    expect(hooks.hasListeners('test:ping')).toBe(true)
  })

  it('isolates failing listeners and reports them to the logger', async () => {
    const logger = memoryLogger()
    const hooks = new Hooks({ logger })
    const seen: string[] = []
    hooks.on('test:ping', () => {
      throw new Error('sync failure')
    })
    hooks.on('test:ping', async () => {
      await sleep(1)
      throw new Error('async failure')
    })
    hooks.on('test:ping', () => {
      seen.push('third')
    })
    hooks.emit('test:ping', { count: 1 })
    expect(seen).toEqual(['third'])
    await sleep(10)
    expect(logger.entries.map(entry => (entry.context?.['err'] as Error | undefined)?.message)).toEqual([
      'sync failure',
      'async failure',
    ])
    expect(logger.entries[0]?.level).toBe('error')
    expect(logger.entries[0]?.context?.['hook']).toBe('test:ping')
  })

  it('does not call listeners added during an emit until the next one', () => {
    const hooks = new Hooks()
    const seen: string[] = []
    hooks.on('test:ping', () => {
      seen.push('first')
      hooks.on('test:ping', () => seen.push('late'))
    })
    hooks.emit('test:ping', { count: 1 })
    expect(seen).toEqual(['first'])
  })
})

describe('Hooks.wrap / run', () => {
  it('runs fn directly without wrappers', async () => {
    const hooks = new Hooks()
    expect(await hooks.run('test:request', event(), async () => 'result')).toBe('result')
    expect(hooks.hasWrappers('test:request')).toBe(false)
  })

  it('composes wrappers onion-style, first registered outermost', async () => {
    const hooks = new Hooks()
    const e = event()
    hooks.wrap('test:request', async (ev, next) => {
      ev.trail.push('outer:in')
      const value = await next()
      ev.trail.push(`outer:out(${String(value)})`)
      return 'ignored'
    })
    hooks.wrap('test:request', async (ev, next) => {
      ev.trail.push('inner:in')
      await next()
      ev.trail.push('inner:out')
    })
    const result = await hooks.run('test:request', e, () => {
      e.trail.push('fn')
      return Promise.resolve('value')
    })
    expect(result).toBe('value')
    expect(e.trail).toEqual(['outer:in', 'inner:in', 'fn', 'inner:out', 'outer:out(value)'])
  })

  it('lets wrappers observe and handle errors', async () => {
    const hooks = new Hooks()
    const e = event()
    hooks.wrap('test:request', async (ev, next) => {
      try {
        return await next()
      } catch (error) {
        ev.status = 500
        throw error
      }
    })
    const error = await caught(() => hooks.run('test:request', e, () => Promise.reject(new Error('handler failed'))))
    expect((error as Error).message).toBe('handler failed')
    expect(e.status).toBe(500)
  })

  it('resolves undefined when a wrapper short-circuits', async () => {
    const hooks = new Hooks()
    let ran = false
    hooks.wrap('test:request', ev => {
      ev.status = 429
      return Promise.resolve()
    })
    const result = await hooks.run('test:request', event(), () => {
      ran = true
      return Promise.resolve('value')
    })
    expect(result).toBeUndefined()
    expect(ran).toBe(false)
  })

  it('turns synchronous throws into rejections', async () => {
    const hooks = new Hooks()
    const direct = hooks.run('test:request', event(), (() => {
      throw new Error('sync fn')
    }) as () => Promise<never>)
    expect(((await caught(() => direct)) as Error).message).toBe('sync fn')
    hooks.wrap('test:request', (() => {
      throw new Error('sync wrapper')
    }) as never)
    expect(((await caught(() => hooks.run('test:request', event(), async () => 1))) as Error).message).toBe(
      'sync wrapper',
    )
  })

  it('removes wrappers', async () => {
    const hooks = new Hooks()
    const e = event()
    const off = hooks.wrap('test:request', (ev, next) => {
      ev.trail.push('wrapper')
      return next()
    })
    off()
    off()
    await hooks.run('test:request', e, async () => 1)
    expect(e.trail).toEqual([])
  })
})

describe('schedule:run', () => {
  /** What @znight/schedule does for an executed run: wrappers around the job, then listeners. */
  async function run(hooks: Hooks, job: () => Promise<void>): Promise<ScheduledRunEvent> {
    const event: ScheduledRunEvent = {
      job: 'digest.daily',
      kind: 'cron',
      host: 'DigestJobs',
      method: 'sendDaily',
      runId: 'r-1',
      trigger: 'schedule',
      scheduledAt: Date.UTC(2027, 2, 29, 6),
      context: { job: 'digest.daily' },
      startTime: performance.now(),
    }
    try {
      await hooks.run('schedule:run', event, async () => {
        try {
          await job()
        } catch (error) {
          event.outcome = 'failed'
          event.error = error
          throw error
        }
        event.outcome = 'completed'
      })
    } catch (error) {
      // a wrapper failed before the job
      if (event.outcome === undefined) {
        event.outcome = 'failed'
        event.error = error
      }
    }
    event.outcome ??= 'skipped' // a wrapper did not call next()
    hooks.emit('schedule:run', event)
    return event
  }

  it('is a declared hook: wrappers see the run, listeners its outcome', async () => {
    const hooks = new Hooks()
    const wrapped: string[] = []
    const settled: (ScheduledRunOutcome | undefined)[] = []
    hooks.wrap('schedule:run', (event, next) => {
      wrapped.push(`${event.job}@${event.trigger}`)
      return next()
    })
    hooks.on('schedule:run', event => settled.push(event.outcome))
    await run(hooks, () => Promise.resolve())
    const failed = await run(hooks, () => Promise.reject(new Error('smtp down')))
    expect(wrapped).toEqual(['digest.daily@schedule', 'digest.daily@schedule'])
    expect(settled).toEqual(['completed', 'failed'])
    expect((failed.error as Error).message).toBe('smtp down')
  })

  it('a wrapper that does not call next() vetoes the run (outcome skipped)', async () => {
    const hooks = new Hooks()
    hooks.wrap('schedule:run', () => Promise.resolve(undefined)) // maintenance window
    let ran = false
    const event = await run(hooks, () => {
      ran = true
      return Promise.resolve()
    })
    expect(ran).toBe(false)
    expect(event.outcome).toBe('skipped')
  })

  it('wrappers see no outcome when the job did not start (veto, a wrapper that threw first)', async () => {
    /** An outer wrapper reporting the outcome as the JSDoc of `ScheduledRunEvent.outcome` says. */
    const observe = (hooks: Hooks, seen: string[]): void => {
      hooks.wrap('schedule:run', async (event, next) => {
        let rejected = false
        try {
          await next()
        } catch (error) {
          rejected = true
          throw error // swallowing it would turn the failure into a veto
        } finally {
          seen.push(`${String(event.outcome)} → ${event.outcome ?? (rejected ? 'failed' : 'skipped')}`)
        }
      })
    }
    const job = () => Promise.resolve()
    const seen: string[] = []
    const vetoing = new Hooks()
    observe(vetoing, seen)
    vetoing.wrap('schedule:run', () => Promise.resolve(undefined)) // maintenance window
    const throwing = new Hooks()
    observe(throwing, seen)
    throwing.wrap('schedule:run', () => Promise.reject(new Error('tracer down')))
    const failing = new Hooks()
    observe(failing, seen)
    const plain = new Hooks()
    observe(plain, seen)
    expect((await run(vetoing, job)).outcome).toBe('skipped')
    const thrown = await run(throwing, job)
    const failed = await run(failing, () => Promise.reject(new Error('smtp down')))
    expect((await run(plain, job)).outcome).toBe('completed')
    expect(seen).toEqual(['undefined → skipped', 'undefined → failed', 'failed → failed', 'completed → completed'])
    // the producer settles what the wrappers could not see: listeners get the final outcome
    expect(thrown.outcome).toBe('failed')
    expect((thrown.error as Error).message).toBe('tracer down')
    expect((failed.error as Error).message).toBe('smtp down')
  })

  it('types the abort reasons, triggers and outcomes', () => {
    const reasons: readonly ScheduledRunAbortReason[] = ['timeout', 'lock-lost', 'removed', 'shutdown']
    const triggers: readonly ScheduledRunTrigger[] = ['schedule', 'start', 'manual', 'queued']
    const outcomes: readonly ScheduledRunOutcome[] = ['completed', 'failed', 'skipped', 'not-acquired']
    const event: HookEvent<'schedule:run'> = {
      job: 'cache.refresh',
      kind: 'interval',
      host: undefined,
      method: undefined,
      runId: 'r-2',
      trigger: 'manual',
      scheduledAt: 0,
      context: undefined,
      startTime: 0,
      outcome: 'not-acquired',
      aborted: 'lock-lost',
    }
    expect([reasons.length, triggers.length, outcomes.length]).toEqual([4, 4, 4])
    expect(event.aborted).toBe('lock-lost')
  })
})
