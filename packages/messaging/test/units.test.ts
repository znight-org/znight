import type { StandardSchemaV1 } from '../src/index.ts'

import { ErrorCode, ZnightError } from '@znight/core'
import { z } from 'zod'

import { deadLetterHeaders, headerValueToString, toHeaderRecord } from '../src/drivers/shared.ts'
import {
  attemptFromHeaders,
  computeRetryDelay,
  DEFAULT_RETRY_POLICY,
  isNonRetryable,
  isStandardSchema,
  jsonCodec,
  MessageDecodeError,
  MessageValidationError,
  MessagingHeaders,
  mediaType,
  messageHeader,
  NonRetryableError,
  normalizeRetry,
  validateMessage,
} from '../src/index.ts'
import { AbortedError, Semaphore, sleep, truncate } from '../src/internal/async.ts'
import { assertRetrySupported, retryDelays } from '../src/retry.ts'
import { caught } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

describe('jsonCodec', () => {
  it.each([
    [{ a: 1 }, undefined, '{"a":1}', 'application/json'],
    ['text', undefined, '"text"', 'application/json'],
    ['plain', 'text/plain', 'plain', 'text/plain'],
    [42, undefined, '42', 'application/json'],
    [null, undefined, 'null', 'application/json'],
    [undefined, undefined, '', 'application/json'],
    [{ a: 1 }, 'application/vnd.acme+json', '{"a":1}', 'application/vnd.acme+json'],
  ])('encodes %p (%p)', (payload, contentType, body, type) => {
    expect(jsonCodec.encode(payload, contentType)).toEqual({ body, contentType: type })
  })

  it('encodes binary payloads as is', () => {
    const bytes = new Uint8Array([1, 2])
    expect(jsonCodec.encode(bytes, undefined)).toEqual({ body: bytes, contentType: 'application/octet-stream' })
    expect(jsonCodec.encode(bytes, 'image/png')).toEqual({ body: bytes, contentType: 'image/png' })
  })

  it('refuses values JSON cannot represent', () => {
    expect(() => jsonCodec.encode(Symbol('x'), undefined)).toThrow('Cannot encode a symbol payload')
    expect(() => jsonCodec.encode(1n, undefined)).toThrow(TypeError)
  })

  it.each([
    ['{"a":1}', 'application/json', { a: 1 }],
    ['{"a":1}', 'application/json; charset=utf-8', { a: 1 }],
    ['{"a":1}', 'application/cloudevents+json', { a: 1 }],
    ['', 'application/json', undefined],
    ['  ', 'application/json', undefined],
    ['{"a":1}', undefined, { a: 1 }],
    ['not json', undefined, 'not json'],
    ['', undefined, undefined],
    ['hello', 'text/plain', 'hello'],
  ])('decodes %p (%p)', (body, contentType, expected) => {
    expect(jsonCodec.decode(body, contentType)).toEqual(expected)
  })

  it('decodes bytes', () => {
    const bytes = new TextEncoder().encode('{"x":true}')
    expect(jsonCodec.decode(bytes, 'application/json')).toEqual({ x: true })
    expect(jsonCodec.decode(bytes, 'application/octet-stream')).toBe(bytes)
    expect(jsonCodec.decode('abc', 'application/octet-stream')).toEqual(new TextEncoder().encode('abc'))
  })

  it('rejects malformed JSON with a MessageDecodeError', () => {
    expect(() => jsonCodec.decode('{oops', 'application/json')).toThrow(MessageDecodeError)
  })

  it('parses media types', () => {
    expect(mediaType(undefined)).toBeUndefined()
    expect(mediaType('')).toBeUndefined()
    expect(mediaType(' Application/JSON ; charset=utf-8')).toBe('application/json')
  })
})

