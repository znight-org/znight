import * as entry from '../src/index.ts'
import { describe, expect, it } from 'bun:test'

describe('public entries', () => {
  it('exposes the runtime API from the root entry', () => {
    expect(Object.keys(entry).sort()).toEqual(
      [
        'AttemptsExhaustedError',
        'BINARY_CONTENT_TYPE',
        'Consumer',
        'Ctx',
        'DEFAULT_BACKOFF',
        'DEFAULT_RETRY_DELAY_MS',
        'DEFAULT_RETRY_POLICY',
        'Headers',
        'JSON_CONTENT_TYPE',
        'Message',
        'MessageBroker',
        'MessageDecodeError',
        'MessageValidationError',
        'MessagingHeaders',
        'MessagingPlugin',
        'MessagingTokens',
        'NoHandlerError',
        'NonRetryableError',
        'OnError',
        'OnMessage',
        'Retry',
        'TEXT_CONTENT_TYPE',
        'attemptFromHeaders',
        'bodyToBytes',
        'bodyToText',
        'computeRetryDelay',
        'isNonRetryable',
        'isStandardSchema',
        'jsonCodec',
        'mediaType',
        'messageHeader',
        'normalizeRetry',
        'validateMessage',
      ].sort(),
    )
  })

  it('resolves the subpath exports through the package export map', async () => {
    const memory = await import('@znight/messaging/memory')
    expect(typeof memory.memory).toBe('function')
    expect(typeof memory.MemoryDriver).toBe('function')
    const rabbitmq = await import('@znight/messaging/rabbitmq')
    expect(typeof rabbitmq.rabbitmq).toBe('function')
    const sqs = await import('@znight/messaging/sqs')
    expect(typeof sqs.sqs).toBe('function')
    const kafka = await import('@znight/messaging/kafka')
    expect(typeof kafka.kafka).toBe('function')
    const root = await import('@znight/messaging')
    expect(root.MessagingPlugin).toBe(entry.MessagingPlugin)
  })

  it('declares the manifest of §7', async () => {
    const pkg = (await import('../package.json', { with: { type: 'json' } })).default as Record<string, unknown>
    expect(pkg.znight).toEqual({
      apiVersion: 1,
      compiler: '@znight/messaging/compiler',
      provides: [
        { export: 'MessageBroker', plugin: 'MessagingPlugin', scope: 'singleton' },
        { export: 'InboundMessage', plugin: 'MessagingPlugin', scope: 'request' },
      ],
    })
    expect(entry.MessagingTokens).toEqual({
      MessageBroker: '@znight/messaging#MessageBroker',
      InboundMessage: '@znight/messaging#InboundMessage',
    })
  })
})
