import { CreateUserInput, type Schema, UpdateUserInput, UserDeleted, UserRegistered } from '../src/index.ts'
import { describe, expect, test as it } from 'bun:test'

/** Runs a schema like `@Body(schema)` / `@Message(schema)` do (Standard Schema v1). */
const validate = <T>(schema: Schema<T>, value: unknown) => schema['~standard'].validate(value)

describe('shared schemas (Standard Schema v1)', () => {
  it('normalise valid values and strip unknown properties', () => {
    expect(validate(CreateUserInput, { email: ' Ada@Example.COM ', name: ' Ada ', admin: true })).toEqual({
      value: { email: 'ada@example.com', name: 'Ada' },
    })
    expect(validate(UpdateUserInput, {})).toEqual({ value: {} })
    expect(validate(UserDeleted, { id: 'u1', at: '2026-01-01T01:00:00+01:00' })).toEqual({
      value: { id: 'u1', at: '2026-01-01T00:00:00.000Z' },
    })
  })

  it('report every problem with its path', () => {
    expect(validate(CreateUserInput, { email: 'nope', name: '' })).toEqual({
      issues: [
        { message: 'Invalid email address', path: ['email'] },
        { message: 'Must contain at least 1 character(s)', path: ['name'] },
      ],
    })
    expect(validate(UserRegistered, { id: 'u1', name: 'Ada', at: 'yesterday' })).toEqual({
      issues: [
        { message: 'Required', path: ['email'] },
        { message: 'Expected an ISO 8601 date-time', path: ['at'] },
      ],
    })
    expect(validate(UpdateUserInput, 'Ada')).toEqual({ issues: [{ message: 'Expected an object', path: [] }] })
  })
})
