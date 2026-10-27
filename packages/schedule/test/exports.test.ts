import * as compiler from '../src/compiler/index.ts'
import * as entry from '../src/index.ts'
import * as testing from '../src/testing/index.ts'
import { expect, test as it } from 'bun:test'

it('exports the public runtime API', () => {
  expect(Object.keys(entry).sort()).toEqual([
    'Cron',
    'Interval',
    'InvalidScheduleError',
    'JOB_NAME_PATTERN',
    'JobAbortedError',
    'MAX_DURATION_MS',
    'MAX_TIMER_DELAY',
    'SCHEDULE_PLUGIN_NAME',
    'SchedulePlugin',
    'ScheduleTokens',
    'SchedulerRegistry',
    'Timeout',
    'formatDuration',
    'isJobName',
    'memoryLockStore',
    'parseCron',
    'parseDuration',
    'systemClock',
  ])
})

it('exports the testing utilities and the compiler extension', () => {
  expect(Object.keys(testing).sort()).toEqual(['createJobContext', 'createTestClock', 'lockStoreScenarios'])
  expect(compiler.default).toBe(compiler.scheduleCompilerExtension)
  expect(compiler.default).toMatchObject({ apiVersion: 1, name: 'schedule' })
  expect(Object.keys(compiler.default.decorators).sort()).toEqual([
    '@znight/schedule#Cron',
    '@znight/schedule#Interval',
    '@znight/schedule#Timeout',
  ])
})

it('decorators are no-op markers', () => {
  const marker = entry.Cron('@daily')
  expect(entry.Interval('1m')).toBe(marker)
  expect(entry.Timeout(0)).toBe(marker)
  expect(marker({}, 'method')).toBeUndefined()
})
