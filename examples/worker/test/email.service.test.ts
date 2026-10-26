import { TestBed } from '@znight/testing'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { EmailRenderer } from '../src/emails/email.renderer.js'
import { EmailService } from '../src/emails/email.service.js'
import { SmtpClient } from '../src/emails/smtp.client.js'
import { SuppressionList } from '../src/emails/suppression.list.js'
import { JobContext } from '../src/messaging/job-context.js'
import { describe, expect, test as it } from 'bun:test'

// TestBed builds EmailService with its generated factory. Its direct dependencies are replaced by
// kind: SmtpClient (the @Provides value), SuppressionList and the lazy JobContext are auto-mocked,
// SmtpConfig (a @Config class) is a real instance, EmailRenderer is the real one (`provide`).
function createService() {
  return TestBed.create(EmailService, {
    metadata,
    config: { smtp: { from: 'Acme <hello@acme.test>' } }, // values of @Config('smtp')
    provide: [[EmailRenderer, new EmailRenderer()]],
  })
}

const welcome = { to: 'ada@example.com', template: 'welcome', locale: 'en', data: { name: 'Ada' } } as const

describe('EmailService', () => {
  it('renders the template and sends it from the configured sender', async () => {
    const { instance, mocks } = await createService()
    mocks.get(SmtpClient).send.mockResolvedValue({ messageId: '<job-1@worker.znight>', accepted: true })

    expect(await instance.send(welcome, 'job-1')).toBe('sent')

    expect(mocks.get(SmtpClient).send).toHaveBeenCalledWith({
      messageId: '<job-1@worker.znight>', // derived from the job id: the server deduplicates redeliveries
      from: 'Acme <hello@acme.test>',
      to: 'ada@example.com',
      subject: 'Welcome, Ada!',
      text: 'Hi Ada,\n\nYour account is ready.',
    })
    // Lazy<JobContext> resolves to the same auto-mock as mocks.get(JobContext)
    expect(mocks.get(JobContext).logger.info).toHaveBeenCalledWith('Email sent', {
      to: 'ada@example.com',
      template: 'welcome',
    })
  })

  it('reports a job the server already accepted as a duplicate', async () => {
    const { instance, mocks } = await createService()
    mocks.get(SmtpClient).send.mockResolvedValue({ messageId: '<job-1@worker.znight>', accepted: false })

    expect(await instance.send(welcome, 'job-1')).toBe('duplicate')
  })

  it('never emails a suppressed address', async () => {
    const { instance, mocks } = await createService()
    mocks.get(SuppressionList).has.mockReturnValue(true)

    expect(await instance.send(welcome, 'job-1')).toBe('suppressed')
    expect(mocks.get(SmtpClient).send).not.toHaveBeenCalled()
  })
})