describe('retry policies', () => {
  it('fills defaults', () => {
    expect(normalizeRetry({ attempts: 3 })).toEqual({ attempts: 3, backoff: 'exponential', delay: 1000 })
    expect(normalizeRetry({ attempts: 2, backoff: 'fixed', delay: 0, maxDelay: 10 })).toEqual({
      attempts: 2,
      backoff: 'fixed',
      delay: 0,
      maxDelay: 10,
    })
  })

  it.each([
    [{ attempts: 0 }, '"attempts"'],
    [{ attempts: 1.5 }, '"attempts"'],
    [{ attempts: 100_000 }, '"attempts"'],
    [{ attempts: 2, delay: Number.POSITIVE_INFINITY }, '"delay"'],
    [{ attempts: 2, delay: 5, maxDelay: 1 }, '"maxDelay"'],
    [{ attempts: 2, backoff: 'random' }, '"backoff"'],
  ])('rejects %p', (options, message) => {
    let error: unknown
    try {
      normalizeRetry(options as never, '@Retry on X.y()')
    } catch (caughtError) {
      error = caughtError
    }
    expect(error).toBeInstanceOf(ZnightError)
    expect((error as ZnightError).code).toBe(ErrorCode.InvalidConsumer)
    expect((error as Error).message).toContain('@Retry on X.y()')
    expect((error as Error).message).toContain(message)
  })

  it('rejects non-object options', () => {
    expect(() => normalizeRetry(null as never)).toThrow('retry options must be an object')
  })

  it('computes fixed and exponential delays', () => {
    const fixed = normalizeRetry({ attempts: 4, backoff: 'fixed', delay: 100 })
    expect([1, 2, 3].map(attempt => computeRetryDelay(fixed, attempt))).toEqual([100, 100, 100])
    const exponential = normalizeRetry({ attempts: 6, delay: 100, maxDelay: 500 })
    expect(retryDelays(exponential)).toEqual([100, 200, 400, 500, 500])
    expect(computeRetryDelay(normalizeRetry({ attempts: 2000, delay: 1 }), 1999)).toBe(Number.MAX_SAFE_INTEGER)
    expect(retryDelays(DEFAULT_RETRY_POLICY)).toEqual([1000, 2000])
    expect(retryDelays(normalizeRetry({ attempts: 1 }))).toEqual([])
  })

  it('checks delays against the driver capabilities', () => {
    const capabilities = {
      nativeDelay: true,
      maxNativeDelayMs: 1000,
      maxInProcessDelayMs: 100,
      deliveryCount: 'native' as const,
      maxPublishDelayMs: 0,
    }
    expect(() =>
      assertRetrySupported(normalizeRetry({ attempts: 3, delay: 500 }), capabilities, 'x', 'here'),
    ).not.toThrow()
    expect(() => assertRetrySupported(normalizeRetry({ attempts: 3, delay: 600 }), capabilities, 'x', 'here')).toThrow(
      'here: the x driver cannot wait 1200 ms between attempts (it supports in-process delays up to 100 ms and native delays up to 1000 ms)',
    )
    expect(() =>
      assertRetrySupported(
        normalizeRetry({ attempts: 2, delay: 200 }),
        { ...capabilities, nativeDelay: false },
        'x',
        'here',
      ),
    ).toThrow('and no native delay')
  })
})

describe('headers', () => {
  it('reads headers exactly, then case-insensitively', () => {
    const message = { headers: { 'X-Tenant': 'acme', 'x-tenant': 'lower' } }
    expect(messageHeader(message, 'x-tenant')).toBe('lower')
    expect(messageHeader({ headers: { 'X-Tenant': 'acme' } }, 'x-tenant')).toBe('acme')
    expect(messageHeader(message, 'missing')).toBeUndefined()
  })

  it('parses the attempt header', () => {
    expect(attemptFromHeaders({})).toBe(1)
    expect(attemptFromHeaders({ [MessagingHeaders.Attempt]: '3' })).toBe(3)
    expect(attemptFromHeaders({ [MessagingHeaders.Attempt]: '0' })).toBe(1)
    expect(attemptFromHeaders({ [MessagingHeaders.Attempt]: 'abc' })).toBe(1)
    expect(attemptFromHeaders({ [MessagingHeaders.Attempt]: '2.5' })).toBe(1)
  })

  it('converts header values to strings', () => {
    expect(headerValueToString(undefined)).toBeUndefined()
    expect(headerValueToString(null)).toBeUndefined()
    expect(headerValueToString(12)).toBe('12')
    expect(headerValueToString(true)).toBe('true')
    expect(headerValueToString(5n)).toBe('5')
    expect(headerValueToString(new TextEncoder().encode('bytes'))).toBe('bytes')
    expect(headerValueToString(new Date(0))).toBe('1970-01-01T00:00:00.000Z')
    expect(headerValueToString({ a: [1, 2n] })).toBe('{"a":[1,"2"]}')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(headerValueToString(cyclic)).toBe('[object Object]')
  })

  it('builds null-prototype header records', () => {
    const record = toHeaderRecord([
      ['__proto__', 'x'],
      ['a', 1],
      ['b', undefined],
    ])
    expect(Object.getPrototypeOf(record)).toBeNull()
    expect(Object.getOwnPropertyDescriptor(record, '__proto__')?.value).toBe('x')
    expect(Object.keys(record)).toEqual(['__proto__', 'a'])
  })

  it('builds dead-letter headers without the attempt counter', () => {
    const headers = deadLetterHeaders(
      { a: '1', [MessagingHeaders.Attempt]: '3' },
      { queue: 'q.dlq', reason: 'max-attempts', error: new Error('x'.repeat(2000)), attempt: 3 },
      'q',
    )
    expect(headers.a).toBe('1')
    expect(headers[MessagingHeaders.Attempt]).toBeUndefined()
    expect(headers[MessagingHeaders.DeadLetterReason]).toBe('max-attempts')
    expect(headers[MessagingHeaders.OriginalQueue]).toBe('q')
    expect(headers[MessagingHeaders.Attempts]).toBe('3')
    expect(headers[MessagingHeaders.Error]?.length).toBe(1024)
  })
})

