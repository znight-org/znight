/**
 * `validate` of the messaging extension: checks that need every consumer of the application.
 */
import type { ValidateContext } from '@znight/compiler'
import type { ConsumerData, MemberClassData, MessagingData } from './data.ts'

import { compareStrings, INVALID_CONSUMER, INVALID_DECORATOR } from './constants.ts'

/** Cross-consumer checks: one consumer per queue, messaging decorators outside of consumers. */
export function validateMessaging(ctx: ValidateContext<MessagingData>): void {
  const consumers = ctx.stored
    .filter((data): data is ConsumerData => data.kind === 'consumer')
    .sort((a, b) => compareStrings(a.token, b.token))

  // a queue is consumed by a single @Consumer class (the plugin refuses to boot otherwise)
  const byQueue = new Map<string, ConsumerData>()
  for (const consumer of consumers) {
    if (consumer.queue === '') continue
    const first = byQueue.get(consumer.queue)
    if (first === undefined) {
      byQueue.set(consumer.queue, consumer)
      continue
    }
    ctx.report({
      code: INVALID_CONSUMER,
      severity: 'error',
      message: `${first.displayName} and ${consumer.displayName} both consume "${consumer.queue}"`,
      location: consumer.location,
      hints: [
        'A queue is consumed by a single @Consumer class: merge the handlers, or route by type with @OnMessage(type)',
      ],
      related: [{ message: `${first.displayName} consumes "${consumer.queue}"`, location: first.location }],
    })
  }

  // @OnMessage / @OnError / @Retry on a class that is neither a consumer nor one of its base classes
  const bases = new Set(consumers.flatMap(consumer => consumer.chain))
  for (const data of ctx.stored) {
    if (data.kind !== 'members' || data.abstract || bases.has(data.identity)) continue
    reportNotAConsumer(data, ctx)
  }
}

function reportNotAConsumer(data: MemberClassData, ctx: ValidateContext<MessagingData>): void {
  for (const decorator of data.decorators) {
    ctx.report({
      code: INVALID_DECORATOR,
      severity: 'error',
      message: `@${decorator.name} has no effect: ${data.displayName} is not a @Consumer`,
      location: decorator.location,
      hints: [
        `Add @Consumer('queue') to ${data.displayName}, or extend it from a @Consumer class`,
        'Base classes holding shared handlers should be abstract',
      ],
    })
  }
}
