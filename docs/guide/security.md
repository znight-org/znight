---
description: Secure a Znight API - access decisions checked at build time and at boot, CORS, security headers and trusted proxies, and recipes for JWT/OIDC, API keys, policies, password hashing, rate limiting, webhook signatures, cookie sessions and CSRF.
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
The recipes of this page are the source files of
[`examples/secure-api`](https://github.com/znight-org/znight/tree/main/examples/secure-api), a Notes
API on the built-in node adapter, running on Node.js 24 and Bun: bearer tokens of an identity
provider, an API key for a machine client, password sign-in with cookie sessions for a web
front-end, and a signed billing webhook. Its tests are the tests of the recipes: every access rule,
token error, CORS case and signature check of this page is exercised there, and a test keeps the
code blocks of this page identical to the files they name.
:::

## Access control with route decisions {#route-decisions}

### Declare the access decision

An **access decision** is made of route decorators that are alternatives: a route is public, or
needs an authenticated caller, or needs a role. Give them the same `group`, and make the group
`required`:

```ts [src/auth/access.ts]
import { createRouteDecorator } from '@znight/http'

/** Every role of the API. `exporter` is the role of the export client, a machine (see `api-keys.ts`). */
export const ROLES = ['admin', 'editor', 'reader', 'exporter'] as const
export type Role = (typeof ROLES)[number]

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
  @Roles(['editor']) // ...this one needs the editor role instead
  create() {}
}

@Controller('/status')
@Public() // every route of the controller is public...
export class StatusController {
  @Get()
  status() {}

  @Get('/details')
  @Roles(['admin']) // ...but this one is for administrators only
  details() {}
}
```

- **The nearest decision wins.** The effective metadata of a route (`ctx.route.meta`, what
  `Roles.get(ctx)` reads) is made of the controller's entries whose group the route does not decide,
  then the route's entries. `@Public()` on `StatusController` and `@Roles(['admin'])` on its
  `details` route give `{ roles: ['admin'] }`: that route is **not** public.
- **One decision per group and target.** `@Public() @Roles(['admin'])` on the same method (or class)
  is a build error:

  ```txt
  ✗ ZNIGHT005: @Roles sets the "access" decision of ReportController.list, already set by @Public on the same target
    --> test/fixtures/conflicting.controller.ts:13:3
    = hint: Keep one of @Public, @Roles: the decorators of the "access" group are alternatives
  ```

- A route decorator created without `group` is its own group, as before: the route value wins over
  the controller value, key by key.

### Every route has a decision, checked at build time

A route with no decision of a required group, neither on itself nor on its controller, fails
`znight build`, `znight generate` and the Bun preload:

```txt
✗ ZNIGHT023: Route DELETE /drafts (DraftController.remove) has no "access" decision
  --> test/fixtures/undecided.controller.ts:18:3
  ::: src/auth/access.ts:8:14 The "access" group is required
  = hint: Add @Public(), @Authenticated() or @Roles(...) to the route or to DraftController
```

The check covers every route as soon as the group is defined in your sources, even before any of
its decorators is applied: adding `access.ts` to an existing application lists every route that
needs a decision. Deny by default is a build error, not a pentest finding. The example compiles such
a controller in `test/build-check.test.ts` with `compile()` from `@znight/compiler`.

### Every decision is enforced, checked at boot

A decision does nothing by itself: a guard must read it. The guard declares the decorators whose
decisions it enforces with a static `enforces` array:

```ts [src/auth/auth.guard.ts]
import type { Lazy } from '@znight/core'
import type { CanActivate, HttpContext } from '@znight/http'
import type { Authenticator } from './authenticator.js'
import type { CurrentUser } from './current-user.js'

import { Injectable } from '@znight/core'

import { Authenticated, Public, Roles } from './access.js'

@Injectable()
export class AuthGuard implements CanActivate {
  /** Read by HttpPlugin at boot: every route needs a guard enforcing the "access" group. */
  static readonly enforces = [Public, Authenticated, Roles]

  constructor(
    private readonly authenticator: Authenticator,
    private readonly user: Lazy<CurrentUser>,
  ) {}

  async canActivate(ctx: HttpContext): Promise<boolean> {
    if (Public.get(ctx)) return true
    const principal = await this.authenticator.authenticate(ctx) // 401 + WWW-Authenticate, or 503
    this.user.get().authenticate(principal)
    const roles = Roles.get(ctx)
    if (roles !== undefined) return roles.some(role => principal.roles.includes(role)) // false → 403
    return Authenticated.get(ctx) === true // no decision: denied (unreachable with a required group)
  }
}
```

The `Authenticator` tries the credentials of the request: a bearer token, an API key or a session
cookie (see [several strategies](#several-strategies)). Register the guard **globally**, so that it
runs before the controller and route guards: `HttpPlugin.configure({ guards: [AuthGuard] })`. When
`HttpPlugin` registers the routes, every route whose decision belongs to a required group (or to a
group some guard enforces) must have a guard enforcing that group in its chain. Otherwise the boot
fails with one error listing every route, which catches a forgotten `guards: [AuthGuard]` in a second
entrypoint, a worker or a test:

```txt
ZNIGHT023: HttpPlugin: No guard enforces the required "access" group on 15 routes: GET /admin/notes (AdminController.all), GET /admin/export (AdminController.export), ...; no guard enforces the "rateLimit" group on 3 routes: POST /notes (NoteController.create), ...
  hint: Register a guard declaring `static enforces` with the decorators of the "access" group (authenticated, public, roles), e.g. HttpPlugin.configure({ guards: [AuthGuard] })
  hint: Guards of the application enforcing the "access" group: AuthGuard
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
import { SessionConfig } from './config/session.config.js'
import { CsrfGuard } from './security/csrf.guard.js'
import { RateLimitGuard } from './security/rate-limit.js'

/** A new plugin instance per application (a plugin instance serves one application at a time). */
export function httpPlugin(): HttpPlugin {
  return HttpPlugin.configure(container => {
    const server = container.get(ServerConfig)
    const { origins } = container.get(CorsConfig)
    return {
      port: server.port,
      host: server.host,
      exposeErrors: server.exposeErrors,
      bodyLimit: '64kb',
      // AuthGuard first: the rate limit keys on the caller, the CSRF check depends on how they authenticated
      guards: [AuthGuard, RateLimitGuard, CsrfGuard],
      // credentials: a front-end of another origin of the same site signs in with the session cookie
      cors: origins.length > 0 && {
        origin: origins,
        credentials: true,
        exposeHeaders: ['location', 'retry-after', 'x-request-id'],
      },
      securityHeaders: { cacheControl: 'no-store' }, // answers depend on the caller: never in a shared cache
      trustProxy: server.trustedProxies.length > 0 && server.trustedProxies,
      cookies: { secrets: container.get(SessionConfig).secrets }, // signs the session cookie
    }
  })
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
  jwksUrl?: URL

  /** Development: a key set on disk instead (`scripts/dev-token.ts` writes `.dev/jwks.json`). */
  @Env('AUTH_JWKS_FILE')
  jwksFile?: string

  /** Keys of the export client (see API keys), comma-separated: the current and the next one. */
  @Secret('EXPORT_API_KEYS')
  exportApiKeys: string[] = []
}
```

```ts [src/auth/principal.ts]
import type { Role } from './access.js'

/** Who is calling, whatever the way they authenticated. */
export interface Principal {
  /** The `sub` of a token, the client of an API key, the account of a session. */
  readonly id: string
  readonly roles: readonly Role[]
  /** How the caller authenticated: only cookie sessions need a CSRF token. */
  readonly via: 'token' | 'api-key' | 'session'
}
```

```ts [src/auth/jwks-keys.ts]
import type { AuthConfig } from '../config/auth.config.js'

import { readFileSync } from 'node:fs'
import { Injectable } from '@znight/core'
import { createLocalJWKSet, createRemoteJWKSet, type JSONWebKeySet, type JWTVerifyGetKey } from 'jose'

/** The verification keys. A provider of its own, so that tests can replace the key source. */
@Injectable()
export class JwksKeys {
  readonly getKey: JWTVerifyGetKey

  constructor(config: AuthConfig) {
    if (config.jwksUrl !== undefined) {
      // built once: the key set is cached and refreshed when an unknown `kid` shows up
      this.getKey = createRemoteJWKSet(config.jwksUrl, {
        cooldownDuration: 30_000, // at most one refetch every 30 s, whatever the tokens claim
        cacheMaxAge: 600_000, // refetch at least every 10 minutes (key rotation)
        timeoutDuration: 5_000, // then 503: the identity provider is unavailable
      })
    } else if (config.jwksFile === undefined) {
      throw new Error('Set AUTH_JWKS_URL (the key set of the identity provider), or AUTH_JWKS_FILE in development')
    } else {
      // development: the key set written by scripts/dev-token.ts
      this.getKey = createLocalJWKSet(readKeySet(config.jwksFile))
    }
  }
}

function readKeySet(file: string): JSONWebKeySet {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as JSONWebKeySet
  } catch (error) {
    throw new Error(`Cannot read the key set ${file} (AUTH_JWKS_FILE): run \`bun scripts/dev-token.ts\` once`, {
      cause: error,
    })
  }
}
```

```ts [src/auth/token-verifier.ts]
import type { HttpContext } from '@znight/http'
import type { AuthConfig } from '../config/auth.config.js'
import type { JwksKeys } from './jwks-keys.js'
import type { Principal } from './principal.js'

