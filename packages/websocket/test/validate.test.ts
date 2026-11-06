import type { StandardSchemaV1 } from '@znight/http'

import { validatePayload, WsValidationException } from '../src/index.ts'
import { describe, expect, it } from 'bun:test'

function schema(check: (value: unknown) => boolean, async = false): StandardSchemaV1<unknown, string> {
  const result = (value: unknown) =>
    check(value) ? { value: String(value).toUpperCase() } : { issues: [{ message: 'Required', path: ['room'] }] }
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: value => (async ? Promise.resolve(result(value)) : result(value)),
    },
  }
}

describe('validatePayload', () => {
  it('returns the schema output, synchronously for a synchronous schema', async () => {
    expect(
      validatePayload(
        schema(v => v === 'a'),
        'a',
      ),
    ).toBe('A')
    expect(
      await validatePayload(
        schema(v => v === 'a', true),
        'a',
      ),
    ).toBe('A')
  })

  it('throws WsValidationException with the issue details', async () => {
    const sync = (() => {
      try {
        return validatePayload(
          schema(() => false),
          'x',
        )
      } catch (error) {
        return error
      }
    })()
    expect(sync).toBeInstanceOf(WsValidationException)
    expect(sync).toMatchObject({ code: 'BAD_REQUEST', details: [{ path: 'room', message: 'Required' }] })
    await expect(
      validatePayload(
        schema(() => false, true),
        'x',
      ),
    ).rejects.toBeInstanceOf(WsValidationException)
  })
})
