import {
  camelCase,
  constantCase,
  editDistance,
  kebabCase,
  pascalCase,
  suggest,
  toPackageName,
  unscopedName,
  validatePackageName,
} from '../src/names.ts'
import { describe, expect, test as it } from 'bun:test'

describe('case conversions', () => {
  it.each([
    ['user', 'user', 'User', 'user', 'USER'],
    ['UserProfile', 'user-profile', 'UserProfile', 'userProfile', 'USER_PROFILE'],
    ['userProfile', 'user-profile', 'UserProfile', 'userProfile', 'USER_PROFILE'],
    ['user_profile', 'user-profile', 'UserProfile', 'userProfile', 'USER_PROFILE'],
    ['user-profile', 'user-profile', 'UserProfile', 'userProfile', 'USER_PROFILE'],
    ['user profile', 'user-profile', 'UserProfile', 'userProfile', 'USER_PROFILE'],
    ['HTTPClient', 'http-client', 'HttpClient', 'httpClient', 'HTTP_CLIENT'],
    ['oauth2Token', 'oauth2-token', 'Oauth2Token', 'oauth2Token', 'OAUTH2_TOKEN'],
    ['user.service', 'user-service', 'UserService', 'userService', 'USER_SERVICE'],
  ])('%s', (input, kebab, pascal, camel, constant) => {
    expect(kebabCase(input)).toBe(kebab)
    expect(pascalCase(input)).toBe(pascal)
    expect(camelCase(input)).toBe(camel)
    expect(constantCase(input)).toBe(constant)
  })
})

describe('package names', () => {
  it('accepts valid npm names', () => {
    for (const name of ['my-service', 'api', '@acme/api', 'a.b_c~d', 'x1']) {
      expect(validatePackageName(name)).toBeUndefined()
    }
  })

  it('rejects invalid npm names with a reason', () => {
    expect(validatePackageName('')).toContain('empty')
    expect(validatePackageName('My-App')).toContain('lower case')
    expect(validatePackageName('.hidden')).toContain('cannot start')
    expect(validatePackageName('_private')).toContain('cannot start')
    expect(validatePackageName('a b')).toContain('may only contain')
    expect(validatePackageName('@scope/')).toContain('may only contain')
    expect(validatePackageName('a'.repeat(215))).toContain('214')
  })

  it('suggests a valid name', () => {
    expect(toPackageName('My App!')).toBe('my-app')
    expect(toPackageName('  Hello   World ')).toBe('hello-world')
    expect(toPackageName('__x')).toBe('x')
    expect(unscopedName('@acme/api')).toBe('api')
    expect(unscopedName('api')).toBe('api')
  })
})

describe('suggestions', () => {
  it('computes edit distances', () => {
    expect(editDistance('build', 'build')).toBe(0)
    expect(editDistance('buidl', 'build')).toBe(2)
    expect(editDistance('', 'abc')).toBe(3)
    expect(editDistance('kitten', 'sitting')).toBe(3)
  })

  it('suggests the closest candidate within reach', () => {
    expect(suggest('buidl', ['new', 'build', 'dev'])).toBe('build')
    expect(suggest('servce', ['service', 'controller'])).toBe('service')
    expect(suggest('xyz', ['service', 'controller'])).toBeUndefined()
  })
})
