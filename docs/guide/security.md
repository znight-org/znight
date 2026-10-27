---
description: Secure a Znight API - access decisions checked at build time and at boot, CORS, security headers and trusted proxies, and recipes for JWT/OIDC, API keys, policies, password hashing, rate limiting, webhook signatures and CSRF.
---

# Security

Znight has no authentication package, on purpose. Guards, route decorators and request-scoped
providers already express authentication and authorization, and the hard parts are better left to
audited code: [`jose`](https://github.com/panva/jose) for JWTs, `node:crypto` for hashes and
signatures. What only the framework can guarantee is built into `@znight/http`:

| Guarantee                                                        | Feature                                    | Checked                                                 |
| ---------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------- |
| One access decision per route, and the nearest one wins          | [Route decision groups](#route-decisions)  | build ([`ZNIGHT005`](/reference/error-codes#znight005)) |
| Every route has an access decision                               | `required` groups                          | build ([`ZNIGHT023`](/reference/error-codes#znight023)) |
| Every decision is enforced by a guard                            | `static enforces` on guards                | boot ([`ZNIGHT023`](/reference/error-codes#znight023))  |
| Preflights answered before guards, the same way on every adapter | [`cors`](#cors-headers-and-proxies) option | boot (options)                                          |
| Safe response headers                                            | `securityHeaders` option, on by default    | boot (options)                                          |
| Correct `ctx.ip` and `ctx.protocol` behind load balancers        | `trustProxy` option                        | boot (options)                                          |

Everything else is a **recipe**: code you copy into your application, adapt and own.

::: info The secure-api example
The recipes of this page are the source files of the `examples/secure-api` application (a Notes API
on the built-in node adapter, running on Node.js 24 and Bun), released with the next set of
examples. Its tests are the tests of the recipes: every access rule, token error, CORS case and
signature check of this page is exercised there.
:::

## Access control with route decisions {#route-decisions}

### Declare the access decision

An **access decision** is made of route decorators that are alternatives: a route is public, or
needs an authenticated caller, or needs a role. Give them the same `group`, and make the group
`required`:

```ts [src/auth/access.ts]
import { createRouteDecorator } from '@znight/http'

export type Role = 'admin' | 'editor' | 'reader'

/** No authentication. */
export const Public = createRouteDecorator('public', { group: 'access', required: true })
/** Any authenticated caller. */
export const Authenticated = createRouteDecorator('authenticated', { group: 'access', required: true })
/** An authenticated caller holding at least one of the roles. */
export const Roles = createRouteDecorator<readonly Role[]>('roles', { group: 'access', required: true })
```

The options are read by the compiler: they must be static (literals or constants), and every
definition of a key must use the same options ([`ZNIGHT005`](/reference/error-codes#znight005)).

### Apply decisions

A decision on the controller is the default of its routes. A decision on a route **replaces** the
controller's decision of the same group:

```ts
@Controller('/notes')
@Authenticated() // every route of the controller needs an authenticated caller...
export class NoteController {
  @Get()
  list() {}

  @Post()
  @Roles(['editor']) // ...this one needs the editor role instead...
  create() {}

  @Get('/shared/:token')
  @Public() // ...and this one is public
  shared() {}
}
```

- **The nearest decision wins.** The effective metadata of a route (`ctx.route.meta`, what
  `Roles.get(ctx)` reads) is made of the controller's entries whose group the route does not decide,
  then the route's entries. `@Public()` on a controller and `@Roles(['admin'])` on one of its routes
  give `{ roles: ['admin'] }`: that route is **not** public.
- **One decision per group and target.** `@Public() @Roles(['admin'])` on the same method (or class)
  is a build error:

  ```txt
  ✗ ZNIGHT005: @Roles sets the "access" decision of NoteController.remove, already set by @Public on the same target
    = hint: Keep one of @Public, @Roles: the decorators of the "access" group are alternatives
  ```

- A route decorator created without `group` is its own group, as before: the route value wins over
  the controller value, key by key.

### Every route has a decision, checked at build time

A route with no decision of a required group, neither on itself nor on its controller, fails
`znight build`, `znight generate` and the Bun preload:

```txt
✗ ZNIGHT023: Route DELETE /notes/:id (NoteController.remove) has no "access" decision
  --> src/notes/note.controller.ts:41:3
  = hint: Add @Public(), @Authenticated() or @Roles(...) to the route or to NoteController
  = related: The "access" group is required (src/auth/access.ts:6:14)
```

The check covers every route as soon as the group is defined in your sources, even before any of
its decorators is applied: adding `access.ts` to an existing application lists every route that
needs a decision. Deny by default is a build error, not a pentest finding.

### Every decision is enforced, checked at boot

A decision does nothing by itself: a guard must read it. The guard declares the decorators whose
decisions it enforces with a static `enforces` array:

```ts [src/auth/auth.guard.ts]
import { Injectable, type Lazy } from '@znight/core'
import type { CanActivate, HttpContext } from '@znight/http'

import { Authenticated, Public, Roles } from './access.js'
import { bearerToken, TokenVerifier } from './token-verifier.js'
import type { CurrentUser } from './current-user.js'

@Injectable()
export class AuthGuard implements CanActivate {
  /** Read by HttpPlugin at boot: every route needs a guard enforcing the "access" group. */
  static readonly enforces = [Public, Authenticated, Roles]

  constructor(
    private readonly tokens: TokenVerifier,
    private readonly user: Lazy<CurrentUser>,
  ) {}

  async canActivate(ctx: HttpContext): Promise<boolean> {
    if (Public.get(ctx)) return true
    const principal = await this.tokens.verify(bearerToken(ctx)) // 401 + WWW-Authenticate
    this.user.get().authenticate(principal)
    const roles = Roles.get(ctx)
    if (roles !== undefined) return roles.some(role => principal.roles.includes(role)) // false → 403
    return Authenticated.get(ctx) === true // no decision: denied (unreachable with a required group)
  }
}
```

Register it **globally**, so that it runs before the controller and route guards:
`HttpPlugin.configure({ guards: [AuthGuard] })`. When `HttpPlugin` registers the routes, every
route whose decision belongs to a required group (or to a group some guard enforces) must have a
guard enforcing that group in its chain. Otherwise the boot fails with one error listing every
route, which catches a forgotten `guards: [AuthGuard]` in a second entrypoint, a worker or a test:

```txt
ZNIGHT023: HttpPlugin: No guard enforces the required "access" group on 9 routes: GET /notes (NoteController.list), POST /notes (NoteController.create), ...
  hint: Register a guard declaring `static enforces` with the decorators of the "access" group (authenticated, public, roles), e.g. HttpPlugin.configure({ guards: [AuthGuard] })
```

- The `enforces` that counts is the one of the compiled guard class (or of the class of a global
  guard instance): a guard replaced through `overrides` in a test keeps its declaration.
- A test that deliberately runs without guards sets `enforcement: 'warn'` on the plugin (one warning
  per group instead of the error). Do not use it in an application.
- Routes served by other plugins (the OpenAPI document, for example) take their decisions from
  their options, `meta: [Public.meta()]`, and are checked the same way.

Keep the plugin configuration in one module, imported by `main.ts` and by the tests, so that every
entrypoint enforces the same rules:

```ts [src/http.ts]
import { HttpPlugin } from '@znight/http'

import { AuthGuard } from './auth/auth.guard.js'
import { CorsConfig } from './config/cors.config.js'
import { ServerConfig } from './config/server.config.js'
import { RateLimitGuard } from './security/rate-limit.js'

/** A new plugin instance per application (a plugin instance serves one application at a time). */
export function httpPlugin(): HttpPlugin {
  return HttpPlugin.configure(container => ({
    port: container.get(ServerConfig).port,
    guards: [AuthGuard, RateLimitGuard], // AuthGuard first: the rate limit keys on the caller
    cors: { origin: container.get(CorsConfig).origins },
    trustProxy: ['loopback', 'private'],
  }))
}
```

### Other decisions

Groups are not about access only. Any route decorator can be a decision of its own (`@RateLimit`,
`@ApiVersion`, `@Tenant`...), with a guard that declares it in `enforces`: a route that uses the
decorator without the guard in its chain then fails the boot. A group does not have to be
`required`; see [rate limiting](#rate-limiting).

## Authentication

### JWT and OIDC resource server {#jwt}

An API that receives access tokens from an identity provider (Auth0, Keycloak, Entra ID, Cognito,
Zitadel...) verifies them with [`jose`](https://github.com/panva/jose): `npm install jose`.

```ts [src/config/auth.config.ts]
import { Config, Env, Secret } from '@znight/config'

@Config('auth')
export class AuthConfig {
  /** The `iss` of the tokens: `https://id.example.com/`. */
  @Env('AUTH_ISSUER')
  issuer!: string

  /** The `aud` this API accepts: `https://api.example.com`. */
  @Env('AUTH_AUDIENCE')
  audience!: string

  /** The JSON Web Key Set of the identity provider (`<issuer>/.well-known/jwks.json`). */
  @Env('AUTH_JWKS_URL')
  jwksUrl!: string

  /** Key of the export client (see API keys). */
  @Secret('EXPORT_API_KEY')
  exportApiKey?: string
}
```

```ts [src/auth/jwks-keys.ts]
import { Injectable } from '@znight/core'
import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose'

import { AuthConfig } from '../config/auth.config.js'

/** The verification keys. A provider of its own, so that tests replace it with a local key set. */
@Injectable()
export class JwksKeys {
  readonly getKey: JWTVerifyGetKey

  constructor(config: AuthConfig) {
    // built once: the key set is cached and refreshed when an unknown `kid` shows up
    this.getKey = createRemoteJWKSet(new URL(config.jwksUrl), {
      cooldownDuration: 30_000, // at most one refetch every 30 s, whatever the tokens claim
      cacheMaxAge: 600_000, // refetch at least every 10 minutes (key rotation)
    })
  }
}
```

```ts [src/auth/token-verifier.ts]
import { Injectable } from '@znight/core'
import { type HttpContext, HttpException, ServiceUnavailableException, UnauthorizedException } from '@znight/http'
import { errors, type JWTPayload, jwtVerify } from 'jose'

import { AuthConfig } from '../config/auth.config.js'
import type { Role } from './access.js'
import { JwksKeys } from './jwks-keys.js'

export interface Principal {
  readonly id: string
  readonly roles: readonly Role[]
  readonly via: 'token' | 'api-key'
}

export const BEARER_CHALLENGE = 'Bearer realm="api"'

/** The token of an `Authorization: Bearer <token>` header (RFC 6750), or `undefined`. */
export function bearerToken(ctx: HttpContext): string | undefined {
  const match = /^Bearer +([A-Za-z0-9\-._~+/]+=*)$/i.exec(ctx.header('authorization') ?? '')
  return match?.[1]
}

@Injectable()
export class TokenVerifier {
  constructor(
    private readonly config: AuthConfig,
    private readonly keys: JwksKeys,
  ) {}

  async verify(token: string | undefined): Promise<Principal> {
    if (token === undefined) {
      throw new UnauthorizedException('Authentication required', undefined, {
        headers: { 'www-authenticate': BEARER_CHALLENGE },
      })
    }
    try {
      const { payload } = await jwtVerify(token, this.keys.getKey, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: ['RS256'], // pinned: what the identity provider signs with (never 'none', never HS* here)
        clockTolerance: 30, // seconds of clock skew
        requiredClaims: ['sub', 'exp'],
      })
      return toPrincipal(payload)
    } catch (error) {
      throw toHttpError(error)
    }
  }
}

const ROLES: ReadonlySet<string> = new Set<Role>(['admin', 'editor', 'reader'])

function toPrincipal(payload: JWTPayload): Principal {
  const claim = payload['roles']
  const roles = Array.isArray(claim) ? claim.filter((role): role is Role => ROLES.has(role)) : []
  return { id: payload.sub as string, roles, via: 'token' }
}

/** What the token is to blame for answers 401; an unavailable key source answers 503. */
function toHttpError(error: unknown): HttpException {
  const invalidToken =
    error instanceof errors.JWTClaimValidationFailed || // expired, not yet valid, wrong iss / aud, missing claim
    error instanceof errors.JWTInvalid ||
    error instanceof errors.JWSInvalid ||
    error instanceof errors.JWSSignatureVerificationFailed ||
    error instanceof errors.JWKSNoMatchingKey || // unknown kid
    error instanceof errors.JOSEAlgNotAllowed ||
    error instanceof errors.JOSENotSupported
  if (invalidToken) {
    return new UnauthorizedException('Invalid token', undefined, {
      headers: { 'www-authenticate': `${BEARER_CHALLENGE}, error="invalid_token"` },
    })
  }
  // JWKSTimeout, a failed fetch, a non-200 or malformed key set: the caller is not to blame
  return new ServiceUnavailableException('Token verification unavailable', undefined, {
    headers: { 'retry-after': '5' },
    cause: error,
  })
}
```

- **Pin everything**: `algorithms`, `issuer` and `audience`. A token of another API of the same
  identity provider must not open this one.
- **Challenges** follow RFC 6750: no token gives `401` with `WWW-Authenticate: Bearer realm="api"`,
  an invalid one adds `error="invalid_token"`. A role the caller lacks is a `403` (the guard returns
  `false`).
- **An unreachable identity provider is a `503`**, never a `401`: clients would otherwise discard
  valid tokens and send their users to log in again.
- Roles come from a claim (`roles` here; `realm_access.roles` on Keycloak, `cognito:groups` on
  Cognito, `permissions` on Auth0): keep only the values your application knows.

### API keys {#api-keys}

Machine clients often use a static key. Keep only its SHA-256 digest and compare digests in constant
time:

```ts [src/auth/api-keys.ts]
import { createHash, timingSafeEqual } from 'node:crypto'
import { Injectable } from '@znight/core'

import { AuthConfig } from '../config/auth.config.js'
import type { Principal } from './token-verifier.js'

export const API_KEY_HEADER = 'x-api-key'
export const API_KEY_CHALLENGE = `ApiKey header="${API_KEY_HEADER}"`

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest()

@Injectable()
export class ApiKeys {
  readonly #keys: readonly { readonly digest: Buffer; readonly principal: Principal }[]

  constructor(config: AuthConfig) {
    // one key per client, so that each can be revoked alone
    this.#keys = config.exportApiKey
      ? [{ digest: sha256(config.exportApiKey), principal: { id: 'export-client', roles: ['admin'], via: 'api-key' } }]
      : []
  }

  identify(key: string): Principal | undefined {
    const digest = sha256(key) // fixed length: timingSafeEqual never throws, the key length does not leak
    let found: Principal | undefined
    for (const entry of this.#keys) if (timingSafeEqual(entry.digest, digest)) found = entry.principal // no early exit
    return found
  }
}
```

Load the keys with [`@Secret`](/packages/config) (masked in logs and errors; Vault and AWS Secrets
Manager loaders available), give each client its own key so that it can be revoked alone, and send
`WWW-Authenticate: ApiKey header="x-api-key"` with the `401`.

### Several strategies {#several-strategies}

When an API accepts both, try the bearer token first, then the API key. The first strategy that
applies decides, and a `401` lists every challenge:

```ts [src/auth/authenticator.ts]
import { Injectable } from '@znight/core'
import { type HttpContext, UnauthorizedException } from '@znight/http'

import { API_KEY_CHALLENGE, API_KEY_HEADER, ApiKeys } from './api-keys.js'
import { BEARER_CHALLENGE, bearerToken, type Principal, TokenVerifier } from './token-verifier.js'

@Injectable()
export class Authenticator {
  constructor(
    private readonly tokens: TokenVerifier,
    private readonly apiKeys: ApiKeys,
  ) {}

  async authenticate(ctx: HttpContext): Promise<Principal> {
    const token = bearerToken(ctx)
    if (token !== undefined) return this.tokens.verify(token) // 401 invalid_token, or 503
    const key = ctx.header(API_KEY_HEADER)
    const principal = key === undefined ? undefined : this.apiKeys.identify(key)
    if (principal !== undefined) return principal
    throw new UnauthorizedException(key === undefined ? 'Authentication required' : 'Invalid API key', undefined, {
      headers: { 'www-authenticate': [BEARER_CHALLENGE, API_KEY_CHALLENGE] },
    })
  }
}
```

`AuthGuard` then calls `this.authenticator.authenticate(ctx)` instead of `this.tokens.verify(...)`.

### The current user {#current-user}

Store the caller in a **request-scoped** provider filled by the guard, and read it anywhere during
the request:

```ts [src/auth/current-user.ts]
import { Injectable } from '@znight/core'
import { UnauthorizedException } from '@znight/http'

import type { Principal } from './token-verifier.js'

/** One instance per request, disposed with it. */
@Injectable({ scope: 'request' })
export class CurrentUser {
  #principal: Principal | undefined

  /** Called by AuthGuard once the caller is authenticated. */
  authenticate(principal: Principal): void {
    this.#principal = principal
  }

  get isAuthenticated(): boolean {
    return this.#principal !== undefined
  }

  /** The caller; 401 on a public route called anonymously. */
  get principal(): Principal {
    if (this.#principal === undefined) throw new UnauthorizedException('Authentication required')
    return this.#principal
  }
}
```

```ts
@Controller('/me')
@Authenticated()
export class MeController {
  constructor(private readonly user: Lazy<CurrentUser>) {}

  @Get()
  whoami(): Principal {
    return this.user.get().principal
  }
}
```

Controllers, guards and services are singletons: they inject `Lazy<CurrentUser>` and call `get()`
while handling a request. Injecting `CurrentUser` directly into a singleton is a build error
([`ZNIGHT003`](/reference/error-codes#znight003)): the singleton would keep the first caller
forever. Unlike `ctx.state.get('user')`, the type is checked and every consumer is visible in the
dependency graph.

## Policies are guards {#policies}

Authorization rules that need data (ownership, tenancy, sharing) are guards applied with
`@UseGuard`. The policy, its repository and their scopes are bound and checked at build time like
any provider:

```ts [src/notes/note-owner.policy.ts]
import { Injectable, type Lazy } from '@znight/core'
import { type CanActivate, type HttpContext, NotFoundException } from '@znight/http'

import { CurrentUser } from '../auth/current-user.js'
import { NoteRepository } from './note.repository.js'

/** The note of the `:id` parameter belongs to the caller (admins read every note). */
@Injectable()
export class NoteOwnerPolicy implements CanActivate {
  constructor(
    private readonly notes: NoteRepository,
    private readonly user: Lazy<CurrentUser>,
  ) {}

  async canActivate(ctx: HttpContext): Promise<boolean> {
    const id = ctx.params['id'] ?? ''
    const note = await this.notes.find(id)
    const { principal } = this.user.get()
    if (note === undefined || (note.ownerId !== principal.id && !principal.roles.includes('admin'))) {
      // 404, not 403: do not tell other users that the note exists
      throw new NotFoundException(`Note ${id} not found`)
    }
    return true
  }
}
```

```ts
@Controller('/notes')
@Authenticated()
export class NoteController {
  @Get('/:id')
  @UseGuard(NoteOwnerPolicy) // runs after AuthGuard (global guards first)
  get(@Param('id') id: string) {}
}
```

- Answer `404` rather than `403` for resources the caller should not know about.
- A request-scoped policy is possible, but then the controller using it must be request-scoped too
  ([`ZNIGHT003`](/reference/error-codes#znight003)): prefer a singleton policy with
  `Lazy<CurrentUser>`, as above.
- Rules inside services (a background job has no HTTP context) are explicit domain checks, or a
  method interceptor ([`@Intercept`](/guide/aop)) when the same rule wraps many methods.

## Password hashing {#password-hashing}

When the application signs its users in itself (most APIs leave that to an identity provider), hash
passwords with scrypt from `node:crypto`, with the parameters recommended by OWASP:

```ts [src/security/password-hasher.ts]
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { Injectable } from '@znight/core'

interface Params {
  readonly ln: number // log2 of the cost N
  readonly r: number
  readonly p: number
}

const CURRENT: Params = { ln: 17, r: 8, p: 1 } // N = 2^17: 128 MiB and ~100-300 ms per hash
const KEY_LENGTH = 32
const MAX_CONCURRENT = 4 // the libuv thread pool size: 4 hashes at once use 512 MiB
const PHC = /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64').replace(/=+$/, '')

@Injectable()
export class PasswordHasher {
  #running = 0
  readonly #waiting: (() => void)[] = []

  /** `$scrypt$ln=17,r=8,p=1$<salt>$<hash>` (PHC string format, base64 without padding). */
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16)
    const key = await this.#derive(password, salt, CURRENT)
    return `$scrypt$ln=${CURRENT.ln},r=${CURRENT.r},p=${CURRENT.p}$${b64(salt)}$${b64(key)}`
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const match = PHC.exec(stored)
    if (match === null) return false
    const [, ln, r, p, salt, hash] = match
    const expected = Buffer.from(hash as string, 'base64')
    const params = { ln: Number(ln), r: Number(r), p: Number(p) }
    if (params.ln > 20 || expected.length !== KEY_LENGTH) return false // refuse absurd stored parameters
    const key = await this.#derive(password, Buffer.from(salt as string, 'base64'), params)
    return timingSafeEqual(key, expected)
  }

  /** True when the stored hash uses older parameters: hash the password again after a successful sign-in. */
  needsRehash(stored: string): boolean {
    const match = PHC.exec(stored)
    return (
      match === null ||
      Number(match[1]) < CURRENT.ln ||
      Number(match[2]) !== CURRENT.r ||
      Number(match[3]) !== CURRENT.p
    )
  }

  #derive(password: string, salt: Uint8Array, { ln, r, p }: Params): Promise<Buffer> {
    return this.#limit(
      () =>
        new Promise<Buffer>((resolve, reject) => {
          const N = 2 ** ln
          // maxmem: scrypt needs 128 * N * r bytes; the default (32 MiB) is too small for N = 2^17
          const options = { N, r, p, maxmem: 2 * 128 * N * r }
          scrypt(password.normalize('NFC'), salt, KEY_LENGTH, options, (error, key) =>
            error ? reject(error) : resolve(key),
          )
        }),
    )
  }

  /** Bounds the hashes running at once: each one holds 128 MiB and a thread of the pool. */
  async #limit<T>(task: () => Promise<T>): Promise<T> {
    if (this.#running < MAX_CONCURRENT) this.#running++
    else await new Promise<void>(resolve => this.#waiting.push(resolve)) // the slot is handed over
    try {
      return await task()
    } finally {
      const next = this.#waiting.shift()
      if (next === undefined) this.#running--
      else next()
    }
  }
}
```

- Store the whole PHC string: it carries the parameters, so they can be raised later
  (`needsRehash`) without breaking existing hashes.
- Limit the password length in the sign-in schema (`z.string().min(12).max(1024)`) and rate limit
  the sign-in route: each attempt costs 128 MiB of memory and a few hundred milliseconds of CPU.
- Lower-memory alternatives with the same strength (OWASP): N = 2^16 with r = 8 and p = 2, or
  N = 2^15 with p = 3. Argon2id works too: `Bun.password` on Bun, the `argon2` package on Node.js.

## Rate limiting {#rate-limiting}

Limits belong at the edge first (load balancer, API gateway, WAF). In the application, a route
decorator and a guard give per-route limits keyed by caller, with
[`rate-limiter-flexible`](https://github.com/animir/node-rate-limiter-flexible):

```ts [src/security/rate-limit.ts]
import { Injectable, type Lazy } from '@znight/core'
import { type CanActivate, createRouteDecorator, type HttpContext, TooManyRequestsException } from '@znight/http'
import { type RateLimiterAbstract, RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible'

import { CurrentUser } from '../auth/current-user.js'

/** `points` requests per `duration` seconds. */
export interface RateLimitPolicy {
  readonly points: number
  readonly duration: number
}

/** `@RateLimit({ points: 30, duration: 60 })` on a route or a controller. */
export const RateLimit = createRouteDecorator<RateLimitPolicy>('rateLimit')

@Injectable()
export class RateLimitGuard implements CanActivate {
  /** A route with @RateLimit needs this guard in its chain (checked at boot). */
  static readonly enforces = [RateLimit]

  readonly #limiters = new Map<string, RateLimiterAbstract>()

  constructor(private readonly user: Lazy<CurrentUser>) {}

  async canActivate(ctx: HttpContext): Promise<boolean> {
    const policy = RateLimit.get(ctx)
    if (policy === undefined || ctx.route === undefined) return true // no limit on this route
    const user = this.user.get()
    // the caller when known, else the client address (correct behind a proxy only with trustProxy)
    const key = user.isAuthenticated ? `user:${user.principal.id}` : `ip:${ctx.ip ?? 'unknown'}`
    try {
      await this.#limiter(`${ctx.route.method} ${ctx.route.path}`, policy).consume(key)
      return true
    } catch (rejection) {
      if (!(rejection instanceof RateLimiterRes)) throw rejection // the store failed: 500
      throw new TooManyRequestsException('Too many requests', undefined, {
        headers: { 'retry-after': String(Math.ceil(rejection.msBeforeNext / 1000)) },
      })
    }
  }

  /** One budget per route. */
  #limiter(route: string, { points, duration }: RateLimitPolicy): RateLimiterAbstract {
    let limiter = this.#limiters.get(route)
    if (limiter === undefined) {
      limiter = new RateLimiterMemory({ keyPrefix: route, points, duration })
      this.#limiters.set(route, limiter)
    }
    return limiter
  }
}
```

- `RateLimit` is a decision group of its own (not required): routes without it are not limited.
  Because `RateLimitGuard` enforces it, a route that uses `@RateLimit` without the guard in its chain
  fails the boot instead of being silently unlimited.
- The memory store is per process. With several instances, use `RateLimiterRedis` (or another
  shared store of the library) so that the limit holds across the fleet.
- Behind a load balancer, `ctx.ip` is the load balancer unless `trustProxy` is set: every anonymous
  client would share one budget.

## Webhook signatures {#webhooks}

A webhook sender signs the exact bytes of the body. The route is public (there is no user) and a
guard checks the signature before anything parses the body:

```ts [src/security/webhook-signature.guard.ts]
import { createHmac, timingSafeEqual } from 'node:crypto'
import { Injectable } from '@znight/core'
import { type CanActivate, type HttpContext, UnauthorizedException } from '@znight/http'

import { WebhookConfig } from '../config/webhook.config.js'

const TOLERANCE_SECONDS = 300

/** `x-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">` */
@Injectable()
export class WebhookSignatureGuard implements CanActivate {
  constructor(private readonly config: WebhookConfig) {}

  async canActivate(ctx: HttpContext): Promise<boolean> {
    const fields = new Map<string, string>()
    for (const part of (ctx.header('x-signature') ?? '').split(',')) {
      const separator = part.indexOf('=')
      if (separator > 0) fields.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim())
    }
    const timestamp = Number(fields.get('t'))
    const signature = Buffer.from(fields.get('v1') ?? '', 'hex')
    if (!Number.isSafeInteger(timestamp) || signature.length === 0) throw new UnauthorizedException('Missing signature')
    if (Math.abs(Date.now() / 1000 - timestamp) > TOLERANCE_SECONDS) throw new UnauthorizedException('Stale signature')

    const body = await ctx.rawBody() // the exact bytes; @Body() parses them afterwards
    const expected = createHmac('sha256', this.config.secret).update(`${timestamp}.`).update(body).digest()
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
      throw new UnauthorizedException('Invalid signature')
    }
    return true
  }
}
```

```ts
@Controller('/webhooks')
@Public() // no user: the signature authenticates the sender
export class WebhookController {
  @Post('/billing')
  @UseGuard(WebhookSignatureGuard)
  @RateLimit({ points: 120, duration: 60 })
  @HttpCode(204)
  async billing(@Body(BillingEvent) event: BillingEvent) {}
}
```

- Sign the **raw bytes**: re-serialising a parsed body changes key order and whitespace.
  `ctx.rawBody()` keeps the bytes for the `@Body()` parameter, which is parsed after the guards.
- The timestamp is part of the signed text and must be recent, so a captured request cannot be
  replayed later. Store the event ids you processed when a replay within the window matters.
- Compare with `timingSafeEqual` after a length check (it throws on different lengths).

## CSRF {#csrf}

APIs authenticated with bearer tokens or API keys need nothing: browsers never attach these headers
by themselves. CSRF only concerns **cookie authentication**:

- set the session cookie with `SameSite=Lax` or `Strict` (the defaults of
  [`ctx.setCookie()`](/packages/http#cookies) are `Path=/; Secure; HttpOnly; SameSite=Lax`);
- and reject cross-site requests with an unsafe method, with a global guard:

```ts [src/security/csrf.guard.ts]
import { Injectable } from '@znight/core'
import type { CanActivate, HttpContext } from '@znight/http'

import { CorsConfig } from '../config/cors.config.js'

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly cors: CorsConfig) {}

  canActivate(ctx: HttpContext): boolean {
    if (SAFE_METHODS.has(ctx.method)) return true // safe methods must not change state
    const site = ctx.header('sec-fetch-site') // sent by every current browser
    if (site !== undefined) return site !== 'cross-site' // false → 403
    // older browsers: the origin must be one of ours; no origin at all is a non-browser client
    const origin = ctx.header('origin')
    return origin === undefined || this.cors.origins.includes(origin)
  }
}
```

`same-site` requests come from your other subdomains: when you do not trust every one of them,
accept only `same-origin` and `none` (a navigation typed by the user). CORS does not replace this
guard: a request from a denied origin is still served, only its page cannot read the answer.

## CORS, headers and proxies {#cors-headers-and-proxies}

```ts
HttpPlugin.configure({
  cors: {
    origin: ['https://app.example.com', /^https:\/\/[a-z0-9-]+\.preview\.example\.com$/],
    credentials: true, // cookies or Authorization from the browser
  },
  securityHeaders: { hsts: true, cacheControl: 'no-store' }, // merged over the defaults
  trustProxy: 1, // one load balancer in front of the instances
})
```

- **CORS** preflights are answered by the pipeline, before routing and guards, identically on the
  four adapters; replies to allowed origins (errors included) get the CORS headers. Details:
  [CORS](/packages/http#cors).
- **Security headers** are on by default (`content-security-policy: default-src 'none';
  frame-ancestors 'none'`, `x-frame-options: DENY`, `x-content-type-options: nosniff`,
  `referrer-policy: no-referrer`), and lose to any header your code sets. Details:
  [security headers](/packages/http#security-headers).
- **`trustProxy`** gives the real `ctx.ip` and `ctx.protocol` behind proxies, as a number of hops or
  the addresses of the proxies. Details: [behind a proxy](/packages/http#behind-a-proxy).

Common mistakes:

| Mistake                                                          | Consequence                                                                    | Fix                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `origin: 'https://app.example.com/'` (path or trailing slash)    | Never matches what browsers send: refused at boot (ZNIGHT005)                  | Write the origin exactly: scheme, host, port when not the default                |
| `origin: '*'` with `credentials: true`                           | Browsers refuse it: refused at boot                                            | List the origins                                                                 |
| `/example\.com$/` or `/^https:\/\/a\|b$/`                        | `evil-example.com` matches: refused at boot (anchors around every alternative) | `/^https:\/\/(?:a\|b)\.example\.com$/`                                           |
| Treating CORS as access control                                  | `curl` and servers ignore CORS                                                 | Guards decide access; CORS only decides what a page may read                     |
| The `cors` option and a CORS middleware (Fastify, Express, Hono) | Duplicated or contradictory headers                                            | Use one of them                                                                  |
| `trustProxy: true`                                               | Any client chooses its `ctx.ip`: refused at boot                               | A hop count, or the proxies' addresses (`['loopback', 'private']`)               |
| No `trustProxy` behind a load balancer                           | `ctx.ip` is the load balancer: IP limits and audit logs are wrong              | Set it to match the infrastructure                                               |
| An HTML route with the default CSP                               | The page renders without scripts and styles                                    | Set its own `@Header('content-security-policy', ...)`                            |
| HSTS from the application                                        | Usually set twice, or on plain `http://`                                       | Prefer the TLS terminator; `hsts: true` only when the application terminates TLS |

## Secrets and logs {#secrets}

- Read secrets with [`@Secret`](/packages/config) (masked whenever the config object is logged,
  serialised or printed in an error) and load them from Vault or AWS Secrets Manager with the
  `@znight/config` loaders.
- Never log credentials. Znight's request logs do not include headers; when you log headers or
  request objects yourself, redact them:
  `ObservabilityPlugin.configure({ logging: { redact: ['*.headers.authorization', '*.headers.cookie', '*.headers["x-api-key"]'] } })`.
- Rotate keys without downtime: accept the next and the current key during the rotation window, as
  the API key list and the signed cookie secrets do.

## Auditing access {#access-audit}

`HttpPlugin.routes` lists every route with its **effective** metadata and its guard chain. Snapshot
it, and every pull request that changes who can call what shows up in the diff:

```ts [test/access-matrix.test.ts]
import { expect, test } from 'bun:test'
import { HttpPlugin } from '@znight/http'

import { createTestApp } from './support/app.js'

function describeAccess(meta: Readonly<Record<string, unknown>>): string {
  if (meta['public'] === true) return 'public'
  if (Array.isArray(meta['roles'])) return `roles ${meta['roles'].join(' | ')}`
  if (meta['authenticated'] === true) return 'authenticated'
  return 'NO DECISION'
}

test('access matrix', async () => {
  await using app = await createTestApp()
  const matrix = app
    .get(HttpPlugin)
    .routes.filter(route => route.method !== 'HEAD')
    .map(route => `${route.method} ${route.path} → ${describeAccess(route.meta)} [${route.guards.join(', ')}]`)
  expect(matrix).toMatchSnapshot()
})
```

```txt
GET /me → authenticated [AuthGuard, RateLimitGuard]
GET /notes → authenticated [AuthGuard, RateLimitGuard]
POST /notes → roles editor [AuthGuard, RateLimitGuard]
GET /notes/:id → authenticated [AuthGuard, RateLimitGuard, NoteOwnerPolicy]
POST /webhooks/billing → public [AuthGuard, RateLimitGuard, WebhookSignatureGuard]
```

## Testing authenticated routes {#testing}

Keep the real guard and mint real tokens with a test key pair: the tests then cover the token
checks too. Only the key source is replaced:

```ts [test/support/tokens.ts]
import { exportJWK, generateKeyPair, type JSONWebKeySet, SignJWT } from 'jose'

export const ISSUER = 'https://id.test/'
export const AUDIENCE = 'https://api.test'

const { publicKey, privateKey } = await generateKeyPair('RS256')
export const jwks: JSONWebKeySet = { keys: [{ ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' }] }

export interface TestClaims {
  readonly sub: string
  readonly roles?: string[]
  readonly aud?: string
  /** `'5m'` (default), or an absolute time in Unix seconds (in the past for an expired token). */
  readonly exp?: string | number
}

export function mintToken(claims: TestClaims): Promise<string> {
  return new SignJWT({ roles: claims.roles ?? [] })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(claims.aud ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(claims.exp ?? '5m')
    .sign(privateKey)
}
```

```ts [test/support/app.ts]
import { ConfigPlugin, inline } from '@znight/config'
import { TestApp } from '@znight/testing'
import { createLocalJWKSet } from 'jose'

import { __ZNIGHT_METADATA__ as metadata } from '../../src/.znight/container.generated.js'
import { JwksKeys } from '../../src/auth/jwks-keys.js'
import { httpPlugin } from '../../src/http.js'
import { AUDIENCE, ISSUER, jwks } from './tokens.js'

export function createTestApp(): Promise<TestApp> {
  return TestApp.create({
    metadata,
    plugins: [
      ConfigPlugin.configure({
        loaders: [
          inline({ AUTH_ISSUER: ISSUER, AUTH_AUDIENCE: AUDIENCE, AUTH_JWKS_URL: 'https://id.test/jwks', PORT: '0' }),
        ],
      }),
      httpPlugin(), // the guards of main.ts: the boot check passes, and the real AuthGuard runs
    ],
    overrides: [[JwksKeys, { getKey: createLocalJWKSet(jwks) }]],
  })
}
```

```ts [test/notes.http.test.ts]
import { expect, test } from 'bun:test'

import { createTestApp } from './support/app.js'
import { mintToken } from './support/tokens.js'

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

test('only editors create notes', async () => {
  await using app = await createTestApp()
  const note = { text: 'hi' }

  const anonymous = await app.inject({ method: 'POST', url: '/notes', body: note })
  expect(anonymous.status).toBe(401)
  expect(anonymous.headers['www-authenticate']).toBe('Bearer realm="api"')

  const reader = await mintToken({ sub: 'u-1', roles: ['reader'] })
  expect((await app.inject({ method: 'POST', url: '/notes', headers: bearer(reader), body: note })).status).toBe(403)

  const expired = await mintToken({ sub: 'u-1', roles: ['editor'], exp: Math.floor(Date.now() / 1000) - 60 })
  const rejected = await app.inject({ method: 'POST', url: '/notes', headers: bearer(expired), body: note })
  expect(rejected.status).toBe(401)
  expect(rejected.headers['www-authenticate']).toContain('error="invalid_token"')

  const editor = await mintToken({ sub: 'u-1', roles: ['editor'] })
  expect((await app.inject({ method: 'POST', url: '/notes', headers: bearer(editor), body: note })).status).toBe(201)
})
```

Worth a test each: a token for another audience or issuer, `alg: none`, an HS256 token signed with
the public key, a key set that cannot be fetched (`503`), an API key, another user's note (`404`),
and the access matrix. Use `enforcement: 'warn'` only in tests that deliberately boot without guards.

## Not included

These are left to your application, a library, or the infrastructure: sessions and login flows
(authorization code, PKCE, refresh tokens, MFA, password reset), OAuth2 and OIDC clients, SAML,
WebAuthn, built-in rate limiting, per-route CORS, the `Forwarded` header, request signing and mTLS
(terminate TLS at the proxy). A `@znight/security` package will be considered once the same
authenticator code is copied across several real applications, or when features need types owned by
the framework (a principal propagated to message consumers, for example). It would be built on the
primitives of this page.
