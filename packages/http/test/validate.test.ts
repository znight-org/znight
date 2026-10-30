import type { StandardSchemaV1 } from '../src/index.ts'

import * as v from 'valibot'
import { z } from 'zod'

import { isStandardSchema, toIssueDetail, ValidationException, validate } from '../src/index.ts'
import { describe, expect, it } from 'bun:test'

async function invalid(fn: () => unknown): Promise<ValidationException> {
  try {
    await fn()
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationException)
    return error as ValidationException
  }
  throw new Error('Expected a ValidationException')
}

describe('validate', () => {
  const User = z.object({ name: z.string().trim(), tags: z.array(z.string()).default([]) })

  it('returns the schema output synchronously for sync schemas (zod)', () => {
    const result = validate(User, { name: '  Ada ', extra: true }, 'body')
    expect(result).not.toBeInstanceOf(Promise)
    expect(result).toEqual({ name: 'Ada', tags: [] })
  })

  it('returns the schema output for valibot', () => {
    const schema = v.object({ id: v.pipe(v.string(), v.transform(Number)) })
    expect(validate(schema, { id: '12' }, 'query')).toEqual({ id: 12 })
  })

  it('throws a ValidationException with dotted paths', async () => {
    const schema = z.object({ user: z.object({ emails: z.array(z.email()) }) })
    const error = await invalid(() => validate(schema, { user: { emails: ['ok@example.com', 'nope'] } }, 'body'))
    expect(error.status).toBe(400)
    expect(error.message).toBe('Invalid body')
    expect(error.location).toBe('body')
    expect(error.details).toEqual([{ path: 'user.emails.1', message: expect.any(String) }])
    expect(error.issues).toHaveLength(1)
    expect(error.toBody()).toMatchObject({ statusCode: 400, error: 'Bad Request', message: 'Invalid body' })
  })

  it('reports root issues with an empty path (valibot)', async () => {
    const error = await invalid(() => validate(v.string(), 42, 'param "id"'))
    expect(error.message).toBe('Invalid param "id"')
    expect(error.details).toEqual([{ path: '', message: expect.any(String) }])
  })

  it('returns a promise for async schemas', async () => {
    const schema = z.string().refine(async value => value.length > 2, 'too short')
    const ok = validate(schema, 'abc', 'body')
    expect(ok).toBeInstanceOf(Promise)
    expect(await ok).toBe('abc')
    const error = await invalid(() => validate(schema, 'a', 'body'))
    expect(error.details).toEqual([{ path: '', message: 'too short' }])
  })

  it('accepts any Standard Schema implementation', () => {
    const custom: StandardSchemaV1<unknown, number> = {
      '~standard': {
        version: 1,
        vendor: 'custom',
        validate: value =>
          typeof value === 'number'
            ? { value: value * 2 }
            : { issues: [{ message: 'not a number', path: [{ key: 'x' }] }] },
      },
    }
    expect(validate(custom, 2, 'body')).toBe(4)
    expect(() => validate(custom, 'a', 'body')).toThrow(ValidationException)
  })

  it('never echoes a cookie value: issue messages of cookies are replaced (valibot quotes the value)', async () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.SECRET-SESSION-TOKEN'
    const uuid = v.pipe(v.string(), v.uuid())
    // the library message quotes the value...
    const plain = await invalid(() => validate(uuid, token, 'query "id"'))
    expect(JSON.stringify(plain.toBody())).toContain('SECRET-SESSION-TOKEN')
    // ...but not for cookies, a signed cookie or the whole record
    for (const [schema, value, location, path] of [
      [uuid, token, 'cookie "sid"', ''],
      [v.picklist(['light', 'dark']), token, 'cookie "theme"', ''],
      [v.object({ sid: uuid }), { sid: token }, 'cookies', 'sid'],
    ] as const) {
      const error = await invalid(() => validate(schema as never, value, location))
      expect(error.message).toBe(`Invalid ${location}`)
      expect(error.details).toEqual([{ path, message: 'Invalid value' }])
      expect(JSON.stringify(error.toBody())).not.toContain('SECRET')
      expect(JSON.stringify(error.issues)).not.toContain('SECRET')
    }
  })

  it('throws a TypeError for non schemas', () => {
    expect(() => validate({} as never, 1, 'body')).toThrow(TypeError)
    expect(() => validate(null as never, 1, 'body')).toThrow('The schema of body is not a Standard Schema v1')
    // exactly what isStandardSchema rejects
    for (const schema of [
      undefined,
      'x',
      42,
      { '~standard': null },
      { '~standard': 'x' },
      { '~standard': { version: 2, validate: () => ({ value: 1 }) } },
      { '~standard': { version: 1, validate: 'x' } },
    ]) {
      expect(isStandardSchema(schema)).toBe(false)
      expect(() => validate(schema as never, 1, 'query')).toThrow(
        'The schema of query is not a Standard Schema v1 (missing "~standard.validate")',
      )
    }
  })

  it('reads ~standard once and calls validate on it (function schemas included)', async () => {
    let reads = 0
    const props = {
      version: 1 as const,
      vendor: 'custom',
      validate(this: unknown, value: unknown) {
        return this === props ? { value: `${value}!` } : { issues: [{ message: 'unbound' }] }
      },
    }
    const schema = Object.assign(() => undefined, {
      get '~standard'() {
        reads++
        return props
      },
    })
    expect(validate(schema as unknown as StandardSchemaV1<unknown, string>, 'a', 'body')).toBe('a!')
    expect(reads).toBe(1)
    // an asynchronous result is a promise of the output (or of the ValidationException)
    const later: StandardSchemaV1<unknown, string> = {
      '~standard': {
        version: 1,
        vendor: 'custom',
        validate: async value => (value === 'ok' ? { value: 'done' } : { issues: [{ message: 'nope' }] }),
      },
    }
    const pending = validate(later, 'ok', 'body')
    expect(pending).toBeInstanceOf(Promise)
    expect(await pending).toBe('done')
    await expect(validate(later, 'ko', 'body')).rejects.toThrow(ValidationException)
  })
})

describe('isStandardSchema / toIssueDetail', () => {
  it('detects schemas', () => {
    expect(isStandardSchema(z.string())).toBe(true)
    expect(isStandardSchema(v.string())).toBe(true)
    expect(isStandardSchema({ '~standard': { version: 2, validate: () => ({}) } })).toBe(false)
    expect(isStandardSchema(null)).toBe(false)
    expect(isStandardSchema('x')).toBe(false)
  })

  it('formats issue paths', () => {
    expect(toIssueDetail({ message: 'm' })).toEqual({ path: '', message: 'm' })
    expect(toIssueDetail({ message: 'm', path: ['a', 0, { key: 'b' }, Symbol('s')] })).toEqual({
      path: 'a.0.b.s',
      message: 'm',
    })
  })
})