import { Injectable } from '@znight/core'
import { type HttpException, ServiceUnavailableException, UnauthorizedException } from '@znight/http'
import { errors, type JWTPayload, jwtVerify } from 'jose'

import { ROLES, type Role } from './access.js'

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

  async verify(token: string): Promise<Principal> {
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

const KNOWN_ROLES: ReadonlySet<string> = new Set(ROLES)

function toPrincipal(payload: JWTPayload): Principal {
  const claim = payload.roles
  const roles = Array.isArray(claim) ? claim.filter((role): role is Role => KNOWN_ROLES.has(role)) : []
  return { id: payload.sub as string, roles, via: 'token' }
}

/** What the token is to blame for answers 401; an unavailable key source answers 503. */
function toHttpError(error: unknown): HttpException {
  const invalidToken =
    error instanceof errors.JWTExpired || // not a JWTClaimValidationFailed in jose 6
    error instanceof errors.JWTClaimValidationFailed || // not yet valid, wrong iss / aud, missing claim
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
  identity provider must not open this one, and a token must never choose its algorithm (`alg:
  none`, or HS256 signed with the public key).
- **Challenges** follow RFC 6750: no token gives `401` with `WWW-Authenticate: Bearer realm="api"`,
  an invalid one adds `error="invalid_token"`. A role the caller lacks is a `403` (the guard returns
  `false`).
- **An unreachable identity provider is a `503`**, never a `401`: clients would otherwise discard
  valid tokens and send their users to log in again. In `jose` 6, `JWTExpired` is not a
  `JWTClaimValidationFailed`: list it, or every expired token becomes a `503`.
- Roles come from a claim (`roles` here; `realm_access.roles` on Keycloak, `cognito:groups` on
  Cognito, `permissions` on Auth0): keep only the values your application knows.
- In development, `AUTH_JWKS_FILE` points at a key set on disk: the example's
  `scripts/dev-token.ts` creates a key pair once and prints tokens signed with it
  (`--sub u-ada --roles editor`).

### API keys {#api-keys}

Machine clients often use a static key. Keep only its SHA-256 digest and compare digests in constant
time:

```ts [src/auth/api-keys.ts]
import type { AuthConfig } from '../config/auth.config.js'
import type { Principal } from './principal.js'

import { createHash, timingSafeEqual } from 'node:crypto'
import { Injectable } from '@znight/core'

export const API_KEY_HEADER = 'x-api-key'
export const API_KEY_CHALLENGE = `ApiKey header="${API_KEY_HEADER}"`

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest()

/** Static keys of machine clients. Only their SHA-256 digests are kept. */
@Injectable()
export class ApiKeys {
  readonly #keys: readonly { readonly digest: Buffer; readonly principal: Principal }[]

  constructor(config: AuthConfig) {
    // one principal per client, so that each can be revoked alone; several keys per client during a rotation
    const exporter: Principal = { id: 'export-client', roles: ['exporter'], via: 'api-key' }
    this.#keys = config.exportApiKeys.map(key => ({ digest: sha256(key), principal: exporter }))
  }

  /** The client owning `key`, or `undefined`. */
  identify(key: string): Principal | undefined {
    const digest = sha256(key) // fixed length: timingSafeEqual never throws, the key length does not leak
    let found: Principal | undefined
    for (const entry of this.#keys) if (timingSafeEqual(entry.digest, digest)) found = entry.principal // no early exit
    return found
  }
}
```

Load the keys with [`@Secret`](/packages/config) (masked in logs and errors; Vault and AWS Secrets
Manager loaders available), give each client a principal of its own so that it can be revoked alone,
accept the current and the next key during a rotation (`EXPORT_API_KEYS=current,next`), and send
`WWW-Authenticate: ApiKey header="x-api-key"` with the `401`. The export client holds the `exporter`
role only: `@Roles(['admin', 'exporter'])` on `GET /admin/export` opens that route to it, and no
other.

### Several strategies {#several-strategies}

When an API accepts several kinds of credentials, try them in a fixed order. The first credentials
the request carries decide, and a `401` lists every challenge:

```ts [src/auth/authenticator.ts]
import type { HttpContext } from '@znight/http'
import type { Logger } from '@znight/observability'
import type { SessionCookies } from '../session/session-cookies.js'
import type { ApiKeys } from './api-keys.js'
import type { Principal } from './principal.js'
import type { TokenVerifier } from './token-verifier.js'

import { Injectable } from '@znight/core'
import { UnauthorizedException } from '@znight/http'

import { API_KEY_CHALLENGE, API_KEY_HEADER } from './api-keys.js'
import { BEARER_CHALLENGE, bearerToken } from './token-verifier.js'

@Injectable()
export class Authenticator {
  constructor(
    private readonly tokens: TokenVerifier,
    private readonly apiKeys: ApiKeys,
    private readonly sessions: SessionCookies,
    private readonly logger: Logger,
  ) {}

  /** The first credentials the request carries decide: a bearer token, an API key, then a session cookie. */
  async authenticate(ctx: HttpContext): Promise<Principal> {
    const token = bearerToken(ctx)
    if (token !== undefined) return await this.tokens.verify(token) // 401 invalid_token, or 503

    const key = ctx.header(API_KEY_HEADER)
    if (key !== undefined) {
      const client = this.apiKeys.identify(key)
      if (client !== undefined) return client
      // an audit trail of wrong keys, never the key itself (ctx.ip: the client behind the trusted proxies)
      this.logger.warn('Invalid API key', { ip: ctx.ip, route: ctx.route?.path })
      throw unauthorized('Invalid API key')
    }

    const session = this.sessions.read(ctx) // signed, unexpired, of an existing account
    if (session !== undefined) return session.principal
    if (this.sessions.isPresent(ctx)) this.sessions.close(ctx) // expired or revoked: the browser drops it

    throw unauthorized('Authentication required')
  }
}

/** A 401 lists every challenge (RFC 9110): the client picks a scheme it supports. */
function unauthorized(message: string): UnauthorizedException {
  return new UnauthorizedException(message, undefined, {
    headers: { 'www-authenticate': [BEARER_CHALLENGE, API_KEY_CHALLENGE] },
  })
}
```

- An invalid bearer token is not retried as an API key or a session: the client meant the token.
- A wrong API key is logged with the client address (`ctx.ip`, correct behind proxies with
  `trustProxy`), never with the key.
- A session cookie that no longer verifies (expired, signed with a retired secret, account removed)
  is cleared, so that the browser stops sending it.

### The current user {#current-user}

Store the caller in a **request-scoped** provider filled by the guard, and read it anywhere during
the request:

```ts [src/auth/current-user.ts]
import type { Principal } from './principal.js'

import { Injectable } from '@znight/core'
import { UnauthorizedException } from '@znight/http'

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

```ts [src/auth/me.controller.ts]
import type { Lazy } from '@znight/core'
import type { CurrentUser } from './current-user.js'
import type { Principal } from './principal.js'

import { Controller, Ctx, Get, type HttpContext } from '@znight/http'

import { Authenticated } from './access.js'

/** The caller as the API sees it. */
export interface Me extends Principal {
  /** The client address: behind the trusted proxies (`TRUSTED_PROXIES`), read from `x-forwarded-for`. */
  readonly ip: string | undefined
}

/**
 * Without `@Authenticated()` (or another decision of the "access" group), the build fails with
 * ZNIGHT023: there is no implicit default. `test/build-check.test.ts` keeps that promise.
 */
@Controller('/me')
@Authenticated()
export class MeController {
  // a singleton: the request-scoped CurrentUser is read through Lazy (injecting it directly is ZNIGHT003)
  constructor(private readonly user: Lazy<CurrentUser>) {}

  /** GET /me: whoever authenticated, with a token, an API key or a session cookie. */
  @Get()
  whoami(@Ctx() ctx: HttpContext): Me {
    return { ...this.user.get().principal, ip: ctx.ip }
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
import type { Lazy } from '@znight/core'
import type { CurrentUser } from '../auth/current-user.js'
import type { NoteRepository } from './note.repository.js'

import { Injectable } from '@znight/core'
import { type CanActivate, type HttpContext, NotFoundException } from '@znight/http'

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD'])

/** The note of the `:id` parameter belongs to the caller (admins read every note, and change none). */
@Injectable()
export class NoteOwnerPolicy implements CanActivate {
  constructor(
    private readonly notes: NoteRepository,
    private readonly user: Lazy<CurrentUser>,
  ) {}

  async canActivate(ctx: HttpContext): Promise<boolean> {
    const id = ctx.params.id ?? ''
    const note = await this.notes.find(id)
    const { principal } = this.user.get()
    const isAdmin = principal.roles.includes('admin')
    if (note === undefined || (note.ownerId !== principal.id && !isAdmin)) {
      // 404, not 403: do not tell other users that the note exists
      throw new NotFoundException(`Note ${id} not found`)
    }
    return note.ownerId === principal.id || READ_METHODS.has(ctx.method) // false → 403
  }
}
```

In `src/notes/note.controller.ts`:

```ts
@Controller('/notes')
@Authenticated()
export class NoteController {
  /** GET /notes/:id: the owner, or an administrator; 404 for anyone else. */
  @Get('/:id')
  @UseGuard(NoteOwnerPolicy) // after the global guards: the caller is known
  async get(@Param('id') id: string): Promise<Note> {
    return found(id, await this.notes.find(id))
  }
}
```

- Answer `404` rather than `403` for resources the caller should not know about. An administrator
  may read every note, so a change refused to them is a `403`.
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
const MAX_MEMORY = 256 * 1024 * 1024 // stored parameters asking for more (128 * N * r bytes) are refused
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
    const parsed = parse(stored)
    if (parsed === undefined) return false
    const key = await this.#derive(password, parsed.salt, parsed.params)
    return timingSafeEqual(key, parsed.hash)
  }

  /** True when the stored hash uses older parameters: hash the password again after a successful sign-in. */
  needsRehash(stored: string): boolean {
    const params = parse(stored)?.params
    return params === undefined || params.ln < CURRENT.ln || params.r !== CURRENT.r || params.p !== CURRENT.p
  }

  /** Hashes running and waiting for a slot (exposed by `GET /status/details`). */
  get stats(): { readonly running: number; readonly waiting: number } {
    return { running: this.#running, waiting: this.#waiting.length }
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

/** The parts of a PHC string, or `undefined` when it is malformed or asks for absurd parameters. */
function parse(stored: string): { params: Params; salt: Buffer; hash: Buffer } | undefined {
  const match = PHC.exec(stored)
  if (match === null) return undefined
  const [, ln, r, p, salt, hash] = match
  const params = { ln: Number(ln), r: Number(r), p: Number(p) }
  const expected = Buffer.from(hash as string, 'base64')
  const memory = 128 * 2 ** params.ln * params.r
  if (params.ln < 1 || params.r < 1 || params.p < 1 || params.p > 16 || memory > MAX_MEMORY) return undefined
  if (expected.length !== KEY_LENGTH) return undefined
  return { params, salt: Buffer.from(salt as string, 'base64'), hash: expected }
}
```

- Store the whole PHC string: it carries the parameters, so they can be raised later
  (`needsRehash`) without breaking existing hashes. Stored parameters asking for absurd amounts of
  memory or passes are refused instead of being run.
- Limit the password length in the sign-in schema (`z.string().min(1).max(1024)`) and rate limit
  the sign-in route: each attempt costs 128 MiB of memory and a few hundred milliseconds of CPU.
- Lower-memory alternatives with the same strength (OWASP): N = 2^16 with r = 8 and p = 2, or
  N = 2^15 with p = 3. Argon2id works too: `Bun.password` on Bun, the `argon2` package on Node.js.

The example signs the accounts of its web front-end in with it (`LOCAL_ACCOUNTS` holds the hashes
printed by `scripts/hash-password.ts`):

```ts [src/session/accounts.ts (excerpt)]
  /** The account matching the credentials, or `undefined`. */
  async signIn(username: string, password: string): Promise<Principal | undefined> {
    const account = this.#byUsername.get(username)
    // an unknown name costs a hash too: the response time does not tell which names exist
    const stored = account?.passwordHash ?? (await this.#decoyHash())
    const valid = await this.hasher.verify(password, stored)
    if (account === undefined || !valid) return undefined

    if (this.hasher.needsRehash(account.passwordHash)) {
      // the only moment the password is known: upgrade a hash made with older parameters
      account.passwordHash = await this.hasher.hash(password)
      this.logger.info('Password hash upgraded', { account: account.id }) // a database would store it here
    }
    return this.principal(account.id)
  }
  // ...
  /** A hash of a random password, made once: what unknown names are compared with. */
  #decoyHash(): Promise<string> {
    this.#decoy ??= this.hasher.hash(randomBytes(32).toString('base64'))
    return this.#decoy
  }
```

The answer and its timing are the same for an unknown name and a wrong password, and the only
moment the password is known is the right one to upgrade its hash.

## Rate limiting {#rate-limiting}

Limits belong at the edge first (load balancer, API gateway, WAF). In the application, a route
decorator and a guard give per-route limits keyed by caller, with
[`rate-limiter-flexible`](https://github.com/animir/node-rate-limiter-flexible):

```ts [src/security/rate-limit.ts]
import type { Lazy } from '@znight/core'
import type { CurrentUser } from '../auth/current-user.js'

import { Injectable } from '@znight/core'
import { type CanActivate, createRouteDecorator, type HttpContext, TooManyRequestsException } from '@znight/http'
import { type RateLimiterAbstract, RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible'

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
- The guard runs after `AuthGuard`: refused requests never consume a budget, and authenticated
  callers are counted by principal. The example limits note creation (30 per minute and user), the
  password sign-in (5 attempts per minute and address) and the webhook.
- The memory store is per process. With several instances, use `RateLimiterRedis` (or another
  shared store of the library) so that the limit holds across the fleet.
- Behind a load balancer, `ctx.ip` is the load balancer unless `trustProxy` is set: every anonymous
  client would share one budget.

## Webhook signatures {#webhooks}

A webhook sender signs the exact bytes of the body. The route is public (there is no user) and a
guard checks the signature before anything parses the body:

```ts [src/security/webhook-signature.guard.ts]
import type { CanActivate, HttpContext } from '@znight/http'
import type { WebhookConfig } from '../config/webhook.config.js'

import { createHmac, timingSafeEqual } from 'node:crypto'
import { Injectable } from '@znight/core'
import { UnauthorizedException } from '@znight/http'

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

```ts [src/webhooks/webhook.controller.ts]
import type { BillingLedger } from './billing-ledger.js'

import { Body, Controller, HttpCode, Post, UseGuard } from '@znight/http'

import { Public } from '../auth/access.js'
import { RateLimit } from '../security/rate-limit.js'
import { WebhookSignatureGuard } from '../security/webhook-signature.guard.js'
import { BillingEvent } from './billing-event.js'

@Controller('/webhooks')
@Public() // no user: the signature authenticates the sender
export class WebhookController {
  constructor(private readonly ledger: BillingLedger) {}

  /** POST /webhooks/billing: 204 once processed (or already processed), 401 for a bad signature. */
  @Post('/billing')
  @UseGuard(WebhookSignatureGuard)
  @RateLimit({ points: 120, duration: 60 })
  @HttpCode(204)
  billing(@Body(BillingEvent) event: BillingEvent): void {
    this.ledger.record(event)
  }
}
```

- Sign the **raw bytes**: re-serialising a parsed body changes key order and whitespace.
  `ctx.rawBody()` keeps the bytes for the `@Body()` parameter, which is parsed after the guards.
- The timestamp is part of the signed text and must be recent, so a captured request cannot be
  replayed later. Within the window, process each event once: the example's `BillingLedger` keeps
  the ids it processed.
- Compare with `timingSafeEqual` after a length check (it throws on different lengths).

## CSRF {#csrf}

APIs authenticated with bearer tokens or API keys need nothing: browsers never attach these headers
by themselves. CSRF only concerns **cookie authentication**. The web front-end of the example signs
in with a password (`POST /session`) and receives two cookies, set with the
[cookie helpers](/packages/http#cookies) of `@znight/http`:

```ts [src/session/session-cookies.ts (excerpt)]
/**
 * Who the caller is: signed with `SESSION_SECRETS`, `HttpOnly`. The `__Host-` prefix makes browsers
 * require `Secure`, `Path=/` and no `Domain`: a sibling subdomain cannot set or shadow it.
 */
export const SESSION_COOKIE = '__Host-session'
/** The CSRF token of the session, readable by the pages of this origin (not `HttpOnly`). */
export const CSRF_COOKIE = '__Host-csrf'
  // ...
  /** Opens a session for `principal`: sets both cookies on the response. */
  open(ctx: HttpContext, principal: Principal): Session {
    const exp = Math.floor(Date.now() / 1000) + this.config.maxAge
    const payload: SessionPayload = { sub: principal.id, exp, csrf: randomBytes(32).toString('base64url') }
    // Strict: never sent with a request started by another site, links included (an API has no landing page)
    const options = { maxAge: this.config.maxAge, sameSite: 'strict' } as const
    ctx.setCookie(SESSION_COOKIE, Buffer.from(JSON.stringify(payload)).toString('base64url'), {
      ...options,
      signed: true,
    })
    ctx.setCookie(CSRF_COOKIE, payload.csrf, { ...options, httpOnly: false })
    return { principal, csrfToken: payload.csrf, expiresAt: new Date(exp * 1000) }
  }
```

- `__Host-session` is signed with `cookies.secrets` (`SESSION_SECRETS`), `HttpOnly` and
  `SameSite=Strict`. Its value carries the account, an expiry (a signature does not cover any) and a
  random CSRF token.
- `__Host-csrf` carries the same token, readable by the pages of the origin. `POST /session` and
  `GET /session` also return it, for a front-end on another host, which cannot read the cookie.
- The `__Host-` prefix makes browsers require `Secure`, `Path=/` and no `Domain`: a sibling
  subdomain cannot set or shadow these cookies.

A global guard, registered after `AuthGuard`, then refuses forged requests:

```ts [src/security/csrf.guard.ts]
import type { Lazy } from '@znight/core'
import type { CanActivate, HttpContext } from '@znight/http'
import type { CurrentUser } from '../auth/current-user.js'
import type { CorsConfig } from '../config/cors.config.js'
import type { SessionCookies } from '../session/session-cookies.js'

import { timingSafeEqual } from 'node:crypto'
import { Injectable } from '@znight/core'

/** The header carrying the CSRF token of the session (double submit). */
export const CSRF_HEADER = 'x-csrf-token'

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Registered globally, after AuthGuard: it needs to know how the caller authenticated. */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly cors: CorsConfig,
    private readonly user: Lazy<CurrentUser>,
    private readonly sessions: SessionCookies,
  ) {}

  canActivate(ctx: HttpContext): boolean {
    if (SAFE_METHODS.has(ctx.method)) return true // safe methods must not change state
    const user = this.user.get()
    // a bearer token or an API key is never attached by the browser itself: nothing to forge
    if (user.isAuthenticated && user.principal.via !== 'session') return true
    // 1. Fetch metadata: no unsafe request from another site (the anonymous sign-in included: login CSRF)
    if (!this.#fromTrustedSite(ctx)) return false // → 403
    if (!user.isAuthenticated) return true
    // 2. Double submit: a cookie-authenticated request echoes the CSRF token bound to its session
    const expected = this.sessions.read(ctx)?.csrfToken
    const sent = ctx.header(CSRF_HEADER)
    return expected !== undefined && sent !== undefined && safeEqual(sent, expected)
  }

  #fromTrustedSite(ctx: HttpContext): boolean {
    const origin = ctx.header('origin')
    if (origin !== undefined && this.cors.origins.includes(origin)) return true // one of our front-ends
    const site = ctx.header('sec-fetch-site') // sent by every current browser
    if (site !== undefined) return site !== 'cross-site'
    // older browsers: an origin that is not ours is another site; no origin at all is not a browser
    return origin === undefined
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
```

- **Fetch metadata first.** An unsafe request marked `Sec-Fetch-Site: cross-site` (or, from an older
  browser, carrying a foreign `Origin`) is a `403`, unless it comes from one of the CORS origins. It
  covers the anonymous sign-in too: a page of another site cannot sign its visitor into the
  attacker's account (login CSRF).
- **Then the double submit.** A cookie-authenticated request echoes the token in `x-csrf-token`. A
  page of another site cannot read it, and the token is bound to the signed session: a token copied
  from another session, or a cookie tossed from a sibling subdomain, does not match. `same-site`
  requests (your other subdomains) need the token too.
- CORS does not replace this guard: a request from a denied origin is still served, only its page
  cannot read the answer.
- Signed cookies give integrity, not revocation. Signing out clears the cookies, but a copied session
  cookie stays valid until its signed expiry (`SESSION_MAX_AGE`): keep sessions short, rotate
  `SESSION_SECRETS` to end them all, or keep sessions in a server-side store.

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

The example reads its origins and proxies from the configuration (`CORS_ORIGINS`,
`TRUSTED_PROXIES`, see `src/http.ts` above), with `credentials: true` for the session cookie and
`cache-control: no-store` because every answer depends on the caller.

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
  request objects yourself, redact them, as the example's `main.ts` does:
  `ObservabilityPlugin.configure({ logging: { redact: ['*.headers.authorization', '*.headers.cookie', '*.headers["x-api-key"]', '*.headers["x-signature"]'] } })`.
- Rotate keys without downtime: accept the next and the current key during the rotation window, as
  the API key list and the signed cookie secrets do.

## Auditing access {#access-audit}

`HttpPlugin.routes` lists every route with its **effective** metadata and its guard chain. Snapshot
it, and every pull request that changes who can call what shows up in the diff:

```ts [test/access-matrix.test.ts]
import { HttpPlugin } from '@znight/http'

import { createTestApp } from './support/app.js'
import { expect, test as it } from 'bun:test'

function describeAccess(meta: Readonly<Record<string, unknown>>): string {
  if (meta.public === true) return 'public'
  if (Array.isArray(meta.roles)) return `roles ${meta.roles.join(' | ')}`
  if (meta.authenticated === true) return 'authenticated'
  return 'NO DECISION'
}

function describeLimit(meta: Readonly<Record<string, unknown>>): string {
  const limit = meta.rateLimit as { points: number; duration: number } | undefined
  return limit === undefined ? '' : `, ${limit.points} per ${limit.duration} s`
}

/**
 * Who can call what, as `HttpPlugin` registered it: the effective decision and the guard chain of
 * every route. A pull request that changes access changes the snapshot (`bun test -u` once reviewed).
 */
it('access matrix', async () => {
  await using app = await createTestApp()
  const matrix = app
    .get(HttpPlugin)
    .routes.filter(route => route.method !== 'HEAD')
    .map(
      route =>
        `${route.method} ${route.path} → ${describeAccess(route.meta)}${describeLimit(route.meta)} [${route.guards.join(', ')}]`,
    )
  expect(matrix).toMatchSnapshot()
})
```

```txt
GET /admin/export → roles admin | exporter [AuthGuard, RateLimitGuard, CsrfGuard]
GET /admin/notes → roles admin [AuthGuard, RateLimitGuard, CsrfGuard]
GET /health → public [AuthGuard, RateLimitGuard, CsrfGuard]
GET /me → authenticated [AuthGuard, RateLimitGuard, CsrfGuard]
GET /notes → authenticated [AuthGuard, RateLimitGuard, CsrfGuard]
POST /notes → roles editor, 30 per 60 s [AuthGuard, RateLimitGuard, CsrfGuard]
DELETE /notes/:id → authenticated [AuthGuard, RateLimitGuard, CsrfGuard, NoteOwnerPolicy]
GET /notes/:id → authenticated [AuthGuard, RateLimitGuard, CsrfGuard, NoteOwnerPolicy]
PATCH /notes/:id → authenticated [AuthGuard, RateLimitGuard, CsrfGuard, NoteOwnerPolicy]
DELETE /session → authenticated [AuthGuard, RateLimitGuard, CsrfGuard]
GET /session → authenticated [AuthGuard, RateLimitGuard, CsrfGuard]
POST /session → public, 5 per 60 s [AuthGuard, RateLimitGuard, CsrfGuard]
GET /status → public [AuthGuard, RateLimitGuard, CsrfGuard]
GET /status/details → roles admin [AuthGuard, RateLimitGuard, CsrfGuard]
POST /webhooks/billing → public, 120 per 60 s [AuthGuard, RateLimitGuard, CsrfGuard, WebhookSignatureGuard]
```

## Testing authenticated routes {#testing}

Keep the real guard and mint real tokens with a test key pair: the tests then cover the token
checks too. The example keeps the real key fetching as well: a local HTTP server
(`test/support/jwks-server.ts`) stands in for the identity provider and serves the public key set.

```ts [test/support/tokens.ts (excerpt)]
import { exportJWK, generateKeyPair, type JSONWebKeySet, SignJWT } from 'jose'

export const ISSUER = 'https://id.test/'
export const AUDIENCE = 'https://api.test'

const { publicKey, privateKey } = await generateKeyPair('RS256')
export const jwks: JSONWebKeySet = { keys: [{ ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' }] }

export interface TestClaims {
  readonly sub: string
  readonly roles?: readonly string[]
  readonly iss?: string
  readonly aud?: string
  /** `'5m'` (default), or an absolute time in Unix seconds (in the past for an expired token). */
  readonly exp?: string | number
  /** Not before: an absolute time in Unix seconds. */
  readonly nbf?: number
  /** The key id of the header (`'test'`, the key of the key set). */
  readonly kid?: string
}

/** A token as the identity provider would issue it, signed with the test key pair. */
export function mintToken(claims: TestClaims): Promise<string> {
  const token = new SignJWT({ roles: claims.roles ?? [] })
    .setProtectedHeader({ alg: 'RS256', kid: claims.kid ?? 'test' })
    .setSubject(claims.sub)
    .setIssuer(claims.iss ?? ISSUER)
    .setAudience(claims.aud ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(claims.exp ?? '5m')
  if (claims.nbf !== undefined) token.setNotBefore(claims.nbf)
  return token.sign(privateKey)
}
```

The same file forges what an attacker would send: an `alg: none` token, an HS256 token signed with
the public key, a token signed by another key pair under the same `kid`. The test application is
the one of `main.ts` (`httpPlugin()`: the real guards), configured with `inline()` values, its key
set URL pointing at the local identity provider that `testJwksServer()` starts once per test process:

```ts [test/support/app.ts (excerpt)]
export async function createTestApp({ env = {}, http = httpPlugin(), logs, ...options }: TestAppSetup = {}) {
  const idp = await testJwksServer()
  return await TestApp.create({
    metadata,
    plugins: [
      ObservabilityPlugin.configure({
        logging:
          logs === undefined
            ? { level: 'silent' }
            : { level: 'info', destination: { write: line => void logs.push(JSON.parse(line) as LogEntry) } },
        metrics: false,
      }),
      ConfigPlugin.configure({
        loaders: [
          inline({
            AUTH_ISSUER: ISSUER,
            AUTH_AUDIENCE: AUDIENCE,
            AUTH_JWKS_URL: idp.jwksUrl,
            EXPORT_API_KEYS: `${EXPORT_KEY},${NEXT_EXPORT_KEY}`,
            SESSION_SECRETS: SESSION_SECRET,
            LOCAL_ACCOUNTS: JSON.stringify(LOCAL_ACCOUNTS),
            WEBHOOK_SECRET,
            CORS_ORIGINS: BROWSER_ORIGIN,
            TRUSTED_PROXIES: 'loopback',
            PORT: '0', // app.inject() needs no port; a free one when the server listens
            ...env,
          }),
        ],
      }),
      http,
    ],
    ...options,
  })
}
```

```ts [test/notes.http.test.ts]
import { bearer, createTestApp } from './support/app.js'
import { mintToken } from './support/tokens.js'
import { expect, test as it } from 'bun:test'

it('only editors create notes', async () => {
  await using app = await createTestApp()
  const note = { text: 'hi' }

  const anonymous = await app.inject({ method: 'POST', url: '/notes', body: note })
  expect(anonymous.status).toBe(401)
  expect(anonymous.headers['www-authenticate']).toBe('Bearer realm="api", ApiKey header="x-api-key"')

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

Worth a test each, all in the example: a token for another audience or issuer, `alg: none`, an
HS256 token signed with the public key, a key set that cannot be fetched (`503`), an API key, another
user's note (`404`), a missing or foreign CSRF token, a tampered webhook body, and the access matrix.
Use `enforcement: 'warn'` only in tests that deliberately boot without guards.

## Not included

These are left to your application, a library, or the infrastructure: login flows beyond a password
form (authorization code, PKCE, refresh tokens, MFA, password reset), server-side session stores,
OAuth2 and OIDC clients, SAML, WebAuthn, built-in rate limiting, per-route CORS, the `Forwarded`
header, request signing and mTLS (terminate TLS at the proxy). A `@znight/security` package will be
considered once the same authenticator code is copied across several real applications, or when
features need types owned by the framework (a principal propagated to message consumers, for
example). It would be built on the primitives of this page; the [roadmap](/roadmap#considered) lists
the criteria.
