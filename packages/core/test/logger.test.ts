import { type ConsoleLike, createConsoleLogger, DelegatingLogger, silentLogger } from '../src/index.ts'
import { memoryLogger } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

function fakeConsole(): ConsoleLike & { readonly lines: unknown[][] } {
  const lines: unknown[][] = []
  const write =
    (level: string) =>
    (...args: unknown[]): void => {
      lines.push([level, ...args])
    }
  return { lines, debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') }
}

describe('createConsoleLogger', () => {
  it('writes entries at or above the level, with prefix and context', () => {
    const out = fakeConsole()
    const logger = createConsoleLogger({ console: out, level: 'info' })
    logger.debug('hidden')
    logger.info('started', { port: 3000 })
    logger.warn('careful', {})
    logger.error('failed')
    expect(out.lines).toEqual([
      ['info', '[znight] started', { port: 3000 }],
      ['warn', '[znight] careful'],
      ['error', '[znight] failed'],
    ])
  })

  it('supports custom prefixes, debug and silent levels', () => {
    const out = fakeConsole()
    createConsoleLogger({ console: out, level: 'debug', prefix: '' }).debug('visible')
    createConsoleLogger({ console: out, level: 'silent' }).error('hidden')
    createConsoleLogger({ console: out, prefix: '[app]' }).info('x')
    expect(out.lines).toEqual([
      ['debug', 'visible'],
      ['info', '[app] x'],
    ])
  })
})

describe('silentLogger', () => {
  it('accepts every call', () => {
    expect(() => {
      silentLogger.debug('a')
      silentLogger.info('b')
      silentLogger.warn('c')
      silentLogger.error('d', { err: new Error('x') })
    }).not.toThrow()
  })
})

describe('DelegatingLogger', () => {
  it('forwards to the current target and can be retargeted', () => {
    const first = memoryLogger()
    const second = memoryLogger()
    const logger = new DelegatingLogger(first)
    logger.info('one')
    logger.setTarget(second)
    logger.debug('two', { a: 1 })
    logger.warn('three')
    logger.error('four')
    expect(first.entries.map(entry => entry.message)).toEqual(['one'])
    expect(second.entries.map(entry => `${entry.level}:${entry.message}`)).toEqual([
      'debug:two',
      'warn:three',
      'error:four',
    ])
    expect(logger.target).toBe(second)
  })

  it('ignores itself as a target (no infinite recursion)', () => {
    const target = memoryLogger()
    const logger = new DelegatingLogger(target)
    logger.setTarget(logger)
    logger.info('ok')
    expect(target.entries).toHaveLength(1)
  })
})
