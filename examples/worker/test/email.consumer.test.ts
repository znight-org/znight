import { NonRetryableError } from '@znight/messaging'
import { TestBed } from '@znight/testing'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { EmailConsumer } from '../src/emails/email.consumer.js'
import { EmailService } from '../src/emails/email.service.js'
import { RecipientRejectedError, SmtpUnavailableError } from '../src/emails/smtp.client.js'
import { SuppressionList } from '../src/emails/suppression.list.js'
import { inboundMessage } from './support.js'
import { describe, expect, test as it } from 'bun:test'

describe('EmailConsumer', () => {
  it('sends the email of the job, identified by the message id', async () => {
    const { instance, mocks } = await TestBed.create(EmailConsumer, { metadata })
    const job = { to: 'ada@example.com', template: 'welcome', locale: 'en', data: { name: 'Ada' } } as const

    await instance.send(job, inboundMessage({ id: 'job-42' }))

    expect(mocks.get(EmailService).send).toHaveBeenCalledWith(job, 'job-42')
  })

  it('acknowledges a hard bounce and suppresses the recipient', async () => {
    const { instance, mocks } = await TestBed.create(EmailConsumer, { metadata })

    const result = instance.onError(new RecipientRejectedError('ghost@bounce.test', 550), inboundMessage())

    expect(result).toBe('ack')
    expect(mocks.get(SuppressionList).add).toHaveBeenCalledWith('ghost@bounce.test', 'SMTP 550')
  })

  it('dead-letters every other terminal failure', async () => {
    const { instance, mocks } = await TestBed.create(EmailConsumer, { metadata })

    expect(instance.onError(new SmtpUnavailableError('421'), inboundMessage())).toBeUndefined()
    expect(instance.onError(new NonRetryableError('template variable missing'), inboundMessage())).toBeUndefined()
    expect(mocks.get(SuppressionList).add).not.toHaveBeenCalled()
  })
})
