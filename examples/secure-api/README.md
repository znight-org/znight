# Notes API (secure-api)

A Notes API secured end to end with [Znight](../../README.md), without any security package: every
route has an access decision checked at build time and at boot, callers authenticate with **JWT
access tokens** of an identity provider, an **API key** (a machine client) or a **password and a
session cookie** (a web front-end), notes are protected by an **ownership policy**, and a billing
provider calls a **signed webhook**. CORS, security headers, trusted proxies, rate limiting, CSRF
defences and password hashing complete the picture.

It is the tested source of the [Security guide](../../docs/guide/security.md): the recipes of the
guide are the files of this example, byte for byte ([`guide.test.ts`](test/guide.test.ts) keeps
them in sync), and its tests exercise every access rule, token error, CORS case and signature check
of the page. It runs on the built-in `node:http` adapter, on Node.js 24 and Bun, with
[`jose`](https://github.com/panva/jose) and
[`rate-limiter-flexible`](https://github.com/animir/node-rate-limiter-flexible) as only security
dependencies. Notes are kept in memory: the data layer is the subject of the
[rest-api example](../rest-api/README.md).

## What it shows

| Feature                                                                                                   | Where                                                                                                                                |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Access decisions `@Public` / `@Authenticated` / `@Roles`: one required group, the nearest decision wins   | [`auth/access.ts`](src/auth/access.ts), the controllers                                                                              |
| Deny by default: a guard with `static enforces`, checked at boot (ZNIGHT023)                              | [`auth/auth.guard.ts`](src/auth/auth.guard.ts), [`http.ts`](src/http.ts)                                                             |
| JWT / OIDC resource server: pinned algorithm, issuer, audience, clock skew, remote JWKS, RFC 6750, 503    | [`auth/token-verifier.ts`](src/auth/token-verifier.ts), [`auth/jwks-keys.ts`](src/auth/jwks-keys.ts)                                 |
| API keys: SHA-256 digests, constant-time comparison, rotation                                             | [`auth/api-keys.ts`](src/auth/api-keys.ts)                                                                                           |
| Several strategies (bearer, API key, session cookie) with merged challenges                               | [`auth/authenticator.ts`](src/auth/authenticator.ts)                                                                                 |
| The caller in a request-scoped provider, read through `Lazy<T>`                                           | [`auth/current-user.ts`](src/auth/current-user.ts), [`auth/me.controller.ts`](src/auth/me.controller.ts)                             |
| A policy as a guard (ownership, 404 rather than 403)                                                      | [`notes/note-owner.policy.ts`](src/notes/note-owner.policy.ts), [`notes/note.controller.ts`](src/notes/note.controller.ts)           |
| Password hashing with scrypt (PHC strings, rehash, bounded concurrency), sign-in without user enumeration | [`security/password-hasher.ts`](src/security/password-hasher.ts), [`session/accounts.ts`](src/session/accounts.ts)                   |
| Cookie sessions on signed `__Host-` cookies                                                               | [`session/session-cookies.ts`](src/session/session-cookies.ts), [`session/session.controller.ts`](src/session/session.controller.ts) |
| CSRF: fetch metadata, then a double-submit token bound to the session                                     | [`security/csrf.guard.ts`](src/security/csrf.guard.ts)                                                                               |
| Rate limiting as a decision of its own (`@RateLimit`, `RateLimitGuard`)                                   | [`security/rate-limit.ts`](src/security/rate-limit.ts)                                                                               |
| Webhook signatures over the raw body, idempotent processing                                               | [`security/webhook-signature.guard.ts`](src/security/webhook-signature.guard.ts), [`webhooks/`](src/webhooks)                        |
| CORS with credentials, security headers, trusted proxies, cookie secrets                                  | [`http.ts`](src/http.ts)                                                                                                             |
| `@Secret` configuration, redacted logs                                                                    | [`config/`](src/config), [`main.ts`](src/main.ts)                                                                                    |
| Unit tests (`TestBed`), HTTP tests (`TestApp`) against real tokens and a real key set, build checks, e2e  | [`test/`](test)                                                                                                                      |

## Run it

Requirements: Node.js 24+ or Bun 1.3+. In this repository, install and build the framework once,
from the repository root: `bun install && bun run build` (the CLI and the production build use the
packages' `dist`).

```sh
bun scripts/dev-token.ts > /dev/null   # once: creates the development key pair in .dev/ (or: node scripts/dev-token.ts)
bun run dev                            # or: npm run dev
```

`dev` builds the application in watch mode and restarts it on every change, with
`NODE_ENV=development`: [`.env.development`](.env.development) provides the issuer and audience of
the development tokens, the key set written by `dev-token` (`AUTH_JWKS_FILE`), an export key, two
accounts, a webhook secret and debug logs. The API listens on <http://localhost:3000>.

| Script          | bun                     | npm / Node.js          | Does                                                                     |
| --------------- | ----------------------- | ---------------------- | ------------------------------------------------------------------------ |
| `dev`           | `bun run dev`           | `npm run dev`          | `znight dev`: build in watch mode, restart on change                     |
| `build`         | `bun run build`         | `npm run build`        | `znight build`: production bundle `dist/main.js` (fails on any DI error) |
| `start`         | `bun run start`         | `npm run start`        | `znight start`: runs `dist/main.js` with `NODE_ENV=production`           |
| `test`          | `bun run test`          | —                      | unit, HTTP and build-check tests (`bun test`)                            |
| `test:e2e`      | `bun run test:e2e`      | —                      | builds, then runs the bundle on Node.js **and** Bun over real HTTP       |
| `typecheck`     | `bun run typecheck`     | `npm run typecheck`    | generates the container, then `tsc --noEmit`                             |
| `generate`      | `bun run generate`      | `npm run generate`     | writes `src/.znight/container.generated.ts` (`--check` in CI)            |
| `token`         | `bun run token -- ...`  | `npm run token -- ...` | a development token: `--sub u-ada --roles editor` (runs on Node.js)      |
| `hash-password` | `bun run hash-password` | —                      | the PHC hash of the password read from stdin, for `LOCAL_ACCOUNTS` (Bun) |

The production bundle runs on both runtimes, configured by environment variables only:

```sh
bun run build
export AUTH_ISSUER=https://id.example.com/ AUTH_AUDIENCE=https://api.example.com \
  AUTH_JWKS_URL=https://id.example.com/.well-known/jwks.json \
  SESSION_SECRETS="$(openssl rand -base64 32)" WEBHOOK_SECRET=whsec-change-me
node --enable-source-maps dist/main.js   # Node.js
bun dist/main.js                         # Bun
```

Without its required configuration the application refuses to start, listing every problem at once
and printing no secret:

```txt
ConfigValidationError: ZNIGHT006: Invalid configuration: 4 problems
  - AuthConfig.issuer: missing required value; set AUTH_ISSUER (or key "auth.issuer")
  - AuthConfig.audience: missing required value; set AUTH_AUDIENCE (or key "auth.audience")
  - SessionConfig.secrets: missing required value; set SESSION_SECRETS (or key "session.secrets")
  - WebhookConfig.secret: missing required value; set WEBHOOK_SECRET (or key "webhook.secret")
```

### Configuration

Read by [`ConfigPlugin`](../../packages/config/README.md) from `.env` files, then from the
environment (which wins), and validated at boot. [`bunfig.toml`](bunfig.toml) turns off Bun's own
`.env` loading (`env = false`): it would expand the `$` of the scrypt hashes in `LOCAL_ACCOUNTS`, and
the files would then give different values on Node.js and Bun.

| Variable          | Default            | Description                                                                                        |
| ----------------- | ------------------ | -------------------------------------------------------------------------------------------------- |
| `AUTH_ISSUER`     | (required)         | The `iss` of the access tokens                                                                     |
| `AUTH_AUDIENCE`   | (required)         | The `aud` this API accepts                                                                         |
| `AUTH_JWKS_URL`   | —                  | The key set of the identity provider (cached, refetched for unknown `kid`s and every 10 minutes)   |
| `AUTH_JWKS_FILE`  | —                  | Development: a key set on disk instead (`.dev/jwks.json`). One of the two is required              |
| `EXPORT_API_KEYS` | —                  | Keys of the export client, comma-separated: the current one and the next one (`@Secret`)           |
| `SESSION_SECRETS` | (required)         | Keys signing the session cookie, 32+ bytes each, comma-separated: the first signs (`@Secret`)      |
| `LOCAL_ACCOUNTS`  | `[]`               | The accounts of the front-end, a JSON array of `{ id, username, roles, passwordHash }` (`@Secret`) |
| `SESSION_MAX_AGE` | `28800`            | Lifetime of a session, in seconds                                                                  |
| `WEBHOOK_SECRET`  | (required)         | Shared with the billing provider (`@Secret`)                                                       |
| `CORS_ORIGINS`    | —                  | Browser origins allowed to call the API, comma-separated (CORS off when empty)                     |
| `TRUSTED_PROXIES` | —                  | Proxies in front of the API: addresses, CIDR ranges, `loopback`, `private`, `linklocal`            |
| `PORT` / `HOST`   | `3000` / `0.0.0.0` | API address (`PORT=0`: a free port, logged when ready)                                             |
| `LOG_LEVEL`       | `info`             | `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`                                       |
| `EXPOSE_ERRORS`   | `false`            | Send the message of unexpected errors in 500 responses (development)                               |

## Try it

With `bun run dev` running (development accounts: `ada` / `ada-dev-password`, an editor, and `grace`
/ `grace-dev-password`, an administrator):

```sh
API=http://localhost:3000
EDITOR="authorization: Bearer $(bun scripts/dev-token.ts --sub u-ada --roles editor)"
READER="authorization: Bearer $(bun scripts/dev-token.ts --sub u-bob --roles reader)"
ADMIN="authorization: Bearer $(bun scripts/dev-token.ts --sub u-root --roles admin)"

curl $API/health                                   # {"status":"ok"}                       (@Public)
curl -i $API/notes                                 # 401, www-authenticate: Bearer realm="api" + ApiKey header="x-api-key"
curl -H "$EDITOR" $API/me                          # {"id":"u-ada","roles":["editor"],"via":"token","ip":"127.0.0.1"}
curl -i -H "authorization: Bearer nope" $API/me    # 401, www-authenticate: Bearer realm="api", error="invalid_token"

# roles: creating a note needs the editor role (the route's decision replaces the controller's)
curl -i -H "$READER" -H 'content-type: application/json' -X POST $API/notes -d '{"text":"Buy milk"}'   # 403
curl -i -H "$EDITOR" -H 'content-type: application/json' -X POST $API/notes -d '{"text":"Buy milk"}'   # 201, location: /notes/<id>

# ownership: another user gets a 404 (the note's existence stays secret), an admin may read it
curl -H "$READER" $API/notes/<id>                  # 404
curl -H "$ADMIN" $API/notes/<id>                   # 200 (and 403 for PATCH / DELETE)

# the former fail-open: a public controller, an admin route
curl $API/status                                   # {"status":"ok","uptime":12}
curl -H "$READER" $API/status/details              # 403
curl -H "$ADMIN" $API/status/details               # {"runtime":"node v24...","inflightRequests":1,"notes":1,...}

# the export client: an API key with the exporter role only
curl -H 'x-api-key: dev-export-key' $API/admin/export   # {"exportedAt":"...","notes":[...]}
curl -i -H 'x-api-key: dev-export-key' $API/admin/notes # 403
curl -i -H 'x-api-key: guessed' $API/admin/export       # 401, logged with the client address, never the key

# the web front-end: password sign-in, session cookie, CSRF token
curl -c jar.txt -H 'content-type: application/json' -X POST $API/session \
  -d '{"username":"ada","password":"ada-dev-password"}'   # {"id":"acc-ada","roles":["editor"],"csrfToken":"...",...}
CSRF=$(awk '$6 == "__Host-csrf" { print $7 }' jar.txt)
curl -b jar.txt $API/me                                   # {"id":"acc-ada",...,"via":"session"}
curl -i -b jar.txt -H 'content-type: application/json' -X POST $API/notes -d '{"text":"x"}'                       # 403: no token
curl -i -b jar.txt -H "x-csrf-token: $CSRF" -H 'content-type: application/json' -X POST $API/notes -d '{"text":"x"}' # 201
curl -i -b jar.txt -H "x-csrf-token: $CSRF" -X DELETE $API/session                                                # 204, cookies cleared
for i in 1 2 3 4 5 6; do curl -s -o /dev/null -w '%{http_code} ' -H 'content-type: application/json' \
  -X POST $API/session -d '{"username":"ada","password":"wrong"}'; done   # 401 401 401 401 429 429 (5 attempts a minute per address, the sign-in above included)

# the billing webhook: HMAC-SHA256 of "<timestamp>.<raw body>"
BODY='{"id":"evt_1","type":"subscription.created","data":{"customerId":"cus_42","plan":"pro"}}'
T=$(date +%s); SIG=$(printf '%s.%s' "$T" "$BODY" | openssl dgst -sha256 -hmac dev-webhook-secret | sed 's/^.* //')
curl -i -H "x-signature: t=$T,v1=$SIG" -H 'content-type: application/json' -d "$BODY" $API/webhooks/billing   # 204
curl -i -H "x-signature: t=$T,v1=$SIG" -H 'content-type: application/json' \
  -d "${BODY/pro/enterprise}" $API/webhooks/billing                                                            # 401 Invalid signature

# a browser front-end on http://localhost:5173 (CORS_ORIGINS): the preflight is answered before the guards
curl -i -X OPTIONS -H 'origin: http://localhost:5173' -H 'access-control-request-method: POST' \
  -H 'access-control-request-headers: x-csrf-token, content-type' $API/notes
# 204, access-control-allow-origin: http://localhost:5173, access-control-allow-credentials: true
```

curl stores the `Secure` session cookies for `http://localhost` like browsers do (a secure context).
Elsewhere, serve the API over HTTPS: the `__Host-` cookies require it.

| Method   | Path                | Access                           | Extra guards                                    | Response                                                |
| -------- | ------------------- | -------------------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| `GET`    | `/health`           | public                           | —                                               | `{status}`                                              |
| `GET`    | `/status`           | public                           | —                                               | `{status, uptime}`                                      |
| `GET`    | `/status/details`   | `admin` (on a public controller) | —                                               | runtime, in-flight requests, notes, hashing load        |
| `GET`    | `/me`               | authenticated                    | —                                               | the caller and its address                              |
| `GET`    | `/notes`            | authenticated                    | —                                               | the caller's notes                                      |
| `POST`   | `/notes`            | `editor`                         | `@RateLimit` 30 / min                           | `201` + `location`, `400`, `429`                        |
| `GET`    | `/notes/:id`        | authenticated                    | `NoteOwnerPolicy`                               | the note; `404` for other users                         |
| `PATCH`  | `/notes/:id`        | authenticated                    | `NoteOwnerPolicy`                               | the note; `404`, `403` for an administrator             |
| `DELETE` | `/notes/:id`        | authenticated                    | `NoteOwnerPolicy`                               | `204`; `404`, `403` for an administrator                |
| `GET`    | `/admin/notes`      | `admin`                          | —                                               | every note                                              |
| `GET`    | `/admin/export`     | `admin` or `exporter`            | —                                               | `{exportedAt, notes}` as an attachment                  |
| `POST`   | `/session`          | public                           | `@RateLimit` 5 / min                            | `{id, roles, csrfToken, expiresAt}` + cookies, `401`    |
| `GET`    | `/session`          | authenticated                    | —                                               | the session (CSRF token again), `404` without a session |
| `DELETE` | `/session`          | authenticated                    | —                                               | `204`, cookies cleared                                  |
| `POST`   | `/webhooks/billing` | public                           | `WebhookSignatureGuard`, `@RateLimit` 120 / min | `204`, `401`, `400`                                     |

Every route also runs the global guards `AuthGuard`, `RateLimitGuard` and `CsrfGuard`, and every
response carries the security headers, `cache-control: no-store` and an `x-request-id`.

## How it is built

```txt
src/
├─ main.ts                         # Application.create(): observability, config, httpPlugin()
├─ http.ts                         # HttpPlugin options shared with the tests: guards, CORS, headers, proxies, cookie secrets
├─ app.lifecycle.ts                # onReady / onStop logs
├─ config/                         # @Config classes: server, auth, cors, session, webhook (@Secret)
├─ auth/
│  ├─ access.ts                    # @Public / @Authenticated / @Roles: the required "access" group
│  ├─ auth.guard.ts                # AuthGuard: static enforces, deny by default
│  ├─ authenticator.ts             # bearer token, then API key, then session cookie
│  ├─ token-verifier.ts            # jwtVerify with pinned options; 401 invalid_token or 503
│  ├─ jwks-keys.ts                 # createRemoteJWKSet (AUTH_JWKS_URL) or a key set on disk (AUTH_JWKS_FILE)
│  ├─ api-keys.ts                  # hashed keys, timingSafeEqual
│  ├─ principal.ts, current-user.ts, me.controller.ts
├─ session/                        # accounts (password sign-in), signed session cookies, /session routes
├─ security/                       # PasswordHasher, RateLimit + RateLimitGuard, CsrfGuard, WebhookSignatureGuard
├─ notes/                          # NoteController, NoteOwnerPolicy, NoteService, NoteRepository (in memory)
├─ admin/  status/  health/  webhooks/
└─ .znight/                        # generated container (git-ignored)
scripts/
├─ dev-token.ts                    # development key pair (.dev/, git-ignored) and signed tokens
└─ hash-password.ts                # the PHC hash of a password, for LOCAL_ACCOUNTS
test/                              # bun test: unit, HTTP, build checks, guide sync, e2e
```

### Access decisions, checked at build time and at boot

Every route declares who may call it with one decorator of the `access` group
([`access.ts`](src/auth/access.ts)): `@Public()`, `@Authenticated()` or `@Roles([...])`. A decision on
the controller is the default of its routes, and a route's own decision **replaces** it:
`StatusController` is `@Public()` but its `details` route is `@Roles(['admin'])`, and that route is
admin only (the former fail-open combination, kept honest by
[`access.http.test.ts`](test/access.http.test.ts)).

**Try breaking it.** Remove `@Authenticated()` from [`MeController`](src/auth/me.controller.ts) and run
`bun run build`, `bun run generate` or `bun run test`: the build fails, there is no implicit default.
[`build-check.test.ts`](test/build-check.test.ts) compiles such a controller
([`test/fixtures/`](test/fixtures)) with `compile()` from `@znight/compiler`:

```txt
✗ ZNIGHT023: Route DELETE /drafts (DraftController.remove) has no "access" decision
  --> test/fixtures/undecided.controller.ts:18:3
   |
18 |   @Delete()
   |   ^^^^^^^^^
   |
  ::: src/auth/access.ts:8:14
   |
 8 | export const Public = createRouteDecorator('public', { group: 'access', required: true })
   |              ------ The "access" group is required
   = hint: Add @Public(), @Authenticated() or @Roles(...) to the route or to DraftController
```

Then remove `AuthGuard` from the guards of [`http.ts`](src/http.ts): the build succeeds, but the
application does not start. `AuthGuard` declares `static enforces = [Public, Authenticated, Roles]`,
and `HttpPlugin` checks at boot that every route has a guard enforcing its decisions; the
`@RateLimit` routes need `RateLimitGuard` the same way:

```txt
ZNIGHT023: HttpPlugin: No guard enforces the required "access" group on 15 routes: GET /admin/notes (AdminController.all), ...; no guard enforces the "rateLimit" group on 3 routes: POST /notes (NoteController.create), ...
```

[`access-matrix.test.ts`](test/access-matrix.test.ts) snapshots the effective decision, the rate
limit and the guard chain of every route ([the snapshot](test/__snapshots__/access-matrix.test.ts.snap)):
a pull request that changes who can call what changes it.

### Authentication

[`AuthGuard`](src/auth/auth.guard.ts) is a global guard: it lets `@Public()` routes through, asks
[`Authenticator`](src/auth/authenticator.ts) for the caller of every other request (`401` with every
challenge, or `503`), records it in the request-scoped [`CurrentUser`](src/auth/current-user.ts) and
checks the roles of `@Roles` routes (`false`: `403`). The authenticator tries, in this order, and the
first credentials the request carries decide:

- **Bearer tokens** ([`token-verifier.ts`](src/auth/token-verifier.ts)): `jwtVerify` from `jose`
  with the algorithm (`RS256`), issuer and audience pinned, 30 seconds of clock skew, `sub` and
  `exp` required, and the roles of the `roles` claim the API knows. An invalid token is a `401` with
  `error="invalid_token"` (RFC 6750); a key set that cannot be fetched is a `503` with
  `retry-after`, never a `401`. [`JwksKeys`](src/auth/jwks-keys.ts) builds the remote key set once
  (cache, cooldown, timeout), or reads `AUTH_JWKS_FILE` in development.
- **API keys** ([`api-keys.ts`](src/auth/api-keys.ts)): SHA-256 digests compared with
  `timingSafeEqual`, every key compared (no early exit), two keys during a rotation. A wrong key is
  logged with the client address, never with the key.
- **Session cookies** ([`session-cookies.ts`](src/session/session-cookies.ts)): a signed
  `__Host-session` cookie (`cookies.secrets`, `HttpOnly`, `SameSite=Strict`) holding the account, a
  signed expiry and a CSRF token. [`Accounts`](src/session/accounts.ts) verifies passwords with
  [`PasswordHasher`](src/security/password-hasher.ts) (scrypt N = 2^17, PHC strings, at most 4
  hashes at once), answers the same way for unknown names, and upgrades outdated hashes at sign-in.

### Browsers: CORS, CSRF, headers and proxies

[`http.ts`](src/http.ts) configures `HttpPlugin` for browsers, the same way in `main.ts` and in the
tests:

- **CORS** from `CORS_ORIGINS`, with `credentials: true` for the session cookie: preflights are
  answered by the pipeline before the guards, replies to allowed origins (errors included) carry
  the CORS headers. CORS decides what a page may read, not who may call.
- **CSRF** ([`csrf.guard.ts`](src/security/csrf.guard.ts)) only concerns cookie sessions (browsers
  never attach a bearer token or an API key by themselves): unsafe requests from another site are
  refused by their fetch metadata (`Sec-Fetch-Site`, or `Origin` from older browsers), the anonymous
  sign-in included, and cookie-authenticated ones must echo the token bound to their session in
  `x-csrf-token` (double submit). The token is in the `__Host-csrf` cookie and in the answers of
  `POST /session` and `GET /session`.
- **Security headers**, on by default, plus `cache-control: no-store`: every answer depends on the
  caller.
- **Trusted proxies** from `TRUSTED_PROXIES`: behind them, `ctx.ip` is the client from
  `x-forwarded-for` (the rate limit of anonymous callers and the audit logs depend on it).

### Rate limiting and webhooks

`@RateLimit({ points, duration })` ([`rate-limit.ts`](src/security/rate-limit.ts)) is a route
decision of its own, enforced by `RateLimitGuard` (`static enforces`): per route, per principal (or
per client address), `429` with `retry-after`. It runs after `AuthGuard`, so refused requests never
consume a budget. The memory store is per process: use `RateLimiterRedis` with several instances.

`POST /webhooks/billing` is public (there is no user): [`WebhookSignatureGuard`](src/security/webhook-signature.guard.ts)
checks `x-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">` with
`ctx.rawBody()`, before `@Body()` parses the same bytes, and refuses signatures older than 5
minutes. [`BillingLedger`](src/webhooks/billing-ledger.ts) processes each event id once (retries and
replays within the window).

### Secrets and logs

Secrets are `@Secret` fields: masked whenever a config object is logged or printed in an error, and
never echoed by the boot errors. Znight's request logs hold no header; [`main.ts`](src/main.ts) also
redacts `authorization`, `cookie`, `x-api-key` and `x-signature` from any log entry that would carry
headers.

### Lifecycle and graceful shutdown

[`AppLifecycle`](src/app.lifecycle.ts) logs `Notes API ready` (with the actual URL) once everything
listens, and `Notes API stopping` on shutdown. On `SIGTERM` / `SIGINT` the HTTP server stops
accepting connections and drains the in-flight requests (a webhook delivery still being received is
answered), providers stop, and the process exits with code `0`.

## Tests

```sh
bun run test       # unit, HTTP, build-check and guide tests: a few seconds
bun run test:e2e   # production build, then Node.js and Bun processes: a few seconds more
```

`bunfig.toml` preloads `@znight/compiler/bun`, which regenerates the container before the tests. The
HTTP tests boot the application with the HTTP options of `main.ts` ([`support/app.ts`](test/support/app.ts)),
mint real RS256 tokens ([`support/tokens.ts`](test/support/tokens.ts)) and let the real
`createRemoteJWKSet` fetch the key set from a local identity provider
([`support/jwks-server.ts`](test/support/jwks-server.ts)).

| File                                                      | Shows                                                                                                                                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`access.http.test.ts`](test/access.http.test.ts)         | 401 with every challenge on every non-public route, 403 per role, nearest decision, the boot check without guards (ZNIGHT023)                                                   |
| [`access-matrix.test.ts`](test/access-matrix.test.ts)     | the access matrix snapshot                                                                                                                                                      |
| [`tokens.http.test.ts`](test/tokens.http.test.ts)         | expired, not yet valid, clock skew, wrong `aud` / `iss`, `alg: none`, HS256 with the public key, foreign key, JWKS cache, 503                                                   |
| [`api-keys.http.test.ts`](test/api-keys.http.test.ts)     | rotation, wrong key logged with the client address, bearer first                                                                                                                |
| [`policy.http.test.ts`](test/policy.http.test.ts)         | ownership: 404 for other users, admins read but do not change                                                                                                                   |
| [`session.http.test.ts`](test/session.http.test.ts)       | sign-in, cookie attributes, double submit, fetch metadata, login CSRF, sign-out, tampering, expiry, rehash                                                                      |
| [`cors.http.test.ts`](test/cors.http.test.ts)             | preflights (allowed, denied, unknown path, admin route), CORS headers on 201 and 401, `vary`                                                                                    |
| [`headers.http.test.ts`](test/headers.http.test.ts)       | security headers on 200, 401, 403, 404 and 405                                                                                                                                  |
| [`proxy.http.test.ts`](test/proxy.http.test.ts)           | `x-forwarded-for` behind a trusted proxy, spoofing, no trust                                                                                                                    |
| [`rate-limit.http.test.ts`](test/rate-limit.http.test.ts) | 429 and `retry-after` per principal and per address, refused requests not counted                                                                                               |
| [`webhook.http.test.ts`](test/webhook.http.test.ts)       | valid, tampered, re-serialised, stale, missing and wrongly keyed signatures; idempotency                                                                                        |
| [`notes.http.test.ts`](test/notes.http.test.ts)           | the test of the guide: only editors create notes                                                                                                                                |
| `*.test.ts` (unit)                                        | `TestBed`: [`AuthGuard`](test/auth.guard.test.ts), [`CsrfGuard`](test/csrf.guard.test.ts), [`ApiKeys`](test/api-keys.test.ts), [`PasswordHasher`](test/password-hasher.test.ts) |
| [`build-check.test.ts`](test/build-check.test.ts)         | `compile()`: a route without decision (ZNIGHT023), two decisions on one route (ZNIGHT005)                                                                                       |
| [`guide.test.ts`](test/guide.test.ts)                     | the code blocks of the Security guide are the files of this example                                                                                                             |
| [`e2e.test.ts`](test/e2e.test.ts)                         | `ZNIGHT_E2E=1`: `znight build`, the bundle on Node.js (remote key set) and Bun (`dev-token` key set), real HTTP, SIGTERM drain                                                  |

## In this repository

The example is a workspace of the Znight monorepo, so a few settings exist only to use the
framework from its sources; a project created with `znight new` does not need them:

- `tsconfig.json`: `customConditions: ["@znight/source"]` and `allowImportingTsExtensions` make `tsc`
  check against the packages' TypeScript sources;
- `vite.config.ts`: `ssr.external` keeps the linked `@znight/*` packages out of the bundle (packages
  installed from npm are external anyway);
- `test` scripts pass `--conditions=@znight/source` to `bun test`;
- `app.inject()` on the built-in node adapter uses `light-my-request`, resolved here from the
  `@znight/http` workspace: add it to your `devDependencies` (`bun add -d light-my-request`);
- the `dev` script sets `NODE_ENV=development` explicitly: `znight dev` should do it, but currently
  starts the application with the `NODE_ENV=production` set by Vite during the build.
