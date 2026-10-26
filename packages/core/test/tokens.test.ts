import { CoreTokens, describeToken, displayName, formatPath, type TypedToken, token } from '../src/index.ts'
import { describe, expect, it } from 'bun:test'

describe('displayName', () => {
  it('returns the part after the last #', () => {
    expect(displayName('src/users/user.service.ts#UserService')).toBe('UserService')
    expect(displayName('@acme/auth#JwtService')).toBe('JwtService')
    expect(displayName('src/db/db.factory.ts#DbFactory.createPool')).toBe('DbFactory.createPool')
  })

  it('uses the last # when a path contains several', () => {
    expect(displayName('src/#weird/a.ts#Thing')).toBe('Thing')
  })

  it('returns tokens without # unchanged', () => {
    expect(displayName('config')).toBe('config')
    expect(displayName('')).toBe('')
  })
})

describe('formatPath / describeToken', () => {
  it('formats a dependency path with display names', () => {
    expect(formatPath(['src/a.ts#A', 'src/b.ts#B', '@x/y#C'])).toBe('A -> B -> C')
    expect(formatPath([])).toBe('')
  })

  it('describes a token with its display name and full identity', () => {
    expect(describeToken('src/a.ts#A')).toBe('A (src/a.ts#A)')
    expect(describeToken('plain')).toBe('plain')
  })
})

describe('token()', () => {
  it('returns the identifier unchanged (typed at compile time only)', () => {
    const clock: TypedToken<{ now(): number }> = token<{ now(): number }>('@acme/time#Clock')
    expect(clock).toBe('@acme/time#Clock')
    expect(typeof clock).toBe('string')
  })
})

describe('CoreTokens', () => {
  it('are namespaced under @znight/core and frozen', () => {
    expect(CoreTokens.Container).toBe('@znight/core#Container')
    expect(CoreTokens.Application).toBe('@znight/core#Application')
    expect(CoreTokens.Hooks).toBe('@znight/core#Hooks')
    expect(CoreTokens.Logger).toBe('@znight/core#CoreLogger')
    expect(Object.isFrozen(CoreTokens)).toBe(true)
  })
})
