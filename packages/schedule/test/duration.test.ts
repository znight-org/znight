/**
 * Durations rejected from user input (RFC 0004 §4.2): the error hint must stay linear in the input.
 */
import { checkDuration } from '../src/duration.ts'
import { InvalidScheduleError, parseDuration } from '../src/index.ts'
import { describe, expect, test as it } from 'bun:test'

describe('invalid durations', () => {
  // The hint used to run a regex with two `\s*` around an optional `[A-Za-z]*`: quadratic.
  it.each([`1${' '.repeat(100_000)}x!`, `${' '.repeat(100_000)}1x!`, `${'1'.repeat(100_000)} x!`])(
    'rejects long garbage in linear time',
    value => {
      const started = performance.now()
      const result = checkDuration(value)
      expect(performance.now() - started).toBeLessThan(200)
      expect(result.ok).toBe(false)
    },
    30_000,
  )

  it('throws InvalidScheduleError without echoing the whole input', () => {
    let thrown: unknown
    try {
      parseDuration(`5${' '.repeat(10_000)}min!`)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(InvalidScheduleError)
    expect((thrown as Error).message.length).toBeLessThan(300)
  })

  it.each([
    [' 5 min ', "' 5 min ' is not a duration: use '5m' (ms, s, m, h, d)"],
    ['5\tsec', "is not a duration: use '5s'"],
    ['1.5 hours', "'1.5 hours' is not a duration: use '1.5h' (ms, s, m, h, d)"],
  ])('keeps its hints for %p', (value, message) => {
    expect(() => parseDuration(value)).toThrow(message)
  })
})
