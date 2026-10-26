/**
 * `@Retry` options are validated and normalized at build time exactly like the runtime
 * `normalizeRetry()` does at boot (same accepted values, same defaults).
 */
import type { ConsumerData } from '../../src/compiler/index.ts'

import { normalizeRetry } from '../../src/index.ts'
import { analyzeFiles, cleanupApps, stored } from './helpers.ts'
import { afterAll, describe, expect, it } from 'bun:test'

afterAll(cleanupApps)

const CASES: readonly string[] = [
  '{ attempts: 1 }',
  "{ attempts: 3, backoff: 'fixed' }",
  "{ attempts: 3, backoff: 'exponential', delay: 0 }",
  '{ attempts: 3, delay: 0, maxDelay: 0 }',
  '{ attempts: 10000 }',
  '{ attempts: 3, maxDelay: 1000 }',
  '{ attempts: 3, delay: 2.5 }',
  '{ attempts: 3, backoff: undefined, delay: undefined, maxDelay: undefined }',
  '{ attempts: 0 }',
  '{ attempts: -1 }',
  '{ attempts: 2.5 }',
  "{ attempts: '3' }",
  '{ attempts: NaN }',
  '{ attempts: 10001 }',
  "{ attempts: 3, backoff: 'linear' }",
  '{ attempts: 3, backoff: null }',
  '{ attempts: 3, delay: null }',
  '{ attempts: 3, delay: NaN }',
  '{ attempts: 3, delay: Infinity }',
  '{ attempts: 3, delay: -1 }',
  '{ attempts: 3, delay: 100, maxDelay: 50 }',
  '{ attempts: 3, maxDelay: Infinity }',
  '{ attempts: 3, maxDelay: null }',
  '{ attempts: 3, delay: 100, maxDelay: 100 }',
]

describe('@Retry normalization', () => {
  it('accepts and normalizes exactly what the runtime accepts', () => {
    const handlers = CASES.map((text, index) => `  @OnMessage('t${index}') @Retry(${text} as never) h${index}() {}`)
    const result = analyzeFiles({
      'src/a.ts': `import { Consumer, OnMessage, Retry } from '@znight/messaging'
@Consumer('retries')
export class RetryConsumer {
${handlers.join('\n')}
}`,
    })
    const consumer = stored(result).find((data): data is ConsumerData => data.kind === 'consumer')
    expect(consumer?.handlers).toHaveLength(CASES.length)
    CASES.forEach((text, index) => {
      const value = new Function(`return (${text})`)() as Parameters<typeof normalizeRetry>[0]
      let runtime: unknown
      try {
        runtime = normalizeRetry(value)
      } catch {
        runtime = 'invalid'
      }
      const compiled = consumer?.handlers[index]?.retry ?? 'invalid'
      expect({ text, policy: compiled }).toEqual({ text, policy: runtime as never })
    })
    // every invalid policy is an error located in the consumer file
    const invalid = CASES.filter((_, index) => consumer?.handlers[index]?.retry === undefined).length
    expect(invalid).toBeGreaterThan(10)
    expect(result.diagnostics.filter(diagnostic => diagnostic.severity === 'error').length).toBeGreaterThanOrEqual(
      invalid,
    )
  })
})
