import { formatDuration } from '../src/duration.ts'
import { closest, editDistance, isJobName } from '../src/names.ts'
import { describe, expect, test as it } from 'bun:test'

describe('job names', () => {
  it.each(['digest.daily', 'OutboxJobs.flush', 'monitor.42', 'a', '$job', 'ns:job-1', 'x'.repeat(128)])(
    '%p is valid',
    name => {
      expect(isJobName(name)).toBe(true)
    },
  )

  it.each(['', '.job', '-job', 'has space', 'é', 'x'.repeat(129), 42])('%p is invalid', name => {
    expect(isJobName(name)).toBe(false)
  })
})

describe('suggestions', () => {
  it('finds typos and case differences', () => {
    expect(closest('timezone', ['name', 'timeZone', 'overlap'])).toBe('timeZone')
    expect(closest('Europe/Pari', ['Europe/Paris', 'Europe/Prague'])).toBe('Europe/Paris')
    expect(closest('maxDuraton', ['maxDuration'])).toBe('maxDuration')
    expect(closest('zzz', ['name', 'lock'])).toBeUndefined()
    expect(editDistance('kitten', 'sitting')).toBe(3)
  })
})

describe('formatDuration', () => {
  it.each([
    [500, '500ms'],
    [1000, '1s'],
    [90_000, '1.5m'],
    [60_000, '1m'],
    [5_400_000, '1.5h'],
    [86_400_000, '1d'],
    [1234, '1234ms'],
    [0, '0ms'],
  ])('%p → %p', (ms, text) => {
    expect(formatDuration(ms)).toBe(text)
  })
})
