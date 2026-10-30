import type { TestApp } from '@znight/testing'

import { SchedulerRegistry } from '@znight/schedule'
import { createTestClock } from '@znight/schedule/testing'

import { OutboxMailer } from '../src/digest/outbox.mailer.js'
import { createTestApp, onlyJobs } from './support/app.js'
import { afterEach, describe, expect, test as it } from 'bun:test'

/**
 * The digest on its real schedule: the real plugin, the real job, the real outbox, on a virtual
 * clock. Time only moves when the test advances it, and `advance()` waits for the runs it starts.
 */
describe('digest.daily schedule', () => {
  let app: TestApp | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  async function queued(app: TestApp): Promise<{ key: string; text: string }[]> {
    return (await app.get(OutboxMailer).queued(10)).toReversed()
  }

  it('runs at 08:00 Paris time on weekdays, across the March 2027 DST switch', async () => {
    const clock = createTestClock('2027-03-26T06:00:00Z') // Friday 07:00 in Paris (CET, UTC+1)
    app = await createTestApp({ clock, jobs: onlyJobs('digest.daily') })

    await clock.advanceTo('2027-03-29T07:00:00Z') // Monday 09:00 in Paris (CEST, UTC+2)

    // Friday 08:00 CET (07:00Z), Monday 08:00 CEST (06:00Z), none on the weekend
    const mails = await queued(app)
    expect(mails.map(mail => mail.key)).toEqual([
      'digest.daily:2027-03-26T07:00:00.000Z',
      'digest.daily:2027-03-29T06:00:00.000Z',
    ])
    // Monday's digest covers the weekend: since the previous occurrence, not the last 24 hours
    expect(mails[1]?.text).toStartWith('Uptime from 2027-03-26T07:00:00.000Z to 2027-03-29T06:00:00.000Z')
    const digest = app.get(SchedulerRegistry).get('digest.daily')
    expect(digest?.lastRun).toMatchObject({ outcome: 'completed', trigger: 'schedule' })
    expect(digest?.nextRun?.toISOString()).toBe('2027-03-30T06:00:00.000Z')
  })

  it('takes its schedule from DIGEST_CRON when set, in the zone of the decorator', async () => {
    const clock = createTestClock('2027-03-26T06:00:00Z')
    app = await createTestApp({ clock, jobs: onlyJobs('digest.daily'), env: { DIGEST_CRON: '0 18 * * FRI' } })

    const digest = app.get(SchedulerRegistry).get('digest.daily')
    expect(digest?.schedule).toBe('0 18 * * FRI (Europe/Paris)')
    await clock.advanceTo('2027-04-03T00:00:00Z') // a week later

    expect((await queued(app)).map(mail => mail.key)).toEqual([
      'digest.daily:2027-03-26T17:00:00.000Z', // Friday 18:00 CET
      'digest.daily:2027-04-02T16:00:00.000Z', // Friday 18:00 CEST
    ])
  })

  it('refuses to boot with an invalid DIGEST_CRON, like the build refuses an invalid decorator', async () => {
    const created = createTestApp({ clock: createTestClock(), env: { DIGEST_CRON: '0 25 * * *' } })

    await expect(created).rejects.toMatchObject({ code: 'ZNIGHT040' })
    await expect(created).rejects.toThrow('hour 25 is out of range (0-23)')
  })
})
