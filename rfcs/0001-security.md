# RFC 0001: Security in Znight v0.1

|          |                                                                                                                                                                                                                                              |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status   | Proposed                                                                                                                                                                                                                                     |
| Date     | 2026-10-26                                                                                                                                                                                                                                   |
| Affects  | `@znight/http` (runtime and compiler extension), `@znight/core` (one error code), docs, examples                                                                                                                                             |
| Decision | **No `@znight/security` package in v0.1.** `@znight/http` gets route decision groups, a build-time and boot-time access check, CORS, security headers and trusted proxies. A tested Security guide and a `secure-api` example cover the rest |

## 1. Summary

Znight v0.1 does **not** ship a `@znight/security` package. The rest-api example shows that guards,
`createRouteDecorator` and request-scoped providers already express authentication and
authorization. What is missing is not an auth abstraction. It is four guarantees that only the
framework can give:

1. **One access decision per route, and the nearest one wins.** Route metadata is merged key by key
   today, so a controller-level `@Public()` silently cancels a route-level `@Roles(['admin'])` in
   the recipe guard: the route fails open. Route decorators get a `group`. Decorators of a group are
   alternatives, and a decision on the route replaces the controller's.
2. **Every route has a decision, checked at build time.** When a group is `required`, the compiler
   rejects any route without a decision of that group (**ZNIGHT023**). Only a framework that does DI
   at build time can offer this check.
3. **Every decision is enforced, checked at boot.** Guards declare the groups they enforce
   (`static enforces = [...]`). The HTTP plugin refuses to start when a route's guard chain does not
   enforce a required group (ZNIGHT023), which catches a forgotten `guards: [AuthGuard]`.
4. **Transport hardening that a recipe cannot do.** `cors` answers preflights in the pipeline,
   before routing and guards, the same way on every adapter. `securityHeaders` is on by default.
   `trustProxy` gives a correct `ctx.ip` and `ctx.protocol` behind load balancers on every adapter.

Everything else ships as a **Security guide of recipes**: JWT/OIDC resource server, API keys,
current user, password hashing, policies, rate limiting, webhook signatures, CSRF. The code of the
recipes lives in a new `examples/secure-api`, where it is compiled and tested. `@znight/security`
will be reconsidered for v0.2 against the criteria in §8, built on these primitives.

## 2. What exists today (checked against the code)

| Fact                                                                                                                                                                                  | Where                                                                        | Consequence                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global guards run first, then controller guards, then route guards. A result other than `true` gives 403. Guards may be request-scoped and have dependencies                          | `packages/http/src/pipeline.ts` (`#invoke`)                                  | Authentication and role checks fit in guards (rest-api `AuthGuard`)                                                                                                                                                         |
| `createRouteDecorator(key)` takes only a key. The compiler evaluates the argument statically and stores it in `meta`                                                                  | `packages/http/src/decorators.ts:327`, `src/compiler/route-decorators.ts`    | The compiler stores values but knows nothing about their meaning or how they relate                                                                                                                                         |
| Route metadata is merged key by key: `{ ...controller.meta, ...route.meta }`                                                                                                          | `packages/http/src/plugin.ts:537`                                            | `@Public()` on the class plus `@Roles(['admin'])` on a method gives `{ public: true, roles: ['admin'] }`. The rest-api guard checks `Public.get(ctx)` first, so **the admin route is public**, with no error and no warning |
| `@Roles` is inert metadata. Nothing checks that a guard reads it                                                                                                                      | —                                                                            | An entrypoint or a `TestApp` without `guards: [AuthGuard]` serves every route without authentication                                                                                                                        |
| An unmatched `OPTIONS` request gets 204 and `allow` without running guards. `@Options` and `@All` routes do run guards                                                                | `pipeline.ts:200`, `#process`                                                | A CORS preflight on an `@All` route gets the guard's 401                                                                                                                                                                    |
| An `http:request` wrapper can add headers to every reply (`event.responseHeaders`, merged by `addMissingHeaders`). It cannot answer the request itself: skipping `next()` gives a 500 | `pipeline.ts:267-268`, `:340`                                                | Security headers can be a hook. A CORS preflight cannot                                                                                                                                                                     |
| `ctx.ip` is the socket address on the node and Hono adapters. Fastify and Express apply their own proxy settings                                                                      | `adapters/node-io.ts:190`, `hono.ts:342`, `fastify.ts:220`, `express.ts:194` | Behind a load balancer, IP-based limits and audit logs are wrong on the default adapter, and adapters disagree                                                                                                              |
| No built-in CORS and no cookie parsing ("use the native ecosystem")                                                                                                                   | `packages/http/README.md`, "Limitations"                                     | Users of the default `nodeAdapter()` and of `Bun.serve()` have no CORS at all                                                                                                                                               |
| Compiler extensions can read the data stored by every other extension, but untyped (`graph.extensions: { name, stored: unknown[] }`)                                                  | `packages/compiler/src/graph/types.ts:158`                                   | A separate security extension would depend on the private data shape of http                                                                                                                                                |
| `@Secret` masks secrets. Vault and AWS Secrets Manager loaders exist                                                                                                                  | `packages/config`                                                            | Secrets are already handled                                                                                                                                                                                                 |
| ZNIGHT022 is the last error code                                                                                                                                                      | `packages/core/src/errors.ts`, architecture §4.8                             | ZNIGHT023 is free                                                                                                                                                                                                           |
| The `@znight` npm scope belongs to the project                                                                                                                                        | —                                                                            | Nobody can take `@znight/security`, so there is no need to publish a placeholder                                                                                                                                            |

## 3. Decision

- **Do not ship `@znight/security` in v0.1.**
- **Add the following to `@znight/http`.** P0 blocks the v0.1 release. P1 ships in v0.1 unless it
  delays the release.
  - P0: route decision groups, `createRouteDecorator(key, { group, required })` (§5.1).
  - P0: the guard declaration `static enforces` and the boot check (§5.2).
  - P0: error code ZNIGHT023 `MissingRouteDecision` in `@znight/core` (§5.7).
  - P0: the `cors` plugin option (§5.4).
  - P1: the `securityHeaders` plugin option, on by default (§5.5).
  - P1: the `trustProxy` plugin option and `ctx.protocol` (§5.6).
  - P1: route summaries that carry `meta` and `guards`, for audits (§5.3).
