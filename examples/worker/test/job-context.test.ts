import { MessagingTokens } from '@znight/messaging'
import { Logger } from '@znight/observability'
import { TestBed } from '@znight/testing'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { JobContext } from '../src/messaging/job-context.js'
import { inboundMessage } from './support.js'
import { describe, expect, test as it } from 'bun:test'

// JobContext is request-scoped: TestBed builds it like any provider. Its InboundMessage (a
// request-scoped external) is given with `provide`, keyed by its token; Logger is auto-mocked.
function createContext(message = inboundMessage()) {
  return TestBed.create(JobContext, { metadata, provide: [[MessagingTokens.InboundMessage, message]] })
}

describe('JobContext', () => {
  it('binds the job fields to a child logger', async () => {
    const { mocks } = await createContext(inboundMessage({ id: 'job-1', queue: 'emails.send', attempt: 2 }))

    expect(mocks.get(Logger).child).toHaveBeenCalledWith({
      jobId: 'job-1',
      queue: 'emails.send',
      attempt: 2,
      correlationId: 'job-1',
    })
  })

  it('uses the correlation id of the producer when there is one', async () => {
    const { instance } = await createContext(inboundMessage({ headers: { 'x-correlation-id': 'signup-7' } }))

    expect(instance.correlationId).toBe('signup-7')
  })

  it('knows when a failure is final', async () => {
    const first = await createContext(inboundMessage({ attempt: 1, maxAttempts: 3 }))
    const last = await createContext(inboundMessage({ attempt: 3, maxAttempts: 3 }))

    expect(first.instance.isLastAttempt).toBe(false)
    expect(last.instance.isLastAttempt).toBe(true)
  })
})
