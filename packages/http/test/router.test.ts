import { parseRoutePath } from '../src/path.ts'
import { RouteTable } from '../src/router.ts'
import { describe, expect, it } from 'bun:test'

function table(routes: readonly [string, string][]): RouteTable<string> {
  const result = new RouteTable<string>()
  for (const [method, path] of routes) result.add(method, parseRoutePath(path), `${method} ${path}`)
  return result
}

describe('RouteTable', () => {
  const routes = table([
    ['GET', '/'],
    ['GET', '/users'],
    ['GET', '/users/me'],
    ['GET', '/users/:id'],
    ['DELETE', '/users/:id'],
    ['GET', '/users/:id/posts/:post'],
    ['GET', '/files/*'],
    ['GET', '/files/special'],
    ['POST', '/a/:x/c'],
    ['POST', '/a/b/:y'],
  ])

  it('finds static, param and wildcard routes', () => {
    expect(routes.find('GET', '/')).toBe('GET /')
    expect(routes.find('GET', '/users')).toBe('GET /users')
    expect(routes.find('GET', '/users/42')).toBe('GET /users/:id')
    expect(routes.find('GET', '/users/42/posts/7')).toBe('GET /users/:id/posts/:post')
    expect(routes.find('GET', '/files/a/b')).toBe('GET /files/*')
    expect(routes.find('GET', '/files/')).toBe('GET /files/*')
  })

  it('prefers static segments over params over wildcards', () => {
    expect(routes.find('GET', '/users/me')).toBe('GET /users/me')
    expect(routes.find('GET', '/files/special')).toBe('GET /files/special')
    expect(routes.find('POST', '/a/b/c')).toBe('POST /a/b/:y')
  })

  it('backtracks when the static branch has no route for the method', () => {
    expect(routes.find('DELETE', '/users/me')).toBe('DELETE /users/:id')
    expect(routes.find('POST', '/a/z/c')).toBe('POST /a/:x/c')
  })

  it('returns undefined for unmatched paths and methods', () => {
    expect(routes.find('GET', '/users/')).toBeUndefined()
    expect(routes.find('GET', '/files')).toBeUndefined()
    expect(routes.find('POST', '/users')).toBeUndefined()
    expect(routes.find('GET', '/nope')).toBeUndefined()
    expect(routes.find('GET', 'users')).toBeUndefined()
    expect(routes.find('GET', '/users//1')).toBeUndefined()
  })

  it('lists the allowed methods of a path', () => {
    expect(routes.allowedMethods('/users/42')).toEqual(['DELETE', 'GET'])
    expect(routes.allowedMethods('/users/me')).toEqual(['DELETE', 'GET'])
    expect(routes.allowedMethods('/')).toEqual(['GET'])
    expect(routes.allowedMethods('/files/x')).toEqual(['GET'])
    expect(routes.allowedMethods('/nope')).toEqual([])
    expect(routes.allowedMethods('nope')).toEqual([])
  })

  it('supports a root wildcard', () => {
    const catchAll = table([['GET', '/*']])
    expect(catchAll.find('GET', '/')).toBe('GET /*')
    expect(catchAll.find('GET', '/a/b')).toBe('GET /*')
    expect(catchAll.allowedMethods('/')).toEqual(['GET'])
  })

  it('reports duplicates (same method and shape) without replacing them', () => {
    const result = new RouteTable<string>()
    expect(result.add('GET', parseRoutePath('/users/:id'), 'first')).toBeUndefined()
    expect(result.add('GET', parseRoutePath('/users/:name'), 'second')).toBe('first')
    expect(result.add('GET', parseRoutePath('/files/*'), 'files')).toBeUndefined()
    expect(result.add('GET', parseRoutePath('/files/*'), 'again')).toBe('files')
    expect(result.find('GET', '/users/1')).toBe('first')
    expect(result.size).toBe(2)
  })
})