- **Write a Security guide**, `docs/guide/security.md`. Every snippet in it comes from
  `examples/secure-api` (wave 7, §11), where it is compiled and tested in CI (§6).
- **Migrate `examples/rest-api`** to `required` groups and `enforces`, in the same change as §5.1
  and §5.2.

## 4. Rationale

### 4.1 Why not a package (skeptic, pragmatist)

- **A package is not needed for the one feature that must belong to the framework.** The
  advocate's strongest point is that the compiler needs decorators whose meaning the framework
  defines. It needs less than that. It needs to know two things: that some decorators are
  _alternatives for one decision_, and that the decision is _mandatory_. Both are generic properties
  of route metadata (`group`, `required`). The compiler never needs to know what "public" means. The
  same mechanism serves `@RateLimit`, `@ApiVersion`, tenancy or OpenAPI tags.
- **Policies are already bound at build time.** `@UseGuard(NoteOwnerPolicy)` registers the policy
  as a provider, binds its dependencies and checks scopes (ZNIGHT001, ZNIGHT003) at build time.
  `@Authorize(Policy, 'method')` would only be shorter syntax for the same thing.
- **The hard parts are crypto and protocol code that we would wrap, not write.** `jose` handles
  JWT and JWKS, `node:crypto` handles scrypt, HMAC and `timingSafeEqual`. A wrapper would freeze an
  API (`Principal`, `Authenticator`, strategy options) under semver before any external user has
  tried it. It would also draw vulnerability reports (CVEs) about algorithm confusion, `kid`
  handling, clock skew or session fixation, which a single maintainer cannot triage for a v0.1.
- **There is no user store.** Znight ships no ORM by design, and sessions, password login and
  refresh tokens all need one. Without it, the package would be a thin wrapper over JWT and API
  keys: about 100 lines per app today.
- **Other frameworks split things the same way.** NestJS documents global authentication as
  exactly the rest-api recipe (`APP_GUARD` plus `SetMetadata(IS_PUBLIC_KEY)`); Passport is optional
  and widely disliked. Fastify and Hono ship one plugin or middleware per concern (`cors`,
  `helmet` / `secure-headers`, `jwt`, `rate-limit`), never a security package. CORS always sits in
  the HTTP layer, one line away: NestJS `enableCors`, `hono/cors`, `@fastify/cors`.

### 4.2 Why recipes alone are not enough (advocate, pragmatist)

- **The recipe fails open, silently** (§2, `plugin.ts:537`). Documentation cannot fix a merge rule.
  The framework has to.
- **Decisions can go unenforced.** Forget `guards: [AuthGuard]` in a second entrypoint, a monorepo
  service or a test, and every `@Roles` does nothing. Only the plugin sees the final guard chains,
  so only the plugin can refuse to boot.
- **Deny-by-default sells, and the compiler can do better than others.** Spring
  (`anyRequest().authenticated()`) and Micronaut (`@Secured`, where a route that no rule matches is
  rejected) show that users want it. Znight can fail `znight build` and point at the handler with no
  decision, before a pentest finds it.
- **CORS cannot be a recipe.** A hook wrapper cannot answer a preflight (500 without `next()`).
  `@All` and `@Options` routes run guards on preflights. The built-in node adapter has no middleware
  to hand the job to.
- **Behind a proxy, `ctx.ip` is wrong on the default adapter.** That breaks the rate-limit recipe
  and the audit logs.

### 4.3 Why a generic design inside `@znight/http`

