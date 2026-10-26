import {
  checkRoutePath,
  compareRoutePaths,
  decodePathValue,
  joinPaths,
  matchRoutePath,
  normalizePath,
  parseRoutePath,
  RoutePathError,
  toFastifyPath,
  toHonoPath,
  toRegExpSource,
  WILDCARD_PARAM,
} from '../src/path.ts'
import { describe, expect, it } from 'bun:test'

describe('normalizePath / joinPaths', () => {
  it('normalises leading and trailing slashes', () => {
    expect(normalizePath('')).toBe('/')
    expect(normalizePath('/')).toBe('/')
    expect(normalizePath('///')).toBe('/')
    expect(normalizePath('users')).toBe('/users')
    expect(normalizePath('/users/')).toBe('/users')
    expect(normalizePath('//users//')).toBe('/users')
    expect(normalizePath('a//b')).toBe('/a//b')
  })

  it('joins parts with single slashes', () => {
    expect(joinPaths()).toBe('/')
    expect(joinPaths('/', '')).toBe('/')
    expect(joinPaths('/api', '/users/', ':id')).toBe('/api/users/:id')
    expect(joinPaths('', '/users', '/')).toBe('/users')
    expect(joinPaths('api/', '/v1/', '/users')).toBe('/api/v1/users')
  })
})

describe('parseRoutePath', () => {
  it('parses static segments, params and a trailing wildcard', () => {
    expect(parseRoutePath('/')).toEqual({ path: '/', segments: [], params: [], wildcard: false, shape: '/' })
    expect(parseRoutePath('users/:id/posts/:postId')).toEqual({
      path: '/users/:id/posts/:postId',
      segments: [
        { kind: 'static', value: 'users' },
        { kind: 'param', name: 'id' },
        { kind: 'static', value: 'posts' },
        { kind: 'param', name: 'postId' },
      ],
      params: ['id', 'postId'],
      wildcard: false,
      shape: '/users/:/posts/:',
    })
    expect(parseRoutePath('/files/*')).toMatchObject({ params: [WILDCARD_PARAM], wildcard: true, shape: '/files/*' })
    expect(parseRoutePath('/*').segments).toEqual([{ kind: 'wildcard' }])
    expect(parseRoutePath("/a-b.c_d~e!$&'+,;=@").segments).toEqual([{ kind: 'static', value: "a-b.c_d~e!$&'+,;=@" }])
  })

  it.each([
    ['/a//b', 'empty segment'],
    ['/files/*/x', 'must be the last segment'],
    ['/files*', 'must be a whole segment'],
    ['/:1id', 'invalid parameter name "1id"'],
    ['/:', 'invalid parameter name ""'],
    ['/:id-x', 'invalid parameter name "id-x"'],
    ['/:id/:id', 'duplicate parameter ":id"'],
    ['/a:b', 'only allowed at the start of a segment'],
    ['/a/../b', 'dot segments'],
    ['/a/./b', 'dot segments'],
    ['/users?x=1', 'cannot contain "?"'],
    ['/a#b', 'cannot contain "?" or "#"'],
    ['/café', 'invalid character "é"'],
    ['/a b', 'invalid character " "'],
    ['/a(b)', 'invalid character "("'],
    ['/a%20b', 'invalid character "%"'],
  ])('rejects %p', (path, message) => {
    const issue = checkRoutePath(path)
    expect(issue?.message).toContain(message)
    expect(() => parseRoutePath(path)).toThrow(RoutePathError)
    try {
      parseRoutePath(path)
    } catch (error) {
      expect((error as RoutePathError).path).toBe(path)
      expect((error as RoutePathError).message).toBe(`Invalid route path "${path}": ${issue?.message}`)
    }
  })

  it('rejects non-strings', () => {
    expect(checkRoutePath(42 as never)?.message).toBe('a route path must be a string')
  })

  it('accepts valid paths in checkRoutePath', () => {
    expect(checkRoutePath('/users/:id')).toBeUndefined()
  })
})