describe('validateMessage', () => {
  const schema = z.object({ id: z.number(), tags: z.array(z.string()).default([]) })

  it('returns the schema output synchronously', () => {
    expect(validateMessage(schema, { id: 1 })).toEqual({ id: 1, tags: [] })
  })

  it('throws a non-retryable MessageValidationError with issues', () => {
    let error: unknown
    try {
      expect(validateMessage(schema, { id: 'x', tags: [1] }, 'order')).toBeUndefined()
    } catch (caughtError) {
      error = caughtError
    }
    expect(error).toBeInstanceOf(MessageValidationError)
    expect(isNonRetryable(error)).toBe(true)
    expect((error as MessageValidationError).issues).toEqual([
      { path: 'id', message: expect.any(String) },
      { path: 'tags.0', message: expect.any(String) },
    ])
    expect((error as Error).message).toStartWith('Invalid order: id: ')
  })

  it('supports async schemas and path segments', async () => {
    const asyncSchema: StandardSchemaV1<unknown, string> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: async value =>
          typeof value === 'string'
            ? { value: value.toUpperCase() }
            : { issues: [{ message: 'expected a string', path: [{ key: 'root' }, 0] }] },
      },
    }
    const result = validateMessage(asyncSchema, 'abc')
    expect(result).toBeInstanceOf(Promise)
    expect(await result).toBe('ABC')
    const error = (await caught(Promise.resolve(validateMessage(asyncSchema, 1)))) as MessageValidationError
    expect(error.issues).toEqual([{ path: 'root.0', message: 'expected a string' }])
  })

  it('summarises many issues', () => {
    const many: StandardSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => ({ issues: Array.from({ length: 7 }, (_, index) => ({ message: `issue ${index}` })) }),
      },
    }
    expect(() => validateMessage(many, 1)).toThrow('issue 4 (+2 more)')
  })

  it('rejects values that are not Standard Schemas', () => {
    expect(isStandardSchema(schema)).toBe(true)
    expect(isStandardSchema({})).toBe(false)
    expect(isStandardSchema(null)).toBe(false)
    expect(() => validateMessage({} as never, 1)).toThrow('is not a Standard Schema v1')
  })
})

describe('errors', () => {
  it('brands non-retryable errors', () => {
    class DomainError extends NonRetryableError {}
    expect(isNonRetryable(new DomainError('x'))).toBe(true)
    expect(isNonRetryable(new Error('x'))).toBe(false)
    expect(isNonRetryable(null)).toBe(false)
    expect(isNonRetryable('x')).toBe(false)
    expect(new NonRetryableError('x', { cause: 1 }).cause).toBe(1)
    expect(new NonRetryableError('x').name).toBe('NonRetryableError')
  })
})

describe('internal async helpers', () => {
  it('sleeps and aborts', async () => {
    await sleep(0)
    const controller = new AbortController()
    const pending = sleep(10_000, controller.signal)
    controller.abort()
    expect(await caught(pending)).toBeInstanceOf(AbortedError)
    expect(await caught(sleep(1, controller.signal))).toBeInstanceOf(AbortedError)
    await sleep(1, new AbortController().signal)
  })

  it('limits concurrency in FIFO order and supports aborting waiters', async () => {
    const semaphore = new Semaphore(1)
    await semaphore.acquire()
    expect(semaphore.available).toBe(0)
    const order: number[] = []
    const first = semaphore.acquire().then(() => order.push(1))
    const controller = new AbortController()
    const aborted = semaphore.acquire(controller.signal)
    const third = semaphore.acquire().then(() => order.push(3))
    expect(semaphore.waiting).toBe(3)
    controller.abort()
    expect(await caught(aborted)).toBeInstanceOf(AbortedError)
    semaphore.release()
    await first
    semaphore.release()
    await third
    expect(order).toEqual([1, 3])
    semaphore.release()
    expect(semaphore.available).toBe(1)
    expect(await caught(semaphore.acquire(controller.signal))).toBeInstanceOf(AbortedError)
  })

  it('truncates', () => {
    expect(truncate('abc', 5)).toBe('abc')
    expect(truncate('abcdef', 4)).toBe('abc…')
  })
})

describe('MessageDecodeError', () => {
  it('is non-retryable', async () => {
    expect(isNonRetryable(new MessageDecodeError('x'))).toBe(true)
    expect(await caught(Promise.reject(new MessageDecodeError('y')))).toBeInstanceOf(NonRetryableError)
  })
})
