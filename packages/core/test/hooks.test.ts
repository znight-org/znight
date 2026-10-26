import { Hooks } from '../src/index.ts'
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
