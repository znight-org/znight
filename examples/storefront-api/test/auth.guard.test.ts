import type { HttpContext } from '@znight/http'

import { UnauthorizedException } from '@znight/http'
import { Logger } from '@znight/observability'
import { TestBed } from '@znight/testing'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { AuthGuard } from '../src/auth/auth.guard.js'
import { Credentials } from '../src/auth/credentials.js'
import { CurrentCustomer } from '../src/auth/current-customer.js'
import { AuthConfig } from '../src/config/auth.config.js'
import { ADMIN_KEY, ALICE_TOKEN, CATALOG_KEY } from './support/fixtures.js'
import { describe, expect, test as it } from 'bun:test'

/** The access decisions of the routes (the effective metadata holds one decision of the group). */
const PUBLIC = { public: true }
const CUSTOMER = { roles: ['customer'] }
const CATALOG = { roles: ['catalog'] }
const ADMIN = { roles: ['admin'] }

/** The part of the request context the guard reads: headers, client address and route metadata. */
function request(headers: Record<string, string>, meta: Record<string, unknown>): HttpContext {
  return {
    header: (name: string) => headers[name.toLowerCase()],
    ip: '203.0.113.7',
    route: { method: 'GET', path: '/carts/:id', controller: 'test', handler: 'test', meta },
  } as unknown as HttpContext
}

/**
 * TestBed builds the real guard and auto-mocks its direct dependencies. `Credentials` is provided
 * as a real instance instead, built from an `AuthConfig` (a plain class): the guard is tested with
 * the real verification. `Lazy<CurrentCustomer>` receives `{ get: () => mock }`.
 */
async function setup() {
  const config = Object.assign(new AuthConfig(), {
    customerTokens: { alice: ALICE_TOKEN },
    adminApiKey: ADMIN_KEY,
    catalogApiKey: CATALOG_KEY,
  })
  const { instance, mocks } = await TestBed.create(AuthGuard, {
    metadata,
    provide: [[Credentials, new Credentials(config)]],
  })
  return { guard: instance, customer: mocks.get(CurrentCustomer), logger: mocks.get(Logger) }
}

describe('AuthGuard', () => {
  it('lets @Public() routes through without credentials', async () => {
    const { guard, customer } = await setup()

    expect(guard.canActivate(request({}, PUBLIC))).toBe(true)
    expect(customer.authenticate).not.toHaveBeenCalled()
  })

  it('answers 401 without credentials, with the challenge of the expected scheme', async () => {
    const { guard } = await setup()

    const challenge = (meta: Record<string, unknown>): unknown => {
      const error = (() => {
        try {
          return guard.canActivate(request({}, meta))
        } catch (thrown) {
          return thrown
        }
      })()
      return error instanceof UnauthorizedException ? error.headers?.['www-authenticate'] : error
    }
    expect(challenge(CUSTOMER)).toBe('Bearer realm="storefront"')
    expect(challenge(ADMIN)).toBe('ApiKey header="x-api-key"')
  })

  it('authenticates a customer token and records the customer of the request', async () => {
    const { guard, customer } = await setup()

    expect(guard.canActivate(request({ authorization: `Bearer ${ALICE_TOKEN}` }, CUSTOMER))).toBe(true)
    expect(customer.authenticate).toHaveBeenCalledWith('alice')
  })

  it('answers 401 for an unknown token, and logs the client address (never the token)', async () => {
    const { guard, logger } = await setup()

    expect(() => guard.canActivate(request({ authorization: 'Bearer stolen' }, CUSTOMER))).toThrow(
      'Invalid bearer token',
    )
    expect(() => guard.canActivate(request({ authorization: `Basic ${ALICE_TOKEN}` }, CUSTOMER))).toThrow(
      'Invalid bearer token',
    )
    expect(logger.warn).toHaveBeenCalledWith('Invalid bearer token', { ip: '203.0.113.7', route: '/carts/:id' })
  })

  it('answers 401 for an unknown API key', async () => {
    const { guard, logger } = await setup()

    expect(() => guard.canActivate(request({ 'x-api-key': 'nope' }, ADMIN))).toThrow('Invalid API key')
    expect(logger.warn).toHaveBeenCalledWith('Invalid API key', { ip: '203.0.113.7', route: '/carts/:id' })
  })

  it('enforces @Roles: false answers 403', async () => {
    const { guard } = await setup()

    // the catalogue key manages products only
    expect(guard.canActivate(request({ 'x-api-key': CATALOG_KEY }, CATALOG))).toBe(true)
    expect(guard.canActivate(request({ 'x-api-key': CATALOG_KEY }, ADMIN))).toBe(false)
    // the admin key has every back-office role
    expect(guard.canActivate(request({ 'x-api-key': ADMIN_KEY }, CATALOG))).toBe(true)
    expect(guard.canActivate(request({ 'x-api-key': ADMIN_KEY }, ADMIN))).toBe(true)
    // customers and the back office do not share routes
    expect(guard.canActivate(request({ authorization: `Bearer ${ALICE_TOKEN}` }, ADMIN))).toBe(false)
    expect(guard.canActivate(request({ 'x-api-key': ADMIN_KEY }, CUSTOMER))).toBe(false)
  })

  it('denies a route without access decision, even to the administrator', async () => {
    const { guard } = await setup()

    // unreachable in practice: such a route fails the build (ZNIGHT023)
    expect(guard.canActivate(request({ 'x-api-key': ADMIN_KEY }, {}))).toBe(false)
  })
})

describe('Credentials', () => {
  const credentials = new Credentials(
    Object.assign(new AuthConfig(), { customerTokens: { alice: ALICE_TOKEN }, adminApiKey: ADMIN_KEY }),
  )

  it('verifies tokens and keys, and keeps the secrets out of the principal', () => {
    expect(credentials.verifyToken(ALICE_TOKEN)).toEqual({ id: 'alice', roles: ['customer'] })
    expect(credentials.verifyApiKey(ADMIN_KEY)).toEqual({ id: 'admin', roles: ['admin', 'catalog'] })
    // a token is not a key, and the catalogue key is optional (not configured here)
    expect(credentials.verifyApiKey(ALICE_TOKEN)).toBeUndefined()
    expect(credentials.verifyApiKey(CATALOG_KEY)).toBeUndefined()
    expect(credentials.verifyToken('')).toBeUndefined()
  })
})
