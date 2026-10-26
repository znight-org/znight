import { isNonRetryable } from '@znight/messaging'

import { SendEmailJob } from '../src/emails/email.jobs.js'
import { EmailRenderer } from '../src/emails/email.renderer.js'
import { describe, expect, test as it } from 'bun:test'

// A provider without dependencies is a plain class: no container needed to test it.
const renderer = new EmailRenderer()

describe('EmailRenderer', () => {
  it('renders a template in the requested locale', () => {
    const job = SendEmailJob.parse({ to: 'ada@example.com', template: 'welcome', locale: 'fr', data: { name: 'Ada' } })

    expect(renderer.render(job)).toEqual({
      subject: 'Bienvenue, Ada !',
      text: 'Bonjour Ada,\n\nVotre compte est prêt.',
    })
  })

  it('defaults to English', () => {
    const job = SendEmailJob.parse({
      to: 'ada@example.com',
      template: 'password-reset',
      data: { resetUrl: 'https://x' },
    })

    expect(renderer.render(job).subject).toBe('Reset your password')
  })

  it('a missing template variable is a permanent failure (not retried)', () => {
    const job = SendEmailJob.parse({ to: 'ada@example.com', template: 'password-reset' })

    let error: unknown
    try {
      renderer.render(job)
    } catch (caught) {
      error = caught
    }
    expect(isNonRetryable(error)).toBe(true)
    expect((error as Error).message).toBe('Template "password-reset" needs data.resetUrl')
  })
})
