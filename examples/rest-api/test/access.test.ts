import type { ZnightMetadata } from '@znight/core'

import { HttpPlugin } from '@znight/http'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { createTestApp } from './support/app.js'
import { READER_KEY } from './support/fixtures.js'
import { describe, expect, test as it } from 'bun:test'

/** The access decision of a route, from its effective metadata. */
function describeAccess(meta: Readonly<Record<string, unknown>>): string {
  if (meta.public === true) return 'public'
  if (Array.isArray(meta.roles)) return `roles ${meta.roles.join(' | ')}`
  if (meta.authenticated === true) return 'authenticated'
  return 'NO DECISION'
}

/**
 * The metadata the compiler generates when `@Roles(['reader'])` on `BookController` is replaced by
 * `@Public()`: the controller's decision becomes `{ public: true }`, and the routes keep their own
 * (`@Roles(['admin'])` on the writes). Controller and route metadata are stored apart in the
 * generated module and combined by `HttpPlugin` at boot.
 */
function withPublicBookController(): ZnightMetadata {
  const http = metadata.extensions?.http
  if (http === undefined) throw new Error('no HTTP metadata')
  const controllers = http.controllers.map(controller =>
    controller.token.endsWith('#BookController') ? { ...controller, meta: { public: true } } : controller,
  )
  return { ...metadata, extensions: { ...metadata.extensions, http: { ...http, controllers } } }
}

describe('access decisions', () => {
  /**
   * Who can call what, as `HttpPlugin` registered it: the effective decision and the guard chain of
   * every route. A change of access shows up in the diff of this snapshot (`bun test -u` updates it
   * once the change is reviewed).
   */
  it('access matrix', async () => {
    await using app = await createTestApp()

    const matrix = app
      .get(HttpPlugin)
      .routes.filter(route => route.method !== 'HEAD')
      .map(route => `${route.method} ${route.path} → ${describeAccess(route.meta)} [${route.guards.join(', ')}]`)

    expect(matrix).toMatchSnapshot()
  })

  it('refuses to boot when no guard enforces the access decisions (ZNIGHT023)', async () => {
    // an entrypoint that forgets `guards: [AuthGuard]`: every route would be served without check
    const boot = createTestApp({ http: { guards: [] } })

    await expect(boot).rejects.toMatchObject({ code: 'ZNIGHT023' })
    // one error listing every unprotected route
    await expect(boot).rejects.toThrow('No guard enforces the required "access" group on 9 routes')
    await expect(boot).rejects.toThrow('GET /me (MeController.whoami)')
  })

  /**
   * Regression test of the fail-open combination: with route metadata merged key by key,
   * `@Public()` on the controller plus `@Roles(['admin'])` on a route gave
   * `{ public: true, roles: ['admin'] }`, and the guard, checking `public` first, served the admin
   * route to anyone. The decorators now form one "access" group: the route's decision replaces the
   * controller's.
   */
  it("serves a route with its own decision, not the controller's (the former fail-open)", async () => {
    await using app = await createTestApp({ metadata: withPublicBookController() })

    const remove = app.get(HttpPlugin).routes.find(route => route.method === 'DELETE' && route.path === '/books/:id')
    expect(remove?.meta).toEqual({ roles: ['admin'] })

    // the admin route is not public: 401 without key, 403 with the read-only key
    expect((await app.inject({ method: 'DELETE', url: '/books/1' })).status).toBe(401)
    expect((await app.inject({ method: 'DELETE', url: '/books/1', headers: { 'x-api-key': READER_KEY } })).status).toBe(
      403,
    )
    // the routes without a decision of their own take the controller's: public
    expect((await app.inject({ url: '/books' })).status).toBe(200)
  })
})
