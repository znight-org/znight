import { Hooks, silentLogger } from '@znight/core'

import { Logger, logHttpRequests, logMessages, MetricsRegistry, measureHttpRequests } from '../src/index.ts'
import { guard } from '../src/internal/safe.ts'
import { caught, httpEvent, messageEvent } from './helpers.ts'
import { afterAll, afterEach, describe, expect, it, spyOn } from 'bun:test'

describe('instrumentation never changes the outcome', () => {
  const warning = spyOn(process, 'emitWarning').mockImplementation(() => undefined)
  afterEach(() => warning.mockClear())
  afterAll(() => warning.mockRestore())

  it('keeps requests working when the log destination throws (reported once)', async () => {
    const broken = new Logger({
      destination: {
        write: () => {
          throw new Error('disk full')
        },
      },
    })
    const hooks = new Hooks({ logger: silentLogger })
    hooks.wrap('http:request', logHttpRequests(broken))
    hooks.wrap('messaging:message', logMessages(broken))
    expect(await hooks.run('http:request', httpEvent({ status: 200 }), async () => 'first')).toBe('first')
    expect(await hooks.run('http:request', httpEvent({ status: 200 }), async () => 'second')).toBe('second')
    const error = await caught(() => hooks.run('http:request', httpEvent(), () => Promise.reject(new Error('own'))))
    expect((error as Error).message).toBe('own')
    expect(await hooks.run('messaging:message', messageEvent(), async () => 'message')).toBe('message')
    expect(warning).toHaveBeenCalledTimes(2)
    expect(String(warning.mock.calls[0]?.[0])).toContain('Logging an HTTP request failed: disk full')
  })

  it('keeps requests working when recording metrics fails', async () => {
    const metrics = new MetricsRegistry({ defaultMetrics: false })
    const hooks = new Hooks({ logger: silentLogger })
    hooks.wrap('http:request', measureHttpRequests(metrics))
    const histogram = metrics.histogram('http_server_request_duration_seconds', {
      labelNames: ['method', 'route', 'status'],
    })
    histogram.observe = () => {
      throw new Error('collector broken')
    }
    expect(await hooks.run('http:request', httpEvent({ status: 200 }), async () => 'ok')).toBe('ok')
    expect(warning).toHaveBeenCalledTimes(1)
  })

  it('guard reports the first failure only', () => {
    const record = guard('Step')
    record(() => {
      throw new Error('one')
    })
    record(() => {
      throw new Error('two')
    })
    record(() => undefined)
    expect(warning).toHaveBeenCalledTimes(1)
    expect(warning.mock.calls[0]?.[0]).toBe('Step failed: one (further failures are not reported)')
  })

  it('names the LOG_LEVEL variable when it is invalid', () => {
    const saved = process.env['LOG_LEVEL']
    process.env['LOG_LEVEL'] = 'chatty'
    try {
      expect(() => new Logger({ destination: { write: () => undefined } })).toThrow(
        /Invalid LOG_LEVEL environment variable/,
      )
      expect(new Logger({ level: 'warn', destination: { write: () => undefined } }).level).toBe('warn')
    } finally {
      if (saved === undefined) delete process.env['LOG_LEVEL']
      else process.env['LOG_LEVEL'] = saved
    }
  })
})
