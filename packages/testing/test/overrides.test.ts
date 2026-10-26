import { isProviderDefinition, token } from '@znight/core'

import { override, overrideFactory } from '../src/index.ts'
import { Database, T, UserRepository } from './support/app.ts'
import { describe, expect, test as it } from 'bun:test'

describe('override', () => {
  it('returns a [key, value] pair', () => {
    const value = new Database()
    expect(override(Database, value)).toEqual([Database, value])
    const clock = token<{ now(): number }>('src/clock.ts#Clock')
    const fixed = { now: () => 0 }
    expect(override(clock, fixed)).toEqual([clock, fixed])
  })
})

describe('overrideFactory', () => {
  it('builds a singleton definition without dependencies by default', () => {
    const factory = (): Database => new Database()
    const [key, definition] = overrideFactory(Database, factory)
    expect(key).toBe(Database)
    expect(definition).toEqual({ scope: 'singleton', deps: [], factory })
    expect(isProviderDefinition(definition)).toBe(true)
  })

  it('accepts dependencies, scope, async and dispose', () => {
    const [, definition] = overrideFactory(UserRepository, async () => ({}) as UserRepository, {
      deps: [T.Database, { token: T.Cache, optional: true }],
      scope: 'singleton',
      async: true,
      dispose: 'close',
    })
    expect(definition).toMatchObject({
      scope: 'singleton',
      deps: [T.Database, { token: T.Cache, optional: true }],
      async: true,
      dispose: 'close',
    })
  })

  it('rejects a non-function factory', () => {
    expect(() => overrideFactory(Database, 'nope' as never)).toThrow(TypeError)
  })
})