- Only the http extension owns the route table. A separate package would need a typed contract
  between extensions (the advocate's own prerequisite) for a single consumer.
- Groups also fix the merge rule for every route decorator, not only the access ones. The change is
  backward compatible: a decorator without `group` is its own group, which is exactly today's
  behaviour.
- The primitives will not be thrown away. A v0.2 `@znight/security` would ship decorators with
  `group: 'access', required: true` and a guard with `static enforces`, built on this RFC.

### 4.4 What we keep from each expert

|            | Kept                                                                                                                                                                                                                             | Dropped                                                                                                                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Advocate   | The fail-open fix (nearest decision wins, one decision per group). The check for a forgotten guard. The build-time proof. The access matrix, as route summaries plus a snapshot test. The http prerequisites. The non-goals list | The package. `Authenticator` and `Authentication<P>`. `@Authorize`. `PasswordHasher` as a public API. ZNIGHT024 (conflicts are ZNIGHT005)                                                             |
| Skeptic    | No package. `cors` in http. The required-decorator check as a generic rule on route metadata. Recipes that are compiled and tested. The risk list                                                                                | A scope limited to `cors` (headers and proxies matter too). A test looping over the metadata as the only safeguard                                                                                    |
| Pragmatist | `securityHeaders` and `trustProxy` in http. A boot check for unenforced access. The audit listing. Recipes kept in `examples/`                                                                                                   | Reserving the npm name (the scope is ours). `createParamDecorator` and cookies (separate RFCs, not security-critical). The compiler option `requireRouteAccess` (replaced by `required` on the group) |

## 5. Detailed design

### 5.1 Route decision groups (P0)

#### API

```ts
// @znight/http
export interface RouteDecoratorOptions {
  /**
   * Decision group. Decorators of a group are alternatives: one per route (or controller), and
   * the route's decision wins. Default: the key.
   */
  readonly group?: string
  /** Every route must carry a decision of the group (ZNIGHT023 at build time and at boot). Default `false`. */
  readonly required?: boolean
}

/** The data part of a route decorator: what guards list in `enforces`. */
export interface RouteDecoratorInfo {
  readonly key: string
  readonly group: string // options.group ?? key
  readonly required: boolean
}

export interface RouteDecorator<T> extends RouteDecoratorInfo {
  (...args: RouteDecoratorArgs<T>): ClassMarker & MethodMarker
  get(ctx: HttpContext): T | undefined
}

export function createRouteDecorator<T = true>(key: string, options?: RouteDecoratorOptions): RouteDecorator<T>
```

Usage, which replaces `auth.decorators.ts` in the examples:

```ts
export type Role = 'admin' | 'editor' | 'reader'

export const Public = createRouteDecorator('public', { group: 'access', required: true })
export const Authenticated = createRouteDecorator('authenticated', { group: 'access', required: true })
export const Roles = createRouteDecorator<readonly Role[]>('roles', { group: 'access', required: true })
```

```ts
@Controller('/books')
@Roles(['reader']) // default decision for every route of the controller
export class BookController {
  @Get('/:id/cover') @Public() cover() {} // replaces the controller's decision
  @Post() @Roles(['admin']) create() {} // replaces it too
  @Delete('/:id') @Public() @Roles(['admin']) remove() {} // ✗ ZNIGHT005: two "access" decisions on one route
}
```

#### Semantics (normative)

1. **The group of a decorator** is `options.group ?? key`. A key belongs to exactly one group.
   Every definition of the same key (for example two `createRouteDecorator('roles')` in two files)
   must use identical options.
2. **One decision per group per target.** Two decorators of the same group on the same class or
   method give ZNIGHT005. This generalises today's error for the same key used twice.
3. **The nearest decision wins.** A route's effective metadata is made of two parts:
   - the controller's entries whose group has no entry on the route;
   - all the route's entries.

   For decorators without a group, this is exactly today's key-by-key merge.
4. **`required` belongs to the group**, and all decorators of a group must agree on it (ZNIGHT005
   otherwise). A route with no effective decision for a required group gives ZNIGHT023.
5. `T`, the rules for arguments and `get(ctx)` do not change. `get` reads the effective metadata.

#### Compiler (`packages/http/src/compiler`)

- **`route-decorators.ts`.** `resolve()` evaluates the optional second argument of
  `createRouteDecorator` with `refs: 'none'`.
  - After static evaluation, it must be an object literal with no properties other than `group`
    (a non-empty string matching `/^[A-Za-z][\w.-]*$/`) and `required` (a boolean).
  - More than two arguments, a value that cannot be evaluated or an unknown property gives
    `invalid` (ZNIGHT005, at the usage, with the definition as related location).
  - The resolution becomes `{ kind: 'route', key, group, required, name, definition }`, where
    `name` is the name of the `const` and `definition` its location.
- **`model.ts`.** `MetaEntry` gains `group`, `required`, `decorator` (display name) and
  `definition` (location).
- **`routeMeta()`.** The duplicate check compares groups instead of keys.
  - Message: `@Roles sets the "access" decision of BookController.remove, already set by @Public on the same target`.
  - Hint: `Keep one of @Public, @Authenticated, @Roles`. Related location: "First applied here".
- **`validate.ts` (`validateHttp`).** Two checks run after the existing ones.
  - Consistency. Collect `key → (group, required, definition)` and `group → required` over every
    stored entry. A conflict gives ZNIGHT005 at the second definition, related to the first.
  - Missing decisions. For each route and each **required** group seen during the compile, look
    for the effective decision (the route's, else the controller's). If there is none, report
    ZNIGHT023 (error) at the route decorator (`route.location`), related to the controller
    decorator, with a hint listing the decorators of the group.
- **`generate.ts`.** `metadata.extensions.http` gains a `groups` entry **only when** some group
  needs it: a group with `required: true`, with more than one key, or with an explicit name
  different from its key. Groups and keys are sorted. Apps that do not use groups get byte-identical
  output, so `generate --check` must stay green for the existing examples.
- **Known limit (documented).** The compiler knows a required group only when one of its
  decorators is applied somewhere in the application. The boot check (§5.2) covers the other cases.

```text
✗ ZNIGHT023: Route DELETE /books/:id (BookController.remove) has no "access" decision
  --> src/books/book.controller.ts:104:3
  = hint: Add @Public(), @Authenticated() or @Roles(...) to the route or to BookController
  = related: the "access" group is required (src/auth/access.ts:5:14)
```

#### Metadata (architecture §9.1)

```ts
interface HttpMetadata {
  controllers: HttpControllerDefinition[]
  /** Route decorator groups that are required or hold several keys: group → keys. */
  groups?: Record<string, { keys: string[]; required: boolean }>
}
```

The documentation of `HttpRouteDefinition.meta` becomes: "merged over the controller meta at
runtime, one decision per group (the route's wins)".

#### Runtime (`packages/http/src/plugin.ts`)

- In `buildRegistrations`, the spread at line 537 is replaced by `effectiveMeta(...)`. The result
  is computed once at boot and frozen, so nothing is added per request.

  ```ts
  function effectiveMeta(controller: Meta, route: Meta, keyGroup: ReadonlyMap<string, string>): Meta {
    const groupOf = (key: string): string => keyGroup.get(key) ?? key
    const decided = new Set(Object.keys(route).map(groupOf))
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(controller)) if (!decided.has(groupOf(key))) result[key] = controller[key]
    return Object.freeze(Object.assign(result, route))
  }
  ```

- `httpMetadata()` validates `groups`: an object of `{ keys, required }` where `keys` are
  non-empty, unique strings, `required` is a boolean, and a key is in at most one group.
  Anything else gives ZNIGHT007, like other malformed http metadata. Hand-written meta with two keys
  of one group on the same target also gives ZNIGHT007.
- `createRouteDecorator` stores `group` and `required` on the decorator. It throws a `TypeError` at
  module load when `group` is not a string or `required` is not a boolean.

### 5.2 Guard enforcement and the boot check (P0)

#### API

```ts
// @znight/http
/** Static side of a guard class: the route decorators whose decisions the guard enforces. */
export interface GuardClass {
  readonly enforces?: readonly RouteDecoratorInfo[]
}
```

```ts
@Injectable()
export class AuthGuard implements CanActivate {
  /** Read by HttpPlugin at boot: every route needs a guard enforcing the "access" group. */
  static readonly enforces = [Public, Authenticated, Roles]
  // ...
}
```

The array is typed with `RouteDecoratorInfo`, not `RouteDecorator<unknown>`, so that
`[Public, Roles]` stays assignable under `strictFunctionTypes`.

New plugin option: `enforcement?: 'error' | 'warn'`, default `'error'`.

#### Boot check (normative)

The check runs in `onBootstrap`, after `buildRegistrations`. It looks at each controller route
once, ignoring the HEAD and trailing-slash variants.

**Inputs for each route:**

- **Chain classes.** The classes of three kinds of guards:
  - global guards: the option entry itself when it is a class, `instance.constructor` when it is
    an instance;
  - controller guards and route guards: `metadata.providers[token]?.class`.

  Because the compiled class is used, a guard replaced through `overrides` in a test keeps its
  declaration. A guard without a class (built by a factory, for example) enforces nothing.
- **Validation.** The `enforces` array of each class must hold objects with a string `key`, a string
  `group` and a boolean `required`. Otherwise the plugin throws ZNIGHT005 naming the guard.
- **`enforced(route)`.** The groups listed by the chain classes of this route.
- **`known`.** The groups enforced by any guard of any chain.
- **`required`.** The union of two sets:
  - the groups with `required: true` in `metadata.extensions.http.groups`;
  - the groups of `enforces` entries with `required: true`.

  The second set makes a required group known even when no route uses it, which is the case of an
  auth package shared between services.
- **`decided(route)`.** The groups of the keys in the route's effective metadata.

**Problems:**

- `required − decided(route)` is not empty: the route has no decision. The build normally catches
  this first.
- `(decided(route) ∩ (required ∪ known)) − enforced(route)` is not empty: the decision is not
  enforced.

**Report.** All problems are collected into **one** ZNIGHT023 `ZnightError` listing every route,
by group, when `enforcement` is `'error'`. With `'warn'`, the plugin logs one `logger.warn` per
group instead.

```text
ZNIGHT023: No guard enforces the required "access" group on 9 routes: GET /books (BookController.list), POST /books (BookController.create), ...
  hint: Register a guard declaring `static enforces = [Public, Authenticated, Roles]`: HttpPlugin.configure({ guards: [AuthGuard] })
```

`TestApp` needs no change. The app's shared `HttpPlugin.configure`, or an override of the guard,
satisfies the check. A test that deliberately runs without guards sets `enforcement: 'warn'`.

### 5.3 Route summaries for audits (P1)

`HttpRouteSummary` (`plugin.routes`) gains two fields:

```ts
readonly meta: Readonly<Record<string, unknown>> // effective metadata
readonly guards: readonly string[] // display names, in chain order (global, controller, route)
```

Together they form the access matrix. The recipe snapshots it (§6, R13), so any pull request that
weakens access shows up in the diff. A `znight routes` CLI command is a later follow-up (§7).

### 5.4 CORS (P0)

```ts
export type CorsOrigin =
  | '*'
  | string
  | RegExp
  | readonly (string | RegExp)[]
  | ((origin: string) => boolean | Promise<boolean>)

export interface CorsOptions {
  readonly origin: CorsOrigin
  readonly credentials?: boolean // default false
  readonly methods?: readonly string[] // default: the methods routed on the requested path
  readonly allowHeaders?: readonly string[] | '*' // default: echo access-control-request-headers
  readonly exposeHeaders?: readonly string[] // default: [requestIdHeader] (none when it is false)
  readonly maxAge?: number // seconds, integer 0..86400, default 600
}

HttpPlugin.configure({
  cors: {
    origin: ['https://app.example.com', /^https:\/\/[a-z0-9-]+\.preview\.example\.com$/],
    credentials: true,
  },
})
```

**Option validation at boot (ZNIGHT005):**

- `origin` is required.
- A string other than `'*'` must equal `new URL(value).origin` and use `http:` or `https:`: no
  path, no trailing slash, no default port. The error shows the normalised value.
- `'null'` is refused.
- A `RegExp` must start with `^` and end with `$`, and must not have the `g` or `y` flag.
- `credentials: true` is refused together with `'*'` (alone or in a list) and together with
  `allowHeaders: '*'`.
- Methods and header names must be valid HTTP tokens.

**Behaviour (normative).** It is identical on every adapter. The pipeline changes go in
`pipeline.ts`, and a new `cors.ts` holds the pure policy.

1. **Origin decision.** It is made once for each request that carries an `origin` header, before
   the `http:request` hook runs. It is an exact string match, an anchored `RegExp` test, or a call
   to the function (awaited). A function that throws or rejects counts as a denial and is logged at
   `error` level.
2. **Preflight.** A preflight is an `OPTIONS` request with `origin` and
   `access-control-request-method` headers. The pipeline answers it inside
   `hooks.run('http:request')`, so logs, metrics and traces see it. It **never runs guards,
   interceptors or handlers, even when an `@Options` or `@All` route matches**.
   - Path without a route: 404, no CORS headers.
   - Origin denied: 403 `CORS origin not allowed`, no CORS headers.
   - Otherwise 204, with these headers:
     - `access-control-allow-origin`: `*` for the wildcard, the request origin otherwise;
     - `access-control-allow-credentials: true` when `credentials` is set;
     - `access-control-allow-methods`: `methods`, or else the methods listed in `allow`;
     - `access-control-allow-headers`: `allowHeaders`, or else the requested list when it is a
       valid comma-separated token list; omitted when nothing is requested;
     - `access-control-max-age`;
     - `allow`;
     - `vary: origin, access-control-request-method, access-control-request-headers`.
3. **Other requests from an allowed origin.** The reply gets `access-control-allow-origin`,
   `access-control-allow-credentials` and `access-control-expose-headers`, unless a handler,
   interceptor, mapper or wrapper already set them (same rule as `event.responseHeaders`). This
   covers every reply:
   - 2xx;
   - guard 401 and 403;
   - 404 and 405;
   - 413 and 500;
   - automatic `OPTIONS` that is not a preflight;
   - redirects.

   `@Res()` raw replies are the only exception.
4. **`vary: origin`** is merged into every reply, token by token and without duplicates, unless
   `origin` is exactly `'*'`. This includes requests without an `origin` header and denied origins,
   for the sake of shared caches.
5. **A denied origin on a request that is not a preflight** is served normally, without CORS
   headers. CORS protects what the browser lets a page read. It is not access control (see the CSRF
   recipe).
6. **Implementation.**
   - A `preflight` `Target` is handled in `#process`.
   - Preflights are detected in `handle()` (explicit `OPTIONS` routes) and in `#fallback()`
     (automatic `OPTIONS`).
   - Headers are added in `#complete()`, after `event.responseHeaders`.
   - Documentation note: with Fastify, Express or Hono, use either this option or the native CORS
     middleware, not both.

### 5.5 Security headers (P1)

```ts
export interface SecurityHeadersOptions {
  readonly contentSecurityPolicy?: string | false // default "default-src 'none'; frame-ancestors 'none'"
  readonly frameOptions?: 'DENY' | 'SAMEORIGIN' | false // default 'DENY'
  readonly noSniff?: boolean // default true: x-content-type-options: nosniff
  readonly referrerPolicy?: string | false // default 'no-referrer'
  // default false; true: max-age=31536000; includeSubDomains
  readonly hsts?:
    | boolean
    | { readonly maxAge?: number; readonly includeSubDomains?: boolean; readonly preload?: boolean }
  readonly crossOriginResourcePolicy?: 'same-origin' | 'same-site' | 'cross-origin' | false // default false
  readonly cacheControl?: string | false // default false ('no-store' for APIs serving personal data)
}
// HttpPlugin option: securityHeaders?: boolean | SecurityHeadersOptions, default true
```

- **The defaults are safe for APIs.** The CSP `default-src 'none'` blocks stored XSS through an
  uploaded HTML or SVG file served by `HttpResponse.file()`, and changes nothing for JSON. CORP is
  off by default: `same-origin` would block the `<img src>` of a cover image from a front-end on
  another origin.
- **How the option is applied.**
  - An object merges over the defaults. `false` disables everything.
  - Values are validated and computed at boot into a frozen record (ZNIGHT005 for an invalid
    value).
  - They are added last in `#complete()` with `addMissingHeaders`, so they lose to anything already
    set: by a handler (`@Header`, `ctx.setHeader`, `HttpResponse`), an interceptor, an exception or
    a hook wrapper.
  - They apply to every reply except `@Res()` raw replies.
- **Documentation notes.**
  - A route that serves an HTML page sets its own CSP (`@Header('content-security-policy', ...)`).
  - HSTS normally belongs to the TLS terminator.
  - The Express adapter disables `x-powered-by` on the app it creates.

### 5.6 Trusted proxies (P1)

```ts
// HttpPlugin option, default false
trustProxy?: false | number | readonly string[]
```

- **Both forms walk the same list:** `[socket address, ...x-forwarded-for from right to left]`.
- **`number`** (an integer ≥ 1) trusts that many hops. The client is the entry at that index, or
  the leftmost entry when the list is shorter.
- **`string[]`** lists IPv4 and IPv6 addresses and CIDR ranges, plus three aliases:

  | Alias         | Ranges                                              |
  | ------------- | --------------------------------------------------- |
  | `'loopback'`  | 127.0.0.0/8, ::1/128                                |
  | `'private'`   | 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7 |
  | `'linklocal'` | 169.254.0.0/16, fe80::/10                           |

  The walk continues while the addresses are trusted. The first untrusted address is the client,
  or the leftmost entry when all are trusted. IPv4-mapped IPv6 addresses are normalised first, and
  a malformed entry stops the walk at the last valid address.
- **Rejected values (ZNIGHT005).** `true`, a negative or fractional number, or an invalid CIDR. The
  hint explains that trusting every hop lets any client choose its `ctx.ip`.
- **New `ctx.protocol: 'http' | 'https'`.** When the socket peer is trusted, it is the leftmost
  `x-forwarded-proto` value (only `http` or `https` are accepted). Otherwise it is the protocol of
  the connection.
- **Adapter contract (`AdapterRequest`).** Two new optional fields: `remoteAddress` (the socket
  peer, never taken from headers) and `encrypted` (TLS). The four built-in adapters set both.
  - With `trustProxy: false`, `ctx.ip` stays `request.ip`, so the proxy settings of Fastify and
    Express still apply.
  - With a policy, the plugin starts from `remoteAddress ?? ip`.
- **Not in v0.1:** the `Forwarded` header (RFC 7239) is not read.

### 5.7 Error code

| Code      | Name                   | Description                                                                                                                             | Severity                                             | When           |
| --------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------- |
| ZNIGHT023 | `MissingRouteDecision` | A route has no decision for a required route decorator group (build time), or has a decision that no guard of its chain enforces (boot) | error (a warning at boot with `enforcement: 'warn'`) | build, startup |

The code goes into `ErrorCode`, `ERROR_DESCRIPTIONS`, architecture §4.8 and
`docs/reference/error-codes.md` (title, example, fix). Other problems reuse existing codes:

- conflicting decisions and invalid group options: ZNIGHT005;
- malformed `groups` metadata: ZNIGHT007;
- invalid `cors`, `securityHeaders`, `trustProxy` or `enforces`: ZNIGHT005.

### 5.8 Changes to the spec and the documentation

- **`docs/internals/architecture.md`.**
  - §4.8: ZNIGHT023.
  - §5: `createRouteDecorator(key, options)`.
  - §9.1: `groups` and effective meta, the CORS preflight in the pipeline, security headers, trusted
    proxies, the `enforces` boot check, the new options, `AdapterRequest.remoteAddress` and
    `encrypted`, `HttpRouteSummary`.
- **`packages/http/README.md`.**
  - Update "Guards" (groups, `enforces`), the "Plugin options" table, "Route decorators" and
    "Diagnostics" (ZNIGHT023).
  - New sections: "CORS", "Security headers", "Behind a proxy".
  - Remove CORS from "Limitations".
  - "Writing an adapter": `remoteAddress` and `encrypted`.
- **Reference and package pages:** `docs/reference/decorators.md`,
  `docs/reference/error-codes.md`, `docs/packages/http.md`.
- **New `docs/guide/security.md`**, with a sidebar entry in `docs/.vitepress/config.ts`. Link it
  from `docs/guide/migrating-from-nestjs.md`, replacing the `ctx.state.get('user') as {...}` sample
  with the groups and `CurrentUser` pattern, and from the feature list of the root README.
- **The `znight g guard` template** gets a commented `static enforces` line.

## 6. Recipes (`docs/guide/security.md`)

The code of every recipe is a file of `examples/secure-api` (wave 7), and the guide embeds it. The
tests of the example are the tests of the recipes.

| #   | Recipe                              | Key requirements                                                                                                                                                                                                                                                                                                                                       |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | Access control with groups          | `Public`, `Authenticated` and `Roles` in the `access` group with `required: true`. An `AuthGuard` with `static enforces`. Deny when no decision applies                                                                                                                                                                                                |
| R2  | JWT / OIDC resource server (`jose`) | Pinned `algorithms`, `issuer`, `audience`, `clockTolerance: 30`, `requiredClaims: ['sub', 'exp']`. `createRemoteJWKSet` built once, with `cooldownDuration` and `cacheMaxAge`. RFC 6750 challenges: no token → 401 with `WWW-Authenticate: Bearer realm="api"`; invalid token → the same with `error="invalid_token"`. JWKS unavailable → 503, not 401 |
| R3  | API keys                            | SHA-256 digests, `timingSafeEqual`, keys from `@Secret`, `WWW-Authenticate: ApiKey header="x-api-key"` (the current rest-api code)                                                                                                                                                                                                                     |
| R4  | Several strategies                  | Bearer first, then API key; the first match wins; a 401 merges the challenges                                                                                                                                                                                                                                                                          |
| R5  | Current user                        | A request-scoped `CurrentUser` filled by the guard. Singletons use `Lazy<CurrentUser>` (ZNIGHT003 explains why)                                                                                                                                                                                                                                        |
| R6  | Ownership and policies              | A policy is a guard: `@UseGuard(NoteOwnerPolicy)`, request-scoped, with a repository dependency, bound and scope-checked at build time. Answer 404 rather than 403 for resources the caller should not know about. Service-level checks use `@Intercept` or explicit domain checks                                                                     |
| R7  | Password hashing                    | `node:crypto` scrypt with N = 2^17, r = 8, p = 1 and `maxmem` of 256 MiB (OWASP), or the lower-memory OWASP equivalents. 16-byte salt. PHC string `$scrypt$ln=17,r=8,p=1$<salt>$<hash>` (base64 without padding). `timingSafeEqual`, `needsRehash`. Alternatives: `Bun.password`, `argon2`. Limit concurrent hashes                                    |
| R8  | Rate limiting                       | `RateLimit = createRouteDecorator<{ points; duration }>('rateLimit')`. A `RateLimitGuard` with `static enforces = [RateLimit]`, built on `rate-limiter-flexible` (memory, Redis in production). Key: the principal or `ctx.ip` (which needs `trustProxy`). `TooManyRequestsException` with `retry-after`. Prefer limits at the edge                    |
| R9  | Webhook signatures                  | `@Public()` plus `@UseGuard(WebhookSignatureGuard)`: HMAC-SHA256 over `t.` + `await ctx.rawBody()`, a 5-minute tolerance, `timingSafeEqual` after a length check                                                                                                                                                                                       |
| R10 | CSRF (cookie auth only)             | Bearer-token APIs need nothing. With cookies: `SameSite=Lax` or `Strict`, plus a guard that rejects unsafe methods when `sec-fetch-site` is `cross-site` (fallback: compare `origin` with the CORS origins)                                                                                                                                            |
| R11 | CORS, headers, proxies              | The configuration of §5.4 to §5.6, and the common mistakes                                                                                                                                                                                                                                                                                             |
| R12 | Secrets                             | `@Secret`, the Vault and AWS loaders. Never log tokens: use the observability `redact` option for any header you add to logs                                                                                                                                                                                                                           |
| R13 | Access audit                        | A snapshot of `plugin.routes` (method, path, access decision, guards) in a `TestApp` test                                                                                                                                                                                                                                                              |
| R14 | Testing authenticated routes        | Mint real tokens with a test key pair (`generateKeyPair`, and `createLocalJWKSet` overriding the key source), and keep the real guard. Use `enforcement: 'warn'` only for tests that run without guards                                                                                                                                                |

Reference snippets that the guide must contain (shortened here):

```ts
// R1 + R2 + R5
@Injectable()
export class AuthGuard implements CanActivate {
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
    if (roles !== undefined) return roles.some(role => principal.roles.includes(role))
    return Authenticated.get(ctx) === true // no decision: denied (unreachable with a required group)
  }
}

/** The key source, overridden in tests with createLocalJWKSet(...). */
@Injectable()
export class JwksKeys {
  readonly getKey: JWTVerifyGetKey
  constructor(config: AuthConfig) {
    this.getKey = createRemoteJWKSet(new URL(config.jwksUrl), { cooldownDuration: 30_000, cacheMaxAge: 600_000 })
  }
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
        algorithms: ['RS256'], // pinned: what the identity provider signs with
        clockTolerance: 30,
        requiredClaims: ['sub', 'exp'],
      })
      return toPrincipal(payload)
    } catch (error) {
      // JWT*/JWS* errors, JWKSNoMatchingKey, JOSEAlgNotAllowed → 401 invalid_token;
      // JWKSTimeout, fetch failures, a non-200 JWKS response → 503
      throw toHttpError(error)
    }
  }
}
```

```ts
// R13: the access matrix as a snapshot
test('access matrix', async () => {
  await using app = await createTestApp()
  const matrix = app
    .get(HttpPlugin)
    .routes.filter(route => route.method !== 'HEAD')
    .map(route => `${route.method} ${route.path} → ${describeAccess(route.meta)} [${route.guards.join(', ')}]`)
  expect(matrix).toMatchSnapshot()
})
```

## 7. Out of scope (explicitly)

- **The package and its abstractions.** `@znight/security`, `Authenticator` and `Principal` as
  framework types, an injectable `Authentication<P>` external, `@Authorize(Policy, method)`.
- **Login and session features.** Sessions, cookie parsing and signing, CSRF middleware, OAuth2 and
  OIDC login flows (authorization code, PKCE), refresh tokens, MFA, password reset, SAML, WebAuthn.
- **Built-in rate limiting** and its store abstraction.
- **CORS extras.** Per-route CORS overrides, Private Network Access.
- **The `Forwarded` header** (RFC 7239).
- **`createParamDecorator` / `@CurrentUser()`.** A generic http feature, for a separate RFC.
- **Cookie support in `@znight/http`.** A separate RFC.
- **Principal propagation to messaging consumers.**
- **A `znight routes` CLI command.** It follows once §5.3 has shipped.
- **Signing outgoing requests, and mTLS** (terminate TLS at the proxy).
- **Route decorators declared in compiled libraries** (`.d.ts`). This is an existing limitation:
  the key, and now the group, cannot be read from a declaration file.

## 8. When to reconsider `@znight/security` (v0.2 or later)

Open the package RFC when **two** of these hold:

- Three or more real applications (examples excluded) carry the same authenticator and guard code
  copied from the guide.
- Users ask for features that need types owned by the framework: a principal propagated to
  messaging, `@Authorize` with method signatures validated at build time, OIDC login with sessions
  (which requires cookies in http first).
- A security policy exists: `SECURITY.md`, private advisories enabled, a second maintainer able to
  triage.

The package would then ship decorators in the `access` group, a guard with `static enforces`, a
`JwtAuthenticator` extracted from R2 and a `PasswordHasher` extracted from R7. No change to this
RFC's API would be needed.

## 9. Alternatives considered

| Alternative                                                                                                         | Verdict                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ship `@znight/security` now (advocate, about 3 weeks of work)                                                       | Rejected (§4.1). Its build-time value is kept through generic groups                                                                                                                  |
| Recipes only, no framework change                                                                                   | Rejected (§4.2): the fail-open merge, unenforced decisions, CORS impossible as a hook                                                                                                 |
| An access-specific flag (`createRouteDecorator(key, { access: true })` plus a compiler option `requireRouteAccess`) | Replaced by `group` + `required`. Those also fix the merge rule, serve non-access groups, and need no new channel for compiler options (`ZnightOptions` has no per-extension options) |
| A typed contract between extensions for the route table                                                             | Deferred until a second extension (OpenAPI) needs it                                                                                                                                  |
| A runtime check of the form "a guard must have read the group during the request"                                   | Rejected: it fails per request instead of at boot, and it is a heuristic                                                                                                              |

## 10. Implementation plan, effort, tests

### Tasks and effort (one developer)

| #   | Task                                                                                                                                              | Priority | Days       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------- |
| T1  | Groups: runtime options; compiler (options, conflicts, consistency, ZNIGHT023, `groups` metadata); runtime effective meta and metadata validation | P0       | 2          |
| T2  | ZNIGHT023 in `@znight/core`, `ERROR_DESCRIPTIONS`, error-codes page                                                                               | P0       | 0.25       |
| T3  | `enforces`, the boot check, the `enforcement` option                                                                                              | P0       | 1          |
| T4  | CORS: policy, pipeline, validation, adapter parity                                                                                                | P0       | 2          |
| T5  | Migrate rest-api: `required` groups, `enforces`, fail-open regression test                                                                        | P0       | 0.25       |
| T6  | Security headers                                                                                                                                  | P1       | 0.5        |
| T7  | `trustProxy`, `ctx.protocol`, adapter fields                                                                                                      | P1       | 1          |
| T8  | `HttpRouteSummary.meta` and `.guards`                                                                                                             | P1       | 0.25       |
| T9  | Spec, http README, reference pages, guide skeleton                                                                                                | P0       | 1.25       |
| T10 | Wave 7: `examples/secure-api` and the recipes embedded in the guide                                                                               | P0       | 3          |
|     | **Total** (P0 ≈ 9.75)                                                                                                                             |          | **≈ 11.5** |

Order: T2, then T1 with T5 (one pull request), then T3, T4, T6 to T8, then T9 and T10.

### Test plan

- **Compiler (`packages/http/test/compiler`, fixture tests).**
  - Evaluation of the options: literals, `const` references, invalid values (ZNIGHT005).
  - Consistency: the same key with different options, `required` mismatches within a group.
  - Two decisions on the same target.
  - Nearest-wins resolution: a class decision covering every route, a route overriding it.
  - ZNIGHT023 reported and not reported, with its location, related location and hint.
  - Decorators from a source library.
  - A snapshot of the `groups` metadata.
  - Byte-identical generated output when no group is used: regenerate every example and keep
    `generate --check` green.
- **Runtime (`plugin.test.ts`, `runtime.test.ts`).**
  - `effectiveMeta` unit tests.
  - Malformed `groups` and hand-written conflicts give ZNIGHT007.
  - The boot check matrix:
    - guard as a global class, as a global instance, on the controller, on the route;
    - guard overridden in `TestApp`;
    - options given as a function;
    - a required group known only through `enforces`;
    - `enforcement: 'warn'`.
  - Fail-open regression: class `@Public()` plus route `@Roles(['admin'])` → 401 without
    credentials, 403 for a reader.
- **CORS.**
  - Unit tests of the policy: origin normalisation, anchored `RegExp`, functions (including ones
    that throw), wildcard with credentials refused.
  - Pipeline tests:
    - preflights on an automatic `OPTIONS` path and on `@Options` and `@All` routes (guards never
      run);
    - unknown path → 404;
    - denied origin → 403;
    - headers on 200, 401, 404 and 500;
    - merging of `vary`;
    - expose headers.
  - Parity: the same cases in the shared adapter suite (`adapters.test.ts`: node, fastify, express,
    hono) and in `hono-bun.test.ts` (`Bun.serve()`).
- **Security headers.** Present on 200, 401, 404, 405, automatic `OPTIONS` and errors. Overridden
  by `@Header`, `ctx.setHeader` and hook wrappers. Absent with `false` and on `@Res()`.
  Invalid values give ZNIGHT005.
- **Trusted proxies.** Hop counts, CIDRs and aliases, IPv6 and mapped IPv4, malformed and spoofed
  `x-forwarded-for`, `x-forwarded-proto`. Parity across adapters through `remoteAddress`.
  `trustProxy: false` keeps today's values.
- **Examples.** rest-api and secure-api tests and e2e runs (`ZNIGHT_E2E=1`, Node and Bun).
  `docs/test` keeps the guide's imports valid.

## 11. Wave 7 example: `examples/secure-api`

**Purpose.** It is the tested source of every recipe, and the reference answer to "how do I secure
a Znight API" without a security package.

**Domain.** A Notes API: personal notes, read access for admins across users, a billing webhook.
The repository is in memory, because the data layer is the subject of rest-api.

**Stack.**

- The built-in `nodeAdapter()`, the adapter without a middleware ecosystem, where `cors` and
  `trustProxy` matter most.
- Runs on Node 24 and on Bun.
- `@znight/config` and `@znight/observability`.
- Dependencies: `jose` and `rate-limiter-flexible`, at their current majors.

**Routes.** Every route has an `access` decision, and the build fails otherwise.

| Route                                   | Decision                                                        | Extra guards                                                         | Shows                                                             |
| --------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `GET /health`                           | `@Public()` on the controller                                   | —                                                                    | A public controller                                               |
| `GET /me`                               | `@Authenticated()`                                              | —                                                                    | `CurrentUser` (R5)                                                |
| `GET /notes`                            | `@Authenticated()` on the controller                            | —                                                                    | The controller's default decision                                 |
| `POST /notes`                           | `@Roles(['editor'])`                                            | `@RateLimit({ points: 30, duration: 60 })` (global `RateLimitGuard`) | RBAC, rate limiting (R8)                                          |
| `GET`, `PATCH`, `DELETE /notes/:id`     | inherited `@Authenticated()`                                    | `@UseGuard(NoteOwnerPolicy)`                                         | A policy guard with a repository; 404 for other users' notes (R6) |
| `GET /admin/notes`                      | `@Roles(['admin'])` on `AdminController`                        | —                                                                    | A controller-level decision                                       |
| `GET /admin/export`                     | inherited `@Roles(['admin'])`                                   | —                                                                    | API key for a machine client, chained after bearer (R3, R4)       |
| `GET /status` and `GET /status/details` | `@Public()` on the controller; `@Roles(['admin'])` on `details` | —                                                                    | The former fail-open case, now 401 or 403                         |
| `POST /webhooks/billing`                | `@Public()`                                                     | `@UseGuard(WebhookSignatureGuard)`, `@RateLimit`                     | HMAC over the raw body (R9)                                       |

**Layout:**

```text
examples/secure-api/
├─ src/
│  ├─ main.ts                      Application.create() with the plugins of http.ts
│  ├─ http.ts                      HttpPlugin.configure: guards, cors, securityHeaders, trustProxy (shared with the tests)
│  ├─ config/                      AuthConfig (issuer, audience, AUTH_JWKS_URL or AUTH_JWKS_FILE, @Secret API keys), CorsConfig, WebhookConfig
│  ├─ auth/
│  │  ├─ access.ts                 Public / Authenticated / Roles (group 'access', required)
│  │  ├─ auth.guard.ts             AuthGuard: static enforces, bearer then API key, merged challenges
│  │  ├─ token-verifier.ts         jwtVerify with pinned options, error mapping (401 / 503)
│  │  ├─ jwks-keys.ts              createRemoteJWKSet (URL) or createLocalJWKSet (file, development); overridden in tests
│  │  ├─ api-keys.ts               hashed keys, timingSafeEqual
│  │  └─ current-user.ts           request-scoped CurrentUser
│  ├─ security/
│  │  ├─ rate-limit.ts             RateLimit decorator + RateLimitGuard (static enforces)
│  │  ├─ webhook-signature.guard.ts
│  │  ├─ csrf.guard.ts             R10: unit-tested, not wired (the API uses bearer tokens)
│  │  └─ password-hasher.ts        R7: unit-tested, not wired (sign-in is the identity provider's job)
│  ├─ notes/                       NoteController, NoteOwnerPolicy, NoteService, InMemoryNoteRepository
│  ├─ admin/  status/  webhooks/  health/
├─ scripts/dev-token.ts            creates .dev/ keys and jwks.json once, prints a signed token (--sub, --roles)
├─ test/                           see below
├─ .env.development                AUTH_JWKS_FILE=.dev/jwks.json, issuer/audience, CORS origin http://localhost:5173
└─ README.md                       "What it shows", "Try breaking it" (remove a decision → ZNIGHT023)
```

**Tests.** `bun test`, plus e2e runs gated by `ZNIGHT_E2E`.

- **`support/app.ts`.** The same `http.ts` and `inline()` config. `JwksKeys` is overridden with a
  local set from `support/tokens.ts`, which generates a key pair once and provides
  `mintToken({ sub, roles, iss, aud, exp, alg })`.
- **`access.http.test.ts`.**
  - For every route: no credentials → 401 with `WWW-Authenticate`; wrong role → 403; right role →
    2xx.
  - Public routes → 2xx.
  - The `/status/details` regression.
  - Expired tokens, wrong `aud` or `iss`, `alg: none`, HS256 signed with the public key → 401
    `invalid_token`.
  - An unreachable JWKS → 503.
  - An API key on `/admin/export`.
- **`access-matrix.test.ts`.** The R13 snapshot, committed.
- **`policy.http.test.ts`.** Another user's note → 404; an admin → 200.
- **`cors.http.test.ts`.** Allowed preflight → 204 with headers. Denied → 403. A preflight never
  gets a 401. CORS headers on 200 and 401. `vary`.
- **`headers.http.test.ts`.** Security headers on 200, 401 and 404.
- **`proxy.http.test.ts`.** `trustProxy: ['loopback']` with `x-forwarded-for` changes `ctx.ip`
  (`/me` returns it); without trust, the header is ignored.
- **`rate-limit.http.test.ts`.** 429 with `retry-after` after N requests, counted per principal.
- **`webhook.http.test.ts`.** Valid signature → 204. Tampered body → 401. Stale timestamp → 401.
- **Unit tests.** `password-hasher.test.ts` (hash, verify, `needsRehash`, PHC parsing) and
  `csrf.guard.test.ts`.
- **`build-check.test.ts`.** Compiles a fixture with an undecided route through `compile()` from
  `@znight/compiler` and asserts ZNIGHT023 with its location. This keeps the README's "Try breaking
  it" honest.
- **`e2e.test.ts`.** Builds, then runs the bundle on Node and on Bun over real HTTP: a preflight,
  then an authenticated call with a token from `dev-token`.

The guide (`docs/guide/security.md`) links each recipe to its file and test in this example.
`examples/rest-api` keeps API keys, migrated to `required` groups and `enforces` (T5), and links to
secure-api for JWT.