describe('matchRoutePath', () => {
  const users = parseRoutePath('/users/:id')
  const files = parseRoutePath('/files/*')

  it('matches static paths exactly', () => {
    expect(matchRoutePath(parseRoutePath('/'), '/')).toEqual({})
    expect(matchRoutePath(parseRoutePath('/'), '/x')).toBeUndefined()
    expect(matchRoutePath(parseRoutePath('/a/b'), '/a/b')).toEqual({})
    expect(matchRoutePath(parseRoutePath('/a/b'), '/a/b/')).toBeUndefined()
    expect(matchRoutePath(parseRoutePath('/a/b'), '/a')).toBeUndefined()
    expect(matchRoutePath(parseRoutePath('/a/b'), '/A/b')).toBeUndefined()
    expect(matchRoutePath(parseRoutePath('/a'), 'a')).toBeUndefined()
  })

  it('extracts raw parameter values', () => {
    expect(matchRoutePath(users, '/users/42')).toEqual({ id: '42' })
    expect(matchRoutePath(users, '/users/a%20b')).toEqual({ id: 'a%20b' })
    expect(matchRoutePath(users, '/users/')).toBeUndefined()
    expect(matchRoutePath(users, '/users')).toBeUndefined()
    expect(matchRoutePath(users, '/users/1/2')).toBeUndefined()
    expect(matchRoutePath(parseRoutePath('/:a/:b'), '/x/y')).toEqual({ a: 'x', b: 'y' })
  })

  it('matches the rest of the path with a wildcard', () => {
    expect(matchRoutePath(files, '/files/')).toEqual({ '*': '' })
    expect(matchRoutePath(files, '/files/a/b/c')).toEqual({ '*': 'a/b/c' })
    expect(matchRoutePath(files, '/files')).toBeUndefined()
    expect(matchRoutePath(files, '/filesx/a')).toBeUndefined()
    expect(matchRoutePath(parseRoutePath('/*'), '/')).toEqual({ '*': '' })
    expect(matchRoutePath(parseRoutePath('/:id/*'), '/1/x/y')).toEqual({ id: '1', '*': 'x/y' })
  })
})

describe('decodePathValue', () => {
  it('decodes percent-encoding and rejects malformed values', () => {
    expect(decodePathValue('plain')).toBe('plain')
    expect(decodePathValue('a%20b%2Fc')).toBe('a b/c')
    expect(decodePathValue('%E0%A4%A')).toBeUndefined()
    expect(decodePathValue('%')).toBeUndefined()
  })
})

describe('compareRoutePaths', () => {
  it('orders static < param < wildcard, then by path', () => {
    const paths = ['/*', '/users/:id', '/users/me', '/users/*', '/users', '/a', '/users/:id/posts', '/users/me/x']
    const sorted = paths
      .map(path => parseRoutePath(path))
      .sort(compareRoutePaths)
      .map(route => route.path)
    expect(sorted).toEqual([
      '/a',
      '/users',
      '/users/me',
      '/users/me/x',
      '/users/:id',
      '/users/:id/posts',
      '/users/*',
      '/*',
    ])
  })

  it('returns 0 for identical paths', () => {
    expect(compareRoutePaths(parseRoutePath('/a/:b'), parseRoutePath('/a/:b'))).toBe(0)
  })
})

describe('adapter patterns', () => {
  it('translates to Fastify, Hono and regular expressions', () => {
    const route = parseRoutePath('/users/:id/files/*')
    expect(toFastifyPath(route)).toBe('/users/:id/files/*')
    expect(toHonoPath(route)).toBe('/users/:id/files/:__znight_wildcard{.*}')
    expect(toRegExpSource(route)).toBe('^\\/users\\/[^/]+\\/files\\/.*$')
    expect(toFastifyPath(parseRoutePath('/'))).toBe('/')
    expect(toHonoPath(parseRoutePath('/'))).toBe('/')
    expect(toRegExpSource(parseRoutePath('/'))).toBe('^\\/$')
  })

  it('escapes regular expression characters', () => {
    const source = toRegExpSource(parseRoutePath('/a.b/$x+'))
    expect(new RegExp(source).test('/a.b/$x+')).toBe(true)
    expect(new RegExp(source).test('/aXb/$x+')).toBe(false)
  })
})
