# RFC 0006: Cookies and Server-Sent Events in `@znight/http`

|          |                                                                                                                                                                                                                                                       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status   | Accepted (v0.1)                                                                                                                                                                                                                                       |
| Date     | 2026-10-26                                                                                                                                                                                                                                            |
| Affects  | `@znight/http` (runtime, compiler extension, the four adapters), `@znight/testing` (`TestApp`), docs, `examples/rest-api`                                                                                                                             |
| Decision | Cookies and SSE are implemented **once, in the plugin**, with zero dependency, identically on `node` / `fastify` / `express` / `hono`, Node.js 24 and Bun 1.3. No new error code: ZNIGHT005, 006, 007 and 017 are reused. Sessions stay out of scope. |

## 1. Summary

The owner compared `@znight/http` with NestJS and found two gaps. This RFC closes both.

**Cookies.**

- **Reading.** `@Cookie(name?, schema?)` is a parameter decorator coerced like `@Query`. Also
  `@SignedCookie(name, schema?)`, `ctx.cookies` and `ctx.signedCookie(name)`.
- **Writing.** `ctx.setCookie()` / `ctx.clearCookie()` and `HttpResponse.withCookie()` /
  `.withoutCookie()`.
- **Secure defaults.** `Path=/; Secure; HttpOnly; SameSite=Lax`.
- **Strict serialization.** RFC 6265bis serialization with prefix validation (`__Secure-`,
  `__Host-`, `__Http-`, `__Host-Http-`) and size limits.
- **Signed cookies.** Optional HMAC-SHA256 signing with key rotation (`cookies.secrets`).
- **Testing.** `inject()` accepts `cookies` / `signedCookies` and returns parsed `cookies`.

**Server-Sent Events.**

- **Routes.** `@Sse(path?, options?)` declares a `GET` route. Its handler returns an
  `AsyncIterable`, an `Iterable` or a `ReadableStream` of `SseEvent`
  (`{ data, event, id, retry, comment }`). `HttpResponse.sse(source, options?)` does the same on
  any route and any method (POST streaming for `fetch` clients, a future GraphQL transport).
- **Wire format.** The plugin does WHATWG framing: multi-line data, JSON for non-strings, an
  immediate preamble so that headers are flushed, and heartbeat comments (8 s by default).
- **Disconnects.** A client disconnect aborts a new `ctx.signal` and stops the source
  (`return()` / `cancel()`).
- **Backpressure.** Reads are pull-based. A bounded `EventChannel` helper serves push sources.
- **Lifetime and shutdown.** The request scope lives until the stream ends. `maxDuration` and
  graceful shutdown let the source finish, then send a jittered `retry` so that clients reconnect
  elsewhere.
- **Transport.** Proxy and compression headers are set, and the idle timeouts of Bun and Node are
  handled.
- **Testing.** `injectSse()` / `TestApp.injectSse()` consume an event stream in memory.
  `parseSseStream()` does the same over real sockets.

## 2. What exists today (checked against the code)

| Fact                                                                                                                                                                                            | Where                                                                  | Consequence for this RFC                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "No built-in CORS, compression, static files or cookies parsing yet: use the native ecosystem"                                                                                                  | `packages/http/README.md`, Limitations                                 | Users of `nodeAdapter()` and `Bun.serve()` have no cookies. Middleware cookies differ per adapter, which breaks "behaves the same everywhere".                                                 |
| `set-cookie` is already kept as an array: `ctx.appendHeader`, `HttpResponse.headers`, Web `Response.getSetCookie()`, `injectResponse()`                                                         | `context.ts`, `serialize.ts` (`fromWebResponse`), `adapters/shared.ts` | Multiple `Set-Cookie` lines already work on every adapter. Cookies build on this path.                                                                                                         |
| Response headers are validated by the plugin, never by the adapter (`findInvalidHeader`)                                                                                                        | `pipeline.ts#checkHeaders`, `headers.ts`                               | A cookie never reaches an adapter unvalidated.                                                                                                                                                 |
| Streams are pull-based (`highWaterMark: 0`) and tracked (`trackStream`). The request scope and `inflight` last until the body is read or cancelled. Sources run in the handler's async context. | `stream.ts`, `pipeline.ts#serve`                                       | SSE reuses this. Only framing, heartbeats, the stop signal and shutdown are new.                                                                                                               |
| `toByteStream` cancels an async iterator with `iterator.return()`                                                                                                                               | `stream.ts`                                                            | `return()` on an async generator **suspended in an `await`** is queued until that `await` settles. A producer waiting on a bus never stops. SSE needs an abort signal (§4.7).                  |
| The Hono adapter lifts Bun's `idleTimeout` while a stream is sent (`server.timeout(request, 0)`)                                                                                                | `adapters/hono.ts#bunFetch`                                            | Covered for `listen()`. Not covered when users mount `adapter.fetch` in their own `Bun.serve()` (§4.9).                                                                                        |
| `inject()` buffers the whole response (light-my-request, `fastify.inject`, `app.request().arrayBuffer()`)                                                                                       | `adapters/shared.ts`, `fastify.ts`, `hono.ts`                          | `inject()` on an infinite event stream hangs forever. A streaming inject is required (§4.11, §4.12). light-my-request 6.8 (also used by Fastify 5.12) supports `payloadAsStream` and `signal`. |
| `hooks.run('http:request')` resolves when the outcome is computed, before a stream body is sent                                                                                                 | `pipeline.ts#serve`                                                    | For SSE, request logs, metrics and spans measure the time to open the stream (§4.8).                                                                                                           |
| The `hono/compress` middleware skips `text/event-stream` and `Cache-Control: no-transform`                                                                                                      | `hono/dist/middleware/compress`                                        | `no-transform` makes Express `compression()` and Hono's middleware leave SSE alone (§4.9).                                                                                                     |
| RFC 0001 (security) lists "cookie support in `@znight/http`" as a separate RFC. It proposes `ctx.protocol` / `trustProxy` and a CSRF recipe based on `SameSite`                                 | `rfcs/0001-security.md` §5.6, §6 R10, §7                               | This is that RFC. The secure cookie defaults do not depend on `ctx.protocol` (§4.4).                                                                                                           |

## 3. Goals and non-goals

### 3.1 Goals

1. One implementation in the plugin, identical on 4 adapters × 2 runtimes × (`inject` and real
   socket), with no runtime dependency.
2. Cookies: build-time decorators with coercion and schemas, secure defaults, strict RFC 6265bis
   output (a broken cookie throws where it is set instead of being silently dropped by browsers),
   signed cookies with key rotation, and a good testing story.
3. SSE: a declarative route (`@Sse`) plus a programmatic body (`HttpResponse.sse`). The framing
   must be correct. Disconnect, backpressure, request scope and shutdown semantics must be defined
   and tested. Proxies, compression and timeouts must be handled. An in-memory test client must
   be available.
4. Build-time diagnostics for misuse, with the usual locations and hints.

### 3.2 Non-goals

- **Sessions** (`@Session()`, session stores, flash messages, view rendering). These are
  MVC-oriented and explicitly out of scope. Signed cookies are an integrity primitive, not a
  session system.
- **Encrypted cookies** (AES-GCM). Possible later on the same `cookies.secrets`.
- **CSRF middleware.** See RFC 0001 R10. `SameSite=Lax` by default helps but is not a defense on
  its own.
- **CORS** (RFC 0001 §5.4), **response compression**, **WebSockets / graphql-ws** (separate RFCs).
- **Cross-instance fan-out** of events (Redis, NATS...). `EventChannel` is in-process. Bridging a
  broker is application code, or a later `@znight/messaging` integration.
- **A browser cookie jar in `TestApp`** (domain and path matching, expiry). Tests pass cookies
  explicitly.
- **Measuring the stream lifetime in hooks** (a future `http:stream` hook).

---

## 4. Detailed design

### 4.1 Cookies: user-facing API

```ts
// src/prefs/prefs.controller.ts
import { Body, Controller, Cookie, Ctx, Get, type HttpContext, HttpResponse, Post } from '@znight/http'
import { z } from 'zod'

export const ThemeInput = z.object({ theme: z.enum(['light', 'dark']) })
// a stale or forged value falls back instead of answering 400 forever (cookies outlive deployments)
export const ThemeCookie = z.enum(['light', 'dark']).catch('light')

@Controller('/prefs')
export class PrefsController {
  @Get()
  read(@Cookie('theme', ThemeCookie) theme: 'light' | 'dark', @Cookie('visits') visits = 0) {
    return { theme, visits }
  }

  @Post('/theme')
  setTheme(@Body(ThemeInput) input: z.output<typeof ThemeInput>, @Ctx() ctx: HttpContext) {
    // readable by the front-end: httpOnly off for this one
    ctx.setCookie('theme', input.theme, { maxAge: 365 * 86_400, httpOnly: false })
    return HttpResponse.noContent()
  }
}
```

```ts
// src/auth/auth.controller.ts
@Controller('/auth')
export class AuthController {
  constructor(private readonly users: UserService) {}

  @Post('/login')
  async login(@Body(Credentials) input: Credentials) {
    const user = await this.users.authenticate(input) // throws UnauthorizedException
    return HttpResponse.ok({ id: user.id }).withCookie('__Host-uid', user.id, { signed: true, maxAge: 8 * 3600 })
  }

  @Post('/logout')
  logout(@Ctx() ctx: HttpContext) {
    ctx.clearCookie('__Host-uid') // Max-Age=0 with the same Path / Secure: valid for the __Host- prefix
    return HttpResponse.noContent()
  }

  @Get('/me')
  me(@SignedCookie('__Host-uid') uid: string) {
    // absent OR tampered OR signed with a retired key → 400 `Missing cookie "__Host-uid"`
    return this.users.find(uid)
  }
}

// a guard reads the same thing imperatively
@Injectable()
export class CookieAuthGuard implements CanActivate {
  canActivate(ctx: HttpContext): boolean {
    const uid = ctx.signedCookie('__Host-uid')
    if (uid === undefined) throw new UnauthorizedException()
    ctx.state.set('uid', uid)
    return true
  }
}
```

```ts
// src/main.ts
HttpPlugin.configure(c => {
  const config = c.get(AppConfig) // @Secret('COOKIE_SECRETS') → ['current…', 'previous…']
  return {
    cookies: {
      secrets: config.cookieSecrets, // the first signs, all verify (rotation)
      defaults: { secure: config.env !== 'development' }, // only for plain http://<lan-ip> dev setups
    },
  }
})
```

### 4.2 Cookies: reading

| Decorator / member          | Injects                                                                                                                                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@Cookie('name') v: T`      | The request cookie, decoded and coerced to `T` (`string`, `number`, `boolean`, `bigint`, `Date`, literal unions, enums, branded primitives), like `@Headers`. Absent and required → 400 `Missing cookie "name"`. |
| `@Cookie('name', S)`        | The decoded value (or `undefined`) validated with the Standard Schema `S`. The output is injected.                                                                                                               |
| `@Cookie()` / `@Cookie(S)`  | Every cookie (`Record<string, string>`), validated by `S` when given.                                                                                                                                            |
| `@SignedCookie('name', S?)` | The **verified** value of a signed cookie. Same coercion and schema rules. Absent, tampered or signed with an unknown key → `undefined`.                                                                         |
| `ctx.cookies`               | `Readonly<Record<string, string>>`, parsed on first access.                                                                                                                                                      |
| `ctx.signedCookie(name)`    | `string \| undefined`, verified on first call per name, then memoised.                                                                                                                                           |

**Parsing (normative)**, implemented by `parseCookieHeader(header)` (exported):

1. **Source.** The `cookie` request header. Repeated `Cookie` fields (HTTP/2 crumbs, RFC 9113
   §8.2.3) must reach the plugin joined with `; `. Node.js `IncomingMessage` and undici `Headers`
   already do this. The adapter matrix asserts it on every adapter × runtime (§10.3). An adapter
   whose runtime joins with `, ` MUST rebuild the header from the distinct values
   (`headersDistinct`, raw headers).
2. **Splitting.** Split on `;` only, never on `,`. Each pair is trimmed of SP and HTAB.
3. **Pairs.**
   - A pair without `=`, or with an empty name, is ignored. Nameless cookies cannot be addressed.
   - A name is kept as sent: case-sensitive, any characters except `;` and `=`. Names set by
     JavaScript are not always tokens.
4. **Values.**
   - The value is trimmed.
   - When it is wrapped in a pair of `"` (RFC 6265 `cookie-value`), the quotes are removed.
   - When it contains `%`, it goes through `decodeURIComponent`. On a malformed sequence the raw
     value is kept and no error is raised.
5. **Duplicate names: the first occurrence wins.** Browsers send cookies with longer paths first
   (RFC 6265 §5.4). Shadowing by a cookie set from a sibling subdomain ("cookie tossing") is
   prevented with `__Host-` names (§4.5), not by the parser.
6. **Result.** A prototype-less, frozen record, so `__proto__` is just a name. The parse runs in
   linear time without regular expressions. Its size is bounded by the server's header limit.

Coercion failures answer 400 like for `@Query`. The message **never echoes a cookie value**
(cookies often carry tokens): `Invalid cookie "visits": expected a number`. `coerce.ts` omits the
`received …` part for labels starting with `cookie `.

**An invalid cookie is a 400, on purpose.** Cookies outlive deployments, so a stale value fails
every request until it expires. The recommended tool is a schema with a fallback
(`z.enum([...]).catch('light')`). We prefer that to lenient coercion that would hide tampering.
The README shows this pattern in the first cookie example.

### 4.3 Cookies: writing

```ts
export interface CookieOptions {
  /** Lifetime in seconds (integer). `0` or less expires the cookie now. Default: session cookie. */
  readonly maxAge?: number
  /** Absolute expiry (sent as an IMF-fixdate). */
  readonly expires?: Date
  /** Domain (sub-domains included). Default: none, a host-only cookie. */
  readonly domain?: string
  /** Default: `'/'`. */
  readonly path?: string
  /** Default: `true` (see §4.4). */
  readonly secure?: boolean
  /** Default: `true`. */
  readonly httpOnly?: boolean
  /** Default: `'lax'`. `'none'` requires `secure`. */
  readonly sameSite?: 'strict' | 'lax' | 'none'
  /** CHIPS partitioned cookie. Requires `secure`. Default: `false`. */
  readonly partitioned?: boolean
  /** Chromium `Priority`. Default: none. */
  readonly priority?: 'low' | 'medium' | 'high'
  /** Signs the value with `cookies.secrets[0]` (§4.5). Default: `false`. */
  readonly signed?: boolean
}
/** Plugin-wide defaults (`cookies.defaults`). Lifetime and signing are per cookie. */
export type CookieDefaults = Omit<CookieOptions, 'maxAge' | 'expires' | 'signed'>
/** What identifies a cookie to clear (and keeps prefixed names valid). */
export type ClearCookieOptions = Pick<
  CookieOptions,
  'domain' | 'path' | 'secure' | 'httpOnly' | 'sameSite' | 'partitioned'
>

interface HttpContext {
  // … existing members
  readonly cookies: Readonly<Record<string, string>>
  signedCookie(name: string): string | undefined
  setCookie(name: string, value: string, options?: CookieOptions): void
  clearCookie(name: string, options?: ClearCookieOptions): void
  /** Cookies set on this response so far (`setCookie` / `clearCookie`), in order. */
  readonly responseCookies: readonly ResponseCookie[]
  readonly signal: AbortSignal // §4.7
}

class HttpResponse<T> {
  // … existing members
  readonly cookies: readonly ResponseCookie[]
  withCookie(name: string, value: string, options?: CookieOptions): HttpResponse<T>
  withoutCookie(name: string, options?: ClearCookieOptions): HttpResponse<T>
}

/** A cookie to send, as given (defaults and signing are applied when the response is serialised). */
export interface ResponseCookie {
  readonly name: string
  /** `undefined`: a clearing cookie. */
  readonly value: string | undefined
  readonly options: CookieOptions
}
```

**Merging (normative).**

- **The jar.** A response carries a _jar_ keyed by `(name, domain ?? '', path)`. A later
  `setCookie` / `clearCookie` with the same key replaces the earlier entry in place: set then
  clear gives one clearing cookie.
- **The `ctx` jar** is sent with **every** response of the request:
  - success and errors (mapped or not);
  - redirects and automatic `OPTIONS`;
  - 404/405 (their jar is empty).

  This is how `ctx.setHeader` already behaves. A guard can `ctx.clearCookie('sid')` and then
  throw a 401.
- **The `HttpResponse` jar** (handler result or exception mapper result) overrides entries of the
  `ctx` jar with the same key. This follows the existing header precedence
  (`ctx.setHeader()` < `HttpResponse` headers).
- **The final `set-cookie` field.** First come the raw `set-cookie` values, with today's
  precedence unchanged: `@Header`, `ctx.setHeader/appendHeader`, `HttpResponse.headers`, and the
  `getSetCookie()` of a returned Web `Response`. Then the merged jar follows, in insertion order.
  Every cookie is one field line on every adapter and one array entry in `inject()`.
- **Raw responses.** A `@Res()` handler writes its own response: the jar is not applied
  (documented).
- **After the headers are sent.** Once the response headers are committed (a running SSE stream, a
  streamed body), `setCookie` / `clearCookie` throw
  `Error('Cannot set cookie "x": the response headers were already sent')`. Today, headers set
  that late are silently lost.

**Serialization (normative)**, implemented by `serializeCookie(name, value, options)` (exported;
signing is only available through the plugin):

| Item                                                            | Rule                                                                                                                                                                                                                                                                                                                                | Violation                                |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| name                                                            | RFC 9110 token                                                                                                                                                                                                                                                                                                                      | `TypeError`                              |
| value                                                           | A well-formed string (`String.prototype.isWellFormed()`: lone surrogates cannot round-trip). The UTF-8 bytes outside RFC 6265 `cookie-octet` (`%x21 / %x23-2B / %x2D-3A / %x3C-5B / %x5D-7E`)**and `%`** are percent-encoded, so `decodeURIComponent` restores the value exactly (`a b;c` → `a%20b%3Bc`). Quotes are never emitted. | `TypeError` (non-string, lone surrogate) |
| size                                                            | `name=value` on the wire (after encoding and signing) is at most 4096 bytes. Domain and Path are at most 1024 bytes each (RFC 6265bis §5.7: browsers drop larger cookies silently).                                                                                                                                                 | `RangeError`                             |
| `maxAge`                                                        | A finite integer. `Max-Age=<n>`, with `Max-Age=0` when n ≤ 0. Browsers cap lifetimes at 400 days; the README says so and nothing is clamped server-side.                                                                                                                                                                            | `TypeError`                              |
| `expires`                                                       | A valid `Date`.`Expires=<date.toUTCString()>`                                                                                                                                                                                                                                                                                       | `TypeError`                              |
| `domain`                                                        | Lower-cased, one leading `.` removed. Must be an ASCII host name (IDNs in punycode): letters, digits, `-`, non-empty `.`-separated labels, at most 253 characters                                                                                                                                                                   | `TypeError`                              |
| `path`                                                          | Starts with `/`, `%x20-7E` except `;`                                                                                                                                                                                                                                                                                               | `TypeError`                              |
| `sameSite: 'none'`                                              | Requires `secure`                                                                                                                                                                                                                                                                                                                   | `TypeError`                              |
| `partitioned`                                                   | Requires `secure`                                                                                                                                                                                                                                                                                                                   | `TypeError`                              |
| `__Secure-` prefix (case-insensitive, like browsers)            | `secure`                                                                                                                                                                                                                                                                                                                            | `TypeError` naming the rule              |
| `__Host-`                                                       | `secure`, `path: '/'`, no `domain`                                                                                                                                                                                                                                                                                                  | `TypeError`                              |
| `__Http-` / `__Host-Http-` (added by recent RFC 6265bis drafts) | `secure` and `httpOnly` (+ the `__Host-` rules)                                                                                                                                                                                                                                                                                     | `TypeError`                              |

**Output order:**
`name=value; Max-Age=3600; Expires=…; Domain=example.com; Path=/; Secure; HttpOnly; SameSite=Lax; Partitioned; Priority=High`.

**Clearing:** `name=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`, plus Domain, Path,
Secure, HttpOnly, SameSite and Partitioned from the defaults merged with the options. A
`__Host-` cookie is therefore cleared with valid attributes. A clearing cookie is never signed.

**When errors are raised.**

- `ctx.setCookie` / `ctx.clearCookie` know the plugin defaults and the secrets. They validate
  **everything at call time**, so the stack trace points to the faulty line.
- `HttpResponse.withCookie()` is called before any context exists. At call time it validates
  what does not depend on the plugin: name, value type, `maxAge` / `expires`, domain, path and
  sizes before signing. The rules that depend on defaults (a prefix together with the `secure`
  default, `SameSite=None` together with `secure`), signing and the final size are checked when
  the response is serialised. A violation there gives the generic 500 and is logged as
  `Invalid cookie "x": …`, which is how `#checkHeaders` treats an invalid header today.

### 4.4 Cookies: secure defaults

`{ path: '/', secure: true, httpOnly: true, sameSite: 'lax' }`, overridable with
`cookies.defaults` and then per cookie.

`secure: true` is right behind TLS-terminating proxies. The attribute governs the browser to edge
connection, not the proxy to app hop, so no protocol detection (RFC 0001 `ctx.protocol`) is
needed. The only casualties are plain `http://` development setups on a non-localhost host, and
older Safari versions on `http://localhost`. The README documents
`defaults: { secure: config.env !== 'development' }` for those.

### 4.5 Cookies: signing and key rotation

- **Option.** `cookies.secrets: string | Uint8Array | readonly (string | Uint8Array)[]`. The first
  secret signs and every secret verifies.
  - Each secret must be at least 32 bytes (UTF-8 length for strings). Shorter secrets, duplicates
    and an empty array are rejected at boot (`invalidOption`, ZNIGHT005).
  - Secrets are imported once at bootstrap with `crypto.createSecretKey()`.
  - The README recommends `crypto.randomBytes(32).toString('base64url')` and loading the list
    with `@znight/config` `@Secret`.
- **Wire format.** `<encoded value>.<signature>`, where the signature is
  `base64url(HMAC-SHA256(secret, "<name>=<encoded value>"))`: 43 characters, without padding.
  - The MAC covers the **name**, so a valid `a` value replayed as cookie `b` fails, and `sid` and
    `__Host-sid` have different signatures.
  - The base64url alphabet has no `.`, so verification splits at the **last** `.` (values may
    contain dots).
  - The format is not compatible with Express `cookie-parser` (`s:` prefix, MAC over the value
    only). Interoperability is a non-goal, and the name binding is worth it.
- **Verification.**
  - The signature must have exactly 43 characters.
  - The MAC is recomputed for every secret in order and compared with `crypto.timingSafeEqual`.
  - When one matches, the decoded value is returned. Otherwise the cookie **does not exist**
    (`undefined`): no 400 "bad signature" and no oracle. A cookie signed with a retired key
    behaves the same way.
- **Why `node:crypto` and not WebCrypto.** `crypto.subtle.sign` is async-only, which would make
  `ctx.setCookie`, `ctx.signedCookie` and the generated `invoke` arrows async for every cookie
  route. `createHmac` and `timingSafeEqual` are synchronous and available on Node.js 24 and Bun
  1.3, the two supported runtimes (architecture §1, principle 5). The module (`cookie-signer.ts`) is only
  imported by the runtime entry, never by `@znight/http/compiler`.
- **Rotation.**
  1. Deploy `secrets: [next, current]`. New cookies use `next`, and old ones still verify.
  2. Wait for the longest cookie lifetime, then deploy `[next]`.

  Nothing is re-signed automatically (the server does not know the original attributes). Calling
  `setCookie` again migrates a cookie.
- **Limits, documented in the security section.**
  - Signing gives integrity, not confidentiality: the value can be read by the client.
  - The MAC does not cover an expiry: a stolen signed cookie stays valid until rotation. Put an
    expiry inside the value when it matters. Sessions are out of scope.
- **Missing secrets.**
  - **Boot check.** A route with a `signedCookie` parameter while `cookies.secrets` is not set
    fails `onBootstrap` with **ZNIGHT006**:
    `HttpPlugin: AuthController.me reads a signed cookie (@SignedCookie('__Host-uid')) but cookies.secrets is not set`.
  - **At runtime.** `ctx.signedCookie()` or `{ signed: true }` without secrets throws an `Error`
    with the same hint (a 500, logged).
- **`plugin.signCookie(name, value): string`** returns the signed wire value. It is used by the
  testing support and by integrations (a gateway minting cookies).

### 4.6 SSE: user-facing API

```ts
// src/orders/order-events.controller.ts
import { setTimeout as sleep } from 'node:timers/promises'
import {
  Body,
  Controller,
  Ctx,
  Headers,
  type HttpContext,
  HttpResponse,
  NotFoundException,
  Param,
  Post,
  Sse,
  type SseEvent,
} from '@znight/http'

@Controller('/orders')
export class OrderEventsController {
  constructor(
    private readonly orders: OrderService,
    private readonly hub: OrderHub,
    private readonly llm: Llm,
  ) {}

  /** 1. Recommended shape: an async method does the pre-flight checks, then returns the source. */
  @Sse('/:id/events', { retry: 5_000, maxDuration: 30 * 60_000 })
  async events(
    @Param('id') id: string,
    @Headers('last-event-id') lastEventId: string | undefined, // sent by EventSource on reconnection
    @Ctx() ctx: HttpContext,
  ): Promise<AsyncIterable<SseEvent<OrderEvent>> | HttpResponse> {
    const order = await this.orders.find(id)
    if (order === undefined) throw new NotFoundException(`Order ${id} not found`) // a regular 404 (EventSource stops)
    if (order.closed) return HttpResponse.noContent() // 204: EventSource stops reconnecting (HTML spec)
    return this.hub.subscribe(id, { after: lastEventId, signal: ctx.signal })
  }

  /** 2. An async generator: its body runs once the stream is open (it cannot answer 404 anymore). */
  @Sse('/clock', { heartbeat: false })
  async *clock(@Ctx() ctx: HttpContext): AsyncGenerator<SseEvent<{ now: string }>> {
    while (!ctx.signal.aborted) {
      yield { event: 'tick', data: { now: new Date().toISOString() } }
      await sleep(1_000, undefined, { signal: ctx.signal }).catch(() => undefined)
    }
  }

  /** 3. Any method: LLM-style POST streaming for fetch() clients (EventSource only does GET). */
  @Post('/:id/assistant')
  assistant(@Param('id') id: string, @Body(Prompt) prompt: Prompt, @Ctx() ctx: HttpContext) {
    return HttpResponse.sse(this.llm.complete(id, prompt, { signal: ctx.signal })) // 200, not 201
  }
}
```

```ts
// src/orders/order-hub.ts: push-based fan-out with bounded, per-client buffers
import { EventChannel, type SseEvent } from '@znight/http'

@Injectable()
export class OrderHub {
  readonly #subscribers = new Map<string, Set<EventChannel<SseEvent<OrderEvent>>>>()
  constructor(private readonly store: OrderEventStore) {}

  subscribe(orderId: string, options: { after?: string; signal: AbortSignal }): AsyncIterable<SseEvent<OrderEvent>> {
    // overflow 'close': a client that falls behind is disconnected; it reconnects with Last-Event-ID
    // and catches up from the store, instead of the server buffering without bound
    const channel = new EventChannel<SseEvent<OrderEvent>>({ capacity: 256, overflow: 'close', signal: options.signal })
    const set = this.#subscribers.get(orderId) ?? new Set()
    this.#subscribers.set(orderId, set.add(channel))
    channel.onClose(() => set.delete(channel))
    for (const missed of this.store.since(orderId, options.after)) channel.push(toSseEvent(missed))
    return channel
  }

  publish(event: OrderEvent): void {
    for (const channel of this.#subscribers.get(event.orderId) ?? []) channel.push(toSseEvent(event))
  }
}

const toSseEvent = (event: OrderEvent): SseEvent<OrderEvent> => ({ id: event.sequence, event: event.type, data: event })
```

#### `@Sse` and `HttpResponse.sse`

```ts
export interface SseOptions {
  /**
   * Milliseconds without an event after which a keep-alive comment (`:`) is sent. `false` disables
   * it. Default: plugin `sse.heartbeat` (8 000).
   */
  readonly heartbeat?: number | false
  /** Client reconnection delay (`retry:`, ms), sent first. Default: plugin `sse.retry` (none: browsers use ~3 s). */
  readonly retry?: number
  /** The server ends the stream gracefully after this many ms (load rebalancing, re-authentication). Default: none. */
  readonly maxDuration?: number
}

/** A `GET` route serving an event stream (static `path` and `options`). */
export function Sse(path?: string, options?: SseOptions): MethodMarker
export function Sse(options: SseOptions): MethodMarker

/** What `@Sse` handlers and `HttpResponse.sse()` accept. */
export type SseSource =
  | AsyncIterable<SseEvent | Uint8Array> // async generators, EventChannel, Node.js Readable (raw bytes)
  | Iterable<SseEvent> // arrays, sync generators (not strings)
  | ReadableStream<SseEvent | Uint8Array>

class HttpResponse<T> {
  /** An event stream on any route (status 200 unless `@HttpCode` / `.withStatus()`). */
  static sse(source: SseSource, options?: SseOptions): HttpResponse<SseBody>
}
```

#### `SseEvent` and framing

```ts
export interface SseEvent<T = unknown> {
  /** A string is sent as is. Anything else goes through `JSON.stringify` (`toJSON` honoured). */
  readonly data?: T
  /** Event type (`addEventListener(type)`). The client defaults to `message`. No CR or LF. */
  readonly event?: string
  /** Last event id, echoed by the client as `Last-Event-ID`. No CR, LF or NUL. `''` resets it. */
  readonly id?: string | number
  /** Reconnection delay in ms (a safe integer ≥ 0). */
  readonly retry?: number
  /** Comment lines, ignored by EventSource (debugging, padding). */
  readonly comment?: string
}
```

**Item rules (normative).**

1. **Event objects.** A plain object with only the keys above is encoded as one event. Rejected
   with a `TypeError`: an empty object, unknown keys, `event` or `id` containing CR / LF (and NUL
   for `id`), a non-integer `retry`, a `data` that `JSON.stringify` cannot serialise (`bigint`,
   `undefined` from a function).
2. **Raw bytes.** A `Uint8Array` item (including a `Buffer` from a Node.js `Readable`) is written
   **as is**. It is meant to be already-framed SSE text from an upstream: proxying an LLM
   provider, or another service. It is not validated.
3. **Anything else** (strings, numbers, `null`) is a `TypeError`: "yield `{ data: value }`".
   Strings are rejected rather than guessed, because "data" and "raw SSE text" are equally
   plausible readings.

**Encoding (normative)** of one event. The fields come in this order and the event ends with an
empty line:

- one `: <line>` per line of `comment`;
- `id: <id>`;
- `event: <event>`;
- `retry: <retry>`;
- one `data: <line>` per line of the data string. The string is split on `\r\n`, `\r` and `\n`,
  so data can never inject fields or end the event early. A trailing newline round-trips as an
  empty last line.

`data: ` always carries the space, so values starting with a space survive the parser's
single-space strip. When `event` is set and `data` is absent, an empty `data:` line is written:
without it, EventSource would not dispatch the event (HTML "dispatch the event" step:
empty data buffer), and `{ event: 'done' }` would silently vanish. Events with only `id`, `retry`
or `comment` carry no data line (no dispatch, which is intended). Output is UTF-8 without BOM, and
each event is one chunk.

```text
HTTP/1.1 200 OK
content-type: text/event-stream; charset=utf-8
cache-control: no-cache, no-transform
x-accel-buffering: no
x-request-id: 4c1e…
transfer-encoding: chunked

retry: 5000

id: 41
event: status
data: {"orderId":"o-1","status":"paid"}

:

data: line 1
data: line 2

retry: 7342

```

(Preamble, one event, one heartbeat, one multi-line event, and the jittered `retry` written at
shutdown.)

#### Handler results on an `@Sse` route

| Result (after awaiting)                                        | Response                                                                                                                                                           |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AsyncIterable`, `Iterable` (not a string), `ReadableStream`   | 200 event stream                                                                                                                                                   |
| `HttpResponse.sse(...)`                                        | 200 event stream, plus its headers and cookies                                                                                                                     |
| Any other `HttpResponse`, a Web `Response`, a thrown exception | Sent as usual. Use 204 to tell EventSource to stop, or 401/404 to fail it without reconnection.                                                                    |
| `undefined`, a string, any other value                         | 500, logged: `TypeError: @Sse handler OrderEventsController.events must return an AsyncIterable, an Iterable or a ReadableStream of SseEvent (received undefined)` |

The README stresses the `async` versus `async *` distinction. The body of an async generator only
runs once the 200 and the headers are committed, so pre-flight checks (existence, authorization
beyond guards) belong in an `async` method that _returns_ the source.

### 4.7 SSE: stream lifecycle (normative)

The stream is produced by `openSseStream()` (`sse.ts`). It wraps the source in a pull-based byte
stream (`highWaterMark: 0`). The pipeline then hands that stream to the existing `trackStream`.

1. **Open.** The first chunk is written **immediately**, without touching the source: `retry: N`
   when a retry is configured, otherwise the comment `:`. This forces every adapter to flush the
   status and headers at once. Node.js only writes headers on the first `write()`, so without it
   `EventSource.onopen` would wait for the first event. The `inject()` streaming mode also
   resolves at headers.
2. **Events.** Each consumer pull calls `next()` (or `read()`) on the source **once**. Nothing is
   read ahead. A slow client stops pulling, so the source is not read: **backpressure** is end to
   end on every adapter, inherited from `trackStream` and the adapters' pipes. A push-based
   source buffers in its own structure: `EventChannel` is bounded (§4.10).
3. **Heartbeat.** While a pull has waited `heartbeat` ms without an event, the comment `:` is
   enqueued and the pull returns. The pending `next()` is kept for the next pull.
   - Heartbeats are only produced for a waiting consumer, so they never pile up for a slow client.
   - Heartbeats are never inserted in the middle of raw bytes that do not end at an event
     boundary (`\n\n`, `\r\r`, `\r\n\r\n`). This keeps proxied upstream streams intact.
   - **The default is 8 000 ms.** It is below every common idle timeout: `Bun.serve()` 10 s (when
     the adapter cannot lift it, §4.9), nginx `proxy_read_timeout` 60 s, AWS ALB 60 s, Heroku 55 s,
     Cloudflare 100 s. Three bytes every 8 s per client is negligible.
   - Timers are `unref()`'d.
4. **End: the source is done.** The stream closes and the response ends normally. EventSource
   then **reconnects** (that is the protocol). To stop a client for good, the application sends
   an event its client understands (`{ event: 'done' }` followed by `es.close()`), or answers
   204 on the next connection.
5. **End: the source fails, or an item is invalid.** The error is logged
   (`The SSE stream failed`, with `requestId`, `path` and `err`). For an invalid item, the source
   is stopped (`return()`). The response then **ends cleanly** without any extra event.
   - This differs from `HttpResponse.stream()`, which closes the connection abruptly on failure.
     A truncated download must be visible, but SSE events are self-delimited: a client's parser
     drops an incomplete event, and EventSource reconnects either way.
   - There is no automatic `event: error`. That name collides with EventSource's own `error`
     event. Applications catch the error and yield their own event.
6. **End: client disconnect.** The adapter cancels the body (existing contract). The stream then:
   1. aborts `ctx.signal` with `RequestAbortedError { kind: 'client' }`;
   2. stops the source (`iterator.return()` / `reader.cancel()`);
   3. waits for the source to stop for **at most 5 s** (`SOURCE_STOP_TIMEOUT_MS`, internal). After
      that it logs a warning, `The SSE source did not stop within 5000 ms after its signal was
      aborted: make it honour ctx.signal`, and lets the request scope close anyway. This bounds
      the leak caused by an async generator blocked in an `await` that ignores the signal (§2).
7. **End: `maxDuration` and shutdown (graceful close).** `ctx.signal` aborts with
   `kind: 'expired'` or `kind: 'shutdown'`.
   1. The stream keeps pulling the source for up to `sse.shutdownGraceMs` (default 1 000 ms). A
      source watching the signal can yield final events and finish by itself. `EventChannel`
      flushes its buffer, then ends.
   2. Then `retry: R` is written, where R is drawn uniformly in `[r, 2r]` and
      r = route `retry` ?? plugin `sse.retry` ?? 3 000 ms. The jitter spreads the reconnection
      storm of a rolling deployment.
   3. The source is stopped (rule 6, steps 2 and 3) and the response ends cleanly.
8. **HEAD and bodyless statuses.** A `HEAD` request to an `@Sse` route answers the headers only.
   The stream is cancelled before its first pull, so an async generator body never runs. The
   cancel also aborts `ctx.signal` (`'client'`), which releases a subscription created in a
   pre-flight.

**`ctx.signal` and `RequestAbortedError`** are new for every route, not only SSE:

```ts
export class RequestAbortedError extends Error {
  readonly name = 'AbortError' // what fetch, timers/promises and most libraries check
  readonly kind: 'client' | 'shutdown' | 'expired'
}
```

- `ctx.signal` is created lazily. It aborts **at most once**, when one of these happens:
  - the client disconnects before the response was fully written (`AdapterRequest.onAbort`,
    §4.11);
  - the adapter cancels the response body;
  - an SSE stream is closed by the server (`'shutdown'`, `'expired'`).
- It **never** aborts after a normal completion, so it can be handed to work that outlives the
  response. The plugin ignores adapter aborts once the request's `done` promise has settled. This
  matters on Bun, where `Request.signal` may fire after the response.
- Ordinary in-flight requests are **not** aborted on shutdown. They drain as today
  (`drainTimeoutMs`), and only SSE streams are closed actively.

**Shutdown sequence (normative), in `HttpPlugin.onStop`:**

1. `pipeline.draining = true`, which already adds `connection: close` to responses.
2. `pipeline.closeStreams('shutdown')`: every open SSE stream enters rule 7.
3. `adapter.close()`, then wait for `pipeline.whenIdle()` until `drainTimeoutMs` (unchanged). SSE
   streams end after about `shutdownGraceMs` instead of holding the drain until its timeout and
   the forced close.
4. An SSE request that arrives on a kept-alive connection while draining is served normally (its
   guards run). Its signal is aborted from the start (`'shutdown'`), so a well-behaved source ends
   at once and the client receives the jittered `retry`. Answering 503 instead would make
   EventSource **fail permanently**: per the HTML spec, a non-200 status is not retried.

`shutdownGraceMs` must be lower than `drainTimeoutMs` (when that one is finite). Otherwise the
boot fails with ZNIGHT005 (`invalidOption`).

### 4.8 SSE: response headers, status, scope, interceptors, hooks

**Headers.**

- Defaults, set before the existing precedence chain (`@Header` < `ctx.setHeader` <
  `HttpResponse` headers), so the application can override them:
  - `cache-control: no-cache, no-transform`. `no-cache` stops CDN and browser caching.
    `no-transform` makes intermediaries **and** compression middleware leave the body alone.
  - `x-accel-buffering: no` stops nginx response buffering.
- Set **last**, so no override is possible:
  `content-type: text/event-stream; charset=utf-8`. EventSource fails on any other essence, and
  the charset parameter is ignored by clients but documents UTF-8.
- Never set:
  - `connection: keep-alive`. It is forbidden in HTTP/2, and Node.js and Bun manage it.
  - `content-length`.
  - `transfer-encoding`. Adapters chunk by themselves.
- The request id and, while draining, `connection: close` are added as for any response.

**Status.** 200. `@HttpCode` on `@Sse` is a build error (§5.3). `HttpResponse.sse()` defaults to
200 even on `POST` routes (not 201). An explicit `.withStatus()` or `@HttpCode` on a non-`@Sse`
route is honoured but documented: EventSource requires 200.

**Request scope.**

- Request-scoped instances and the in-flight count live until the stream ends. This is inherited
  from `trackStream`.
- The source runs in the handler's async context, so `Lazy<HttpContext>`, request-scoped
  providers and tracing keep working while it produces events.
- One scope is held per connected client. The README recommends keeping request-scoped state
  small on SSE routes.

**Guards, interceptors, mappers.**

- Guards run before the stream: authentication happens when the stream connects.
- Interceptors see the handler result (the source) and may wrap or map it. Their `finally` blocks
  run when the handler returns, before the stream ends.
- Exception mappers only apply before the stream starts.

**Hooks and observability.**

- `http:request` resolves when the stream opens (`status: 200`), so request logs, the
  `http_server_request_duration_seconds` histogram and tracing spans measure the time to open.
  This is documented. A stream-lifetime hook is a non-goal.
- `plugin.streams` (a `number`) exposes the open SSE streams for health checks and gauges.

### 4.9 SSE: proxies, compression, timeouts

| Concern                                                                                                           | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Headers are not flushed** (Node.js writes them on the first `write()`; some proxies wait for bytes)             | Immediate preamble chunk (§4.7 rule 1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **nginx buffering**                                                                                               | `x-accel-buffering: no`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Caching proxies, CDNs**                                                                                         | `cache-control: no-cache, no-transform`. The README adds per-CDN notes (Cloudflare streams `text/event-stream`, and its 100 s idle limit is covered by heartbeats).                                                                                                                                                                                                                                                                                                                                                                          |
| **Compression** (Znight has none; user middleware: Express `compression()`, `hono/compress`, `@fastify/compress`) | `no-transform` is honoured by `compression()` and `hono/compress`, and the latter also skips `text/event-stream` (checked in Hono 4.13 sources). On Fastify, `onSend` hooks (compression, ETag plugins) can rewrite any payload, so the Fastify adapter sends `eventStream` replies through `reply.hijack()` (§4.11): no `onSend` hook ever touches an event stream, whatever plugins the user registered. Compressing an SSE stream would also require a flush per event, and invites BREACH when secrets and attacker data share a stream. |
| **`Bun.serve()` `idleTimeout`** (10 s default)                                                                    | `honoAdapter().listen()` already sets `server.timeout(request, 0)` for every streamed body, then restores it. When users mount `adapter.fetch` in their **own** `Bun.serve()`, the adapter cannot lift it, so the 8 s default heartbeat keeps the connection alive. The README says to keep `heartbeat < idleTimeout` there.                                                                                                                                                                                                                 |
| **Node.js timeouts**                                                                                              | `requestTimeout` and `headersTimeout` only cover receiving the request, and `keepAliveTimeout` only applies between requests. For `AdapterReply.eventStream` (§4.11), `node-io` calls `response.setTimeout(0)`, so a user-configured socket `timeout` (or Bun's `node:http` emulation) never cuts a quiet stream.                                                                                                                                                                                                                            |
| **HTTP/1.1 browser limit** (6 connections per origin, shared with SSE)                                            | Documented: serve over HTTP/2 at the edge, or multiplex topics on one stream.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **HTTP/2**                                                                                                        | Nothing connection-specific is sent, so streams work through h2 proxies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### 4.10 `EventChannel`: bounded push to pull bridge

Pull-based sources are the only way to get real backpressure, but most event producers push (a
bus, an `EventEmitter`, a database listener). `EventChannel` is a small, dependency-free bridge.
It is generic (not SSE-specific), so a future GraphQL subscription transport or messaging can use
it too.

```ts
export interface EventChannelOptions {
  /** Buffered items before `overflow` applies. Default: 1 000. */
  readonly capacity?: number
  /**
   * `'drop-oldest'` (default): the oldest buffered item is discarded.
   * `'drop-newest'`: `push()` returns false.
   * `'close'`: the channel closes after the buffer (the client reconnects and resumes with Last-Event-ID).
   */
  readonly overflow?: 'drop-oldest' | 'drop-newest' | 'close'
  /** Closes the channel when aborted (pass `ctx.signal`). */
  readonly signal?: AbortSignal
}

export class EventChannel<T> implements AsyncIterable<T> {
  constructor(options?: EventChannelOptions)
  /** Buffers an item. Returns false when it was dropped or the channel is closed. */
  push(item: T): boolean
  /** Ends the iteration after the buffered items. Idempotent. */
  close(): void
  /** Makes the iteration throw `error` after the buffered items. */
  fail(error: unknown): void
  /** Called once when the channel closes (close, fail, overflow, signal, consumer `return()`). */
  onClose(listener: () => void): void
  readonly size: number
  readonly closed: boolean;
  /** Single consumer (a second iterator throws). `return()` closes the channel and resolves immediately, even while `next()` waits. */
  [Symbol.asyncIterator](): AsyncIterator<T>
}
```

The key property is that a pending `next()` resolves with `{ done: true }` as soon as the channel
closes for any reason. An SSE handler built on a channel therefore never hits the blocked-`await`
problem of §4.7 rule 6.

### 4.11 Adapter specifics and contract changes (architecture §9.1)

```ts
interface AdapterRequest {
  // … existing members
  /**
   * Registers a listener called once when the client disconnects before the response was fully
   * written. When it already happened, the listener is called on the next microtask. Never called
   * after a complete response. Optional: without it, `ctx.signal` only aborts when the response
   * body is cancelled or an SSE stream is closed by the server.
   */
  onAbort?(listener: () => void): void
}

interface AdapterReply {
  // … existing members
  /**
   * The body is a long-lived event stream. Adapters MUST NOT apply idle or inactivity timeouts to
   * the response while it is sent, and MUST write each chunk as soon as it is read (no buffering).
   */
  readonly eventStream?: boolean
}

interface InjectRequest {
  // … existing members
  /** Request cookies, encoded like `serializeCookie` values, appended to any `cookie` header. */
  readonly cookies?: Readonly<Record<string, string>>
  /** Cookies signed by `HttpPlugin` before dispatch (adapters never receive this field). */
  readonly signedCookies?: Readonly<Record<string, string>>
}

interface InjectResponse {
  // … existing members
  /** `set-cookie` parsed, by name (the last one wins). */
  readonly cookies: Readonly<Record<string, SetCookieInfo>>
}

interface HttpAdapter {
  // … existing members
  /**
   * In-memory request whose body is returned as it is produced. Cancelling `body` disconnects the
   * client: the server sees `onAbort` and a cancelled reply body. Optional for third-party
   * adapters; the four built-in adapters implement it.
   */
  injectStream?(request: InjectRequest & { readonly signal?: AbortSignal }): Promise<InjectStreamResponse>
}

interface InjectStreamResponse {
  readonly status: number
  readonly headers: Record<string, string | string[]>
  readonly cookies: Readonly<Record<string, SetCookieInfo>>
  readonly body: ReadableStream<Uint8Array>
}

/** A parsed `Set-Cookie` line (`parseSetCookie(line)`, exported). */
export interface SetCookieInfo {
  readonly name: string
  readonly value: string // decoded (signed cookies: "<value>.<signature>", decoded)
  readonly raw: string // the header line
  readonly expires?: Date
  readonly maxAge?: number
  readonly domain?: string
  readonly path?: string
  readonly secure: boolean
  readonly httpOnly: boolean
  readonly sameSite?: 'strict' | 'lax' | 'none'
  readonly partitioned: boolean
  readonly priority?: 'low' | 'medium' | 'high'
}
```

Because the encoder is canonical, `encode(decode(w)) === w` holds for every value Znight
produces. A test can therefore send `res.cookies.x.value` back through `cookies`, and that
includes signed values.

**Per adapter:**

| Adapter   | `onAbort`                                                                                                                           | `eventStream`                                                                                                                                                                                                                                                                      | `injectStream`                                                                                                                                                                                                                                                                                         |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `node`    | `response.once('close')` with `!response.writableFinished`. Immediate call if the response is already `destroyed` and not finished. | `response.setTimeout(0)`                                                                                                                                                                                                                                                           | light-my-request with `payloadAsStream: true` and `signal`. It resolves at `writeHead`.`body = Readable.toWeb(res.stream())`. Cancelling it calls `res.raw.res.destroy()`, so the server response emits `close`: `writeNodeReply`'s `pipeline` fails, the reply body is cancelled and `onAbort` fires. |
| `express` | Same on the Express `Response`                                                                                                      | Same (`writeNodeReply`)                                                                                                                                                                                                                                                            | Same through the existing `#injectListener` (prototype pinning)                                                                                                                                                                                                                                        |
| `fastify` | `reply.raw.once('close')`                                                                                                           | `reply.hijack()`. The headers Fastify hooks already set (`reply.getHeaders()`, e.g. a helmet `onRequest` hook) are merged under the plugin's, then the shared `writeNodeReply(reply.raw, …)` runs and calls `setTimeout(0)`. No `onSend` hook (compression, ETag) sees the stream. | `instance.inject({ …, payloadAsStream: true, signal })` (Fastify forwards options to light-my-request 6.8), then the same mechanics through `response.raw.res`                                                                                                                                         |
| `hono`    | Bun: `c.req.raw.signal`. Node.js: `c.env.outgoing` `close` without `writableFinished`.                                              | Bun via `listen()`: `server.timeout(request, 0)`, already done for every stream. Node.js (`@hono/node-server`): `outgoing.setTimeout(0)`.                                                                                                                                          | `app.request(new Request(url, { …init, signal }))`; `body = response.body`. Cancelling it aborts the request signal and cancels the body.                                                                                                                                                              |

**`inject()` is rebuilt on `injectStream()`** in the four built-in adapters. It reads the body to
its end, except when the response `content-type` is `text/event-stream`: then it cancels and
rejects with
`TypeError: inject(): GET /orders/1/events answered an event stream (text/event-stream): use injectSse() or injectStream()`.
Today it hangs forever. For third-party adapters without `injectStream`, the behaviour is
unchanged.

`normalizeInject()` (shared) builds the `cookie` header: `name=encoded` pairs joined with `; `
and appended after an explicit `cookie` header. `injectResponse()` (shared) parses
`set-cookie` into `cookies`. Both are used by every adapter, so the behaviour is the same
everywhere.

### 4.12 Testing support

**Cookies (`HttpPlugin.inject`, `TestApp.inject`):**

```ts
const login = await app.inject({ method: 'POST', url: '/auth/login', body: { email, password } })
expect(login.cookies['__Host-uid']).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' })

const me = await app.inject({ url: '/auth/me', cookies: { '__Host-uid': login.cookies['__Host-uid'].value } })
const forged = await app.inject({ url: '/auth/me', signedCookies: { '__Host-uid': 'u-1' } }) // signed with secrets[0]
const tampered = await app.inject({ url: '/auth/me', cookies: { '__Host-uid': 'u-2.AAAA' } }) // 400 Missing cookie
```

`signedCookies` is signed by `HttpPlugin.inject()` / `injectStream()` / `injectSse()` and merged
into `cookies` before the adapter is called. Without secrets it throws a `TypeError`.

**SSE (`HttpPlugin.injectSse`, `TestApp.injectSse`):**

```ts
await using stream = await app.injectSse({ url: '/orders/o-1/events' })
expect(stream.status).toBe(200)
expect(stream.retry).toBe(5_000)

hub.publish({ orderId: 'o-1', sequence: 42, type: 'status', status: 'paid' })
const event = await stream.next() // rejects after 2 000 ms by default
expect(event).toMatchObject({ event: 'status', id: '42' })
expect(event.json()).toMatchObject({ status: 'paid' })

const resumed = await stream.reconnect() // same request plus `last-event-id: 42`, like EventSource
await stream.close() // the server sees a client disconnect: ctx.signal aborts, the channel closes
```

```ts
export interface InjectSseResponse extends AsyncIterable<SseMessage> {
  readonly status: number
  readonly headers: Record<string, string | string[]>
  readonly cookies: Readonly<Record<string, SetCookieInfo>>
  /** '' for an event stream. Otherwise the whole body, read to its end (an error, a 204). */
  readonly body: string
  json<T = unknown>(): T
  /** Next event (comments skipped). Rejects on timeout (default 2 000 ms) or when the stream ended. */
  next(options?: { readonly timeoutMs?: number }): Promise<SseMessage>
  take(count: number, options?: { readonly timeoutMs?: number }): Promise<SseMessage[]>
  /** Comments received so far (heartbeats are `''`). */
  readonly comments: readonly string[]
  /** What a browser would send as `Last-Event-ID`. */
  readonly lastEventId: string
  /** The last `retry` received. */
  readonly retry: number | undefined
  /** Resolves when the server ends the stream. */
  readonly done: Promise<void>
  /** Disconnects (cancels the body). Idempotent. */
  close(): Promise<void>
  /** Reconnects like EventSource: the same request plus `last-event-id`. */
  reconnect(): Promise<InjectSseResponse>
  [Symbol.asyncDispose](): Promise<void>
}

export interface SseMessage {
  readonly event: string // 'message' by default
  readonly data: string
  readonly id: string // last event id at dispatch time
  json<T = unknown>(): T
}
```

**Over real sockets**, `parseSseStream(body, { signal? })` (exported) turns any
`ReadableStream<Uint8Array>` into `AsyncIterableIterator<SseItem>`, where
`SseItem = ({ type: 'event' } & SseMessage) | { type: 'comment'; text } | { type: 'retry'; retry }`.
It implements the WHATWG "interpreting an event stream" algorithm:

- UTF-8 decoding with the BOM stripped;
- CR, LF and CRLF line ends, including a CR at the end of a chunk;
- `data` buffering with the final LF removed;
- `id` values containing NUL ignored;
- `retry` accepted only as ASCII digits;
- the event type defaulting to `message`;
- an unterminated event at EOF discarded.

```ts
const response = await fetch(`${http.address}/orders/o-1/events`)
for await (const item of parseSseStream(response.body!)) {
  /* … */
}
```

**`@znight/testing`** stays independent of `@znight/http`, so it delegates structurally, like
`inject()` does today:

- `InjectRequest` gains `cookies?` and `signedCookies?`, and `InjectResponse` gains `cookies`.
- `TestApp.injectStream(request)` and `TestApp.injectSse(request)` call the plugin named `http`
  when it has these methods. Otherwise they throw ZNIGHT001 with the hint
  "requires @znight/http ≥ 0.2".

---

## 5. Compiler changes (`@znight/http/compiler`)

### 5.1 Decorators and identities

`decorators.ts` adds three markers, documented with JSDoc like the existing ones:

```ts
export function Cookie(): ParameterMarker
export function Cookie(name: string, schema?: StandardSchemaV1): ParameterMarker
export function Cookie(schema: StandardSchemaV1): ParameterMarker
export function SignedCookie(name: string, schema?: StandardSchemaV1): ParameterMarker
export function Sse(path?: string, options?: SseOptions): MethodMarker
export function Sse(options: SseOptions): MethodMarker
```

The specs in `compiler/model.ts` and `compiler/index.ts`:

- `Ids.Cookie = '@znight/http#Cookie'`, `Ids.SignedCookie = '@znight/http#SignedCookie'` and
  `Ids.Sse = '@znight/http#Sse'`.
- `PARAM_SOURCES` gains `[Ids.Cookie, 'cookie']` and `[Ids.SignedCookie, 'signedCookie']`.
- `ROUTE_METHODS` gains `['@znight/http#Sse', 'GET']`, so `@Sse` is a route decorator for
  `reportNotARoute`, duplicates and `HEAD`.
- In `decorators`: `[Ids.Cookie]: NAME_OR_SCHEMA` and `[Ids.SignedCookie]: NAME_OR_SCHEMA`.
  `[Ids.Sse]: { targets: ['method'], params: ['static', 'static'] }` is written **after** the
  `ROUTE` spread, so it overrides the one-argument spec.

### 5.2 Analysis (`analyze.ts`)

- **`@Cookie` / `@SignedCookie`** reuse `nameAndSchema()`.
  - The name must be a non-empty RFC 9110 token (the existing `TOKEN` regexp, no import from the
    runtime). Otherwise ZNIGHT005 with the hint `@Cookie('session_id')`.
  - `@SignedCookie` requires a name (ZNIGHT005 `@SignedCookie requires a cookie name`).
  - `optional = declared.optional`: cookies may be absent, as for `@Query`.
  - With a name and without a schema, `coercionOf()` runs with source `'cookie'` (label
    `cookie "<name>"`). A non-coercible type is **ZNIGHT007**, like `@Headers` and `@Param`. The
    raw value is never passed through.
  - `@Cookie()` without a schema goes to `checkUnvalidated(…, 'cookies')`: ZNIGHT017 unless the
    type is `Record<string, string>`, `unknown` or a primitive (`acceptedWithoutSchema` already
    accepts these).
  - The "has no HTTP decorator" hint lists `@Cookie()`.
- **`@Sse`.** In `analyzeMethod`, `Ids.Sse` is a `GET` route whose arguments are
  `(path?, options?)` or `(options)`, parsed like `uploadOf` parses `(field?, options?)`. The
  options are a static object `{ heartbeat?, retry?, maxDuration? }`:
  - `heartbeat` is an integer ≥ 1 000 or `false`;
  - `retry` is an integer ≥ 0;
  - `maxDuration` is an integer ≥ 1 000;
  - any other key is ZNIGHT005.

  The result is stored as `HttpRouteData.sse: { heartbeat?: number /* 0 = disabled */; retry?: number; maxDuration?: number } | undefined`.

### 5.3 Diagnostics

| Code      | Severity                                | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ZNIGHT005 | error                                   | Invalid cookie name, `@SignedCookie` without a name, `@Cookie` and `@SignedCookie` on the same parameter (an existing rule: several HTTP decorators)                                                                                                                                                                                                                                                                                                                                                    |
| ZNIGHT005 | error                                   | `@Sse` applied twice, or combined with another route decorator on the same method (`@Sse` + `@Get`). Hint: one handler per event stream.                                                                                                                                                                                                                                                                                                                                                                |
| ZNIGHT005 | error                                   | Invalid `@Sse` options (unknown key, out-of-range value, non-static)                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ZNIGHT005 | error                                   | `@HttpCode` on an `@Sse` method (an event stream answers 200; throw or return an `HttpResponse` for other statuses)                                                                                                                                                                                                                                                                                                                                                                                     |
| ZNIGHT005 | error                                   | `@Header('content-type', …)` on an `@Sse` method (the content type is fixed)                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ZNIGHT005 | error                                   | `@Res()` on an `@Sse` method (the plugin writes the stream)                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ZNIGHT005 | error                                   | The annotated return type (after `types.awaited`, for each union member) is a primitive, a literal or `void`, e.g. `Promise<string>`. Message: `@Sse handler C.m returns string: return an AsyncIterable, an Iterable or a ReadableStream of SseEvent (or an HttpResponse)`. References, arrays, tuples, opaque types, type parameters, `any` and `unknown` are accepted, since custom `AsyncIterable` classes cannot be checked cheaply. A sync generator method (`*m()`) is accepted (an `Iterable`). |
| ZNIGHT005 | warning                                 | `@Body()` or upload parameters on an `@Sse` route: EventSource sends `GET` without a body. The hint suggests `@Post` + `HttpResponse.sse()`.                                                                                                                                                                                                                                                                                                                                                            |
| ZNIGHT007 | error                                   | `@Cookie('x')` / `@SignedCookie('x')` typed with a type that cannot be coerced (objects, other unions). Hint: use a schema.                                                                                                                                                                                                                                                                                                                                                                             |
| ZNIGHT017 | warning (error with `strictValidation`) | `@Cookie()` (whole record) typed as something other than `Record<string, string>` / `unknown`, without a schema                                                                                                                                                                                                                                                                                                                                                                                         |
| ZNIGHT006 | error, **at boot**                      | A route reads `@SignedCookie` while `cookies.secrets` is not set (§4.5)                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ZNIGHT007 | error, **at boot**                      | Hand-written metadata: `sse` on a non-`GET` route, or invalid `sse` values (`assertRoute`)                                                                                                                                                                                                                                                                                                                                                                                                              |

Example:

```text
✗ ZNIGHT005: @HttpCode has no effect on @Sse route OrderEventsController.events: an event stream answers 200
 --> src/orders/order-events.controller.ts:14:3
   |
14 |   @HttpCode(202)
   |   ^^^^^^^^^^^^^^
   = hint: Throw an HttpException or return an HttpResponse from the handler for other statuses
```

### 5.4 Generated code (`generate.ts`) and metadata

`argumentNode()` gains two cases, and `routeNode()` emits `sse` when the route has one:

| Parameter                     | Generated expression                                                     |
| ----------------------------- | ------------------------------------------------------------------------ |
| `@Cookie('sid') sid: T`       | `coerce.X(ctx.cookies['sid'], 'cookie "sid"')` (or `coerce.optional(…)`) |
| `@Cookie('sid', S)`           | `await validate(S, ctx.cookies['sid'], 'cookie "sid"')`                  |
| `@Cookie()` / `@Cookie(S)`    | `ctx.cookies as never` / `await validate(S, ctx.cookies, 'cookies')`     |
| `@SignedCookie('sid') sid: T` | `coerce.X(ctx.signedCookie('sid'), 'cookie "sid"')`                      |
| `@SignedCookie('sid', S)`     | `await validate(S, ctx.signedCookie('sid'), 'cookie "sid"')`             |

```ts
// metadata.extensions.http.controllers[i].routes (excerpt)
{
  method: 'GET',
  path: '/:id/events',
  fullPath: '/orders/:id/events',
  handler: 'events',
  meta: {},
  guards: [],
  interceptors: [],
  params: [
    { index: 0, source: 'param', name: 'id', type: 'string' },
    { index: 1, source: 'headers', name: 'last-event-id', type: 'string', optional: true },
    { index: 2, source: 'context' },
  ],
  sse: { retry: 5000, maxDuration: 1800000 }, // `sse: {}` without options; omitted for other routes
  invoke: (c: OrderEventsController, ctx: HttpContext) =>
    c.events(
      coerce.string(ctx.params['id'], 'param "id"'),
      coerce.optional(ctx.headers['last-event-id'], 'header "last-event-id"', coerce.string),
      ctx,
    ),
},
{
  method: 'GET',
  path: '/me',
  fullPath: '/auth/me',
  handler: 'me',
  meta: {},
  guards: [],
  interceptors: [],
  params: [{ index: 0, source: 'signedCookie', name: '__Host-uid', type: 'string' }],
  invoke: (c: AuthController, ctx: HttpContext) => c.me(coerce.string(ctx.signedCookie('__Host-uid'), 'cookie "__Host-uid"')),
},
```

Runtime metadata types (`metadata.ts`, architecture §9.1):

```ts
type HttpParamSource = /* existing */ 'cookie' | 'signedCookie'

interface HttpSseDefinition {
  /** Heartbeat interval in ms; `0` disables it. Absent: plugin `sse.heartbeat`. */
  readonly heartbeat?: number
  readonly retry?: number
  readonly maxDuration?: number
}
interface HttpRouteDefinition {
  // … existing members
  /** `@Sse` route: the handler result is served as an event stream (GET only). */
  readonly sse?: HttpSseDefinition
}
```

The manifest gains decorator identities `#Cookie`, `#SignedCookie`, `#Sse`. No new tokens and no
new externals (`ctx.signal` and the cookies live on `HttpContext`).

---

## 6. Runtime changes per file

| File                                          | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/cookies.ts` (**new**, import-free)       | `parseCookieHeader`, `encodeCookieValue` / `decodeCookieValue`, `serializeCookie`, `serializeClearCookie`, `parseSetCookie`, `validateCookie` (names, attributes, prefixes, sizes), the `CookieJar` (keyed merge, insertion order), and the types `CookieOptions`, `CookieDefaults`, `ClearCookieOptions`, `ResponseCookie`, `SetCookieInfo`. Pure, so it is safe to import from anywhere.                                                                                                                                                                                                |
| `src/cookie-signer.ts` (**new**)              | `CookieSigner` (`node:crypto` `createSecretKey`, `createHmac('sha256')`, `timingSafeEqual`): `sign(name, encoded)` and `verify(name, wire) → encoded \| undefined`.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `src/sse.ts` (**new**)                        | The types `SseEvent`, `SseOptions`, `SseSource`, `SseBody` (a marker like `FileBody`, plus `isSseBody`); `encodeSseEvent`; `openSseStream(source, settings, session)`, which implements the preamble, pull loop, heartbeat timer, raw-byte boundary tracking, error handling, the graceful-close sequence, the bounded source stop and the jittered final `retry`; and `SseSession` (`abort(kind)`, `closed`).                                                                                                                                                                            |
| `src/sse-parse.ts` (**new**, import-free)     | `parseSseStream`, and the types `SseItem` and `SseMessage`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/event-channel.ts` (**new**)              | `EventChannel` (§4.10).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/context.ts`                              | `RequestContext` gains `cookies` (lazy), `signedCookie()` (memoised), `setCookie` / `clearCookie` / `responseCookies` (a jar validated with the plugin settings), `signal` (lazy `AbortController`; subscribes to `source.onAbort` on creation; an abort that happened before the first access is remembered, so the signal is created already aborted), the internal `abort(kind)`, `commit()` (sets the "headers sent" flag) and `complete()` (ignores later aborts). Init gains `cookies: CookieSettings` (`{ defaults, signer }`). Also `RequestAbortedError`.                        |
| `src/response.ts`                             | `HttpResponse` gains `cookies`, `withCookie`, `withoutCookie` and `static sse()`.`withHeader` / `withStatus` keep the cookies.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `src/serialize.ts`                            | `SerializedReply.cookies?` (the `HttpResponse` jar, carried to `#complete`); `serializeSseReply(stream, response, options)` (SSE headers, status 200 unless `@HttpCode` / `HttpResponse.status`, `eventStream: true`); an SSE body with `HEAD` / bodyless status discards the stream as today.                                                                                                                                                                                                                                                                                            |
| `src/pipeline.ts`                             | `serialize()` handles `isSseBody`, and wraps raw sources when `definition.sse` is set (plain `HttpResponse` and `Response` results pass through). It throws the `@Sse` `TypeError` for other values. `#complete` appends the merged jars to `set-cookie` and validates them (an invalid cookie becomes the generic 500, logged). `#serve` calls `ctx.commit()` before handing the reply and `ctx.complete()` when `done` settles. It keeps `#streams: Set<SseSession>` and adds `closeStreams(kind)` and `get streams()`.`PipelineOptions` gains `cookies` and `sse` (resolved defaults). |
| `src/plugin.ts`                               | Options `cookies: { secrets?, defaults? }` and `sse: { heartbeat?, retry?, shutdownGraceMs? }` (§7), validated in `resolve()`. Boot checks: ZNIGHT006 for signed cookie parameters without secrets, and `assertRoute` validates `sse` (ZNIGHT007). `onStop` calls `pipeline.closeStreams('shutdown')` right after `draining = true`. New members: `inject()` with `signedCookies`, `injectStream()`, `injectSse()`, `signCookie()` and `streams`.                                                                                                                                         |
| `src/metadata.ts`                             | `HttpParamSource` and `HttpSseDefinition` / `HttpRouteDefinition.sse` (§5.4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `src/coerce.ts`                               | Labels starting with `cookie ` never echo the received value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `src/adapter.ts`                              | `AdapterRequest.onAbort?`, `AdapterReply.eventStream?`, `InjectRequest.cookies?` / `signedCookies?`, `InjectResponse.cookies`, `HttpAdapter.injectStream?`, `InjectStreamResponse` (§4.11)                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/adapters/shared.ts`                      | `normalizeInject` builds the cookie header; `injectResponse` parses cookies; `bufferInjectStream()` (shared `inject()` on top of `injectStream()`, with the event-stream rejection); `injectNodeStream()` (light-my-request streaming) and `injectFetchStream()`                                                                                                                                                                                                                                                                                                                          |
| `src/adapters/node-io.ts`                     | `onAbort` in `nodeAdapterRequest`; `response.setTimeout(0)` for `eventStream` in `writeNodeReply`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `src/adapters/{node,express,fastify,hono}.ts` | `onAbort`, `eventStream` handling (Fastify: `reply.hijack()`), `injectStream`, `inject` built on `injectStream` (§4.11 table)                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `src/decorators.ts`                           | `Cookie`, `SignedCookie`, `Sse` (+ `SseOptions` type)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/index.ts`                                | Exports: `Cookie`, `SignedCookie`, `Sse`, `EventChannel`, `RequestAbortedError`, `parseCookieHeader`, `serializeCookie`, `parseSetCookie`, `parseSseStream`, `encodeSseEvent`, and the types `CookieOptions`, `CookieDefaults`, `ClearCookieOptions`, `ResponseCookie`, `SetCookieInfo`, `SseEvent`, `SseOptions`, `SseSource`, `SseMessage`, `SseItem`, `EventChannelOptions`, `InjectStreamResponse`, `InjectSseResponse`, `HttpSseDefinition`                                                                                                                                          |
| `packages/testing/src/test-app.ts`            | `InjectRequest.cookies?` / `signedCookies?`, `InjectResponse.cookies`, `injectStream()` and `injectSse()` with structural delegation (`HttpStreamInjector`)                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/http/package.json`                  | `znight` manifest: no change (decorator identities are not listed there). No new dependency, peer or subpath.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

**Boundaries.** `cookies.ts` and `sse-parse.ts` are import-free. The compiler does not import them
(it reuses its own `TOKEN`). `tests/boundaries.test.ts` needs no change.

## 7. Plugin options

```ts
interface HttpPluginOptions {
  // … existing options
  readonly cookies?: {
    /** HMAC keys (≥ 32 bytes each). The first signs and all verify. Default: none (signed cookies unavailable). */
    readonly secrets?: string | Uint8Array | readonly (string | Uint8Array)[]
    /** Default: `{ path: '/', secure: true, httpOnly: true, sameSite: 'lax' }`. */
    readonly defaults?: CookieDefaults
  }
  readonly sse?: {
    /** Default heartbeat (ms, ≥ 1 000, or false). Default: 8 000. */
    readonly heartbeat?: number | false
    /** Default `retry` sent first (ms). Default: none. */
    readonly retry?: number
    /** Time an SSE source gets to finish after `ctx.signal` aborted on shutdown / maxDuration (ms). Default: 1 000. Must be < drainTimeoutMs. */
    readonly shutdownGraceMs?: number
  }
}
```

Invalid values are rejected by `invalidOption` (ZNIGHT005), like every other plugin option.
Unknown keys inside `cookies`, `cookies.defaults` and `sse` are rejected the way `uploads` keys
are.

## 8. Relation to a future GraphQL subscriptions transport

Nothing in this RFC is GraphQL-specific. It commits to the primitives that a future
`@znight/graphql` would need for the [GraphQL over SSE](https://github.com/enisdenjo/graphql-sse)
protocol ("distinct connections mode"):

- **`HttpResponse.sse()` on any method.** That mode uses `POST` with the operation in the body
  (`fetch`-based clients), and status 200 there.
- **Free-form event names and string data sent as is.** The transport emits
  `{ event: 'next', data: executionResult }` (JSON), then `{ event: 'complete', data: '' }`. An
  empty string data is sent as `data: ` and dispatched.
- **Ordered streams and stopping.** graphql-js `subscribe()` returns an `AsyncGenerator` that
  honours `return()`. `ctx.signal` and the bounded stop make client unsubscription reliable.
- **Event sources.** `EventChannel` bridges a PubSub engine to the iterator with bounded memory.
- **Shared lifecycle.** Heartbeats, shutdown with jittered reconnection and `maxDuration` apply
  unchanged.
- **Testing.** `parseSseStream` / `injectSse` test the transport.

`Accept: text/event-stream` negotiation and the single-connection mode (`PUT` reservation +
`GET` stream) would belong to the GraphQL package. WebSocket transports (graphql-ws) need a
separate RFC. They do not share this framing.

## 9. Security considerations

**Cookies.**

- **Secure by default.** `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/` and host-only. Every
  weakening is explicit at the call site or in `defaults`.
- **Header injection is impossible.** Names are tokens, values are percent-encoded outside
  `cookie-octet`, attribute values are validated, and the existing `findInvalidHeader` stays as a
  second net.
- **Fail loudly.** A cookie that browsers would drop silently (size, `SameSite=None` without
  `Secure`, prefix violation) throws where it is set.
- **Signed cookies.** HMAC-SHA256 bound to the name, constant-time comparison, secrets of at least
  32 bytes, rotation, and invalid signatures treated as absent (no oracle). The limits (no
  confidentiality, no built-in expiry) are documented.
- **Parsing is robust.** Linear time, no throw on malformed input, prototype-less records, first
  occurrence wins. `__Host-` is recommended for authentication cookies, against subdomain
  shadowing and cookie tossing.
- **No reflection.** Coercion errors never echo cookie values.
- **CSRF.** `SameSite=Lax` blocks cross-site `POST` with cookies in modern browsers. It is not
  sufficient on its own (same-site subdomains, `GET` side effects): see RFC 0001 R10.
- **Logs.** Znight's request logs do not include headers (checked:
  `observability/src/logging/requests.ts`). Users who log headers themselves must redact `cookie`
  and `set-cookie`. The README gives the pino `redact` paths.

**SSE.**

- **Authentication only happens when the stream connects.** Guards run once, so a stream outlives
  a revoked token. `maxDuration` forces periodic reconnection, and with it re-authentication.
- **Credentials.** EventSource cannot send an `Authorization` header. Tokens in the query string
  leak into logs and proxies, so the README recommends cookie authentication
  (`new EventSource(url, { withCredentials: true })` cross-origin, which needs the CORS of
  RFC 0001) or a short-lived, single-use stream ticket.
- **Event injection.** Data is split per line and prefixed, and `event` / `id` with CR or LF are
  rejected, so user content cannot forge fields or events. Raw `Uint8Array` passthrough is
  unvalidated by design: proxy only trusted upstreams.
- **Resource exhaustion.** Each stream holds a socket and a request scope. Heartbeat writes detect
  dead peers. `EventChannel` bounds memory per client. A global cap on streams is left to
  applications (a guard counting `plugin.streams` or per-user streams): a 503 would make
  EventSource give up permanently, so there is no built-in limit that silently breaks clients.
- **`Last-Event-ID` is client input.** It goes through `@Headers` coercion or a schema and is never
  trusted as an authorization boundary.
- **Compression.** `no-transform` avoids compression. Compressing secrets alongside attacker-chosen
  data in one stream invites BREACH-style attacks.

## 10. Test plan

Tests use `bun:test` and the existing helpers (`ADAPTERS`, `createApp`, `files-app.ts` patterns).
Node.js coverage comes from fixture scripts run by `node --conditions=@znight/source` and by Bun,
whose outputs are compared, like `runtime-check.ts` today.

### 10.1 Unit

- **`cookies.test.ts`** (table-driven):
  - parsing: quoted values, `%` decoding including malformed sequences, OWS, `;` without a
    space, pairs without `=`, empty names, duplicates (first wins), `__proto__`, `, ` inside values
    (not a separator), a 16 KiB header;
  - encode/decode round-trip over all Latin-1 characters and emoji, and a `TypeError` for lone
    surrogates;
  - serialization of every attribute and the exact attribute order;
  - every validation row of §4.3, including case-insensitive prefixes;
  - the 4096 / 1024 limits measured after signing;
  - `parseSetCookie` round-trip; the jar's keyed replacement and insertion order.
- **`cookie-signer.test.ts`:** sign and verify; rotation (old key verifies, new key signs);
  tampered value, tampered signature, wrong length, a value with dots, name binding (`a` → `b`
  fails); secret validation; constant-time path (`timingSafeEqual` is called with equal lengths
  only).
- **`sse.test.ts`:**
  - encoder: multi-line data with CR / LF / CRLF and trailing newlines, a leading space, JSON and
    `toJSON`, `{ event }` alone (empty `data:` line), `{ id }` alone, comments, every invalid item;
  - stream: the preamble is enqueued before the first source read; heartbeats only while a pull
    waits (fake source, 20 ms heartbeat) and never inside unterminated raw bytes;
  - endings: a failure ends cleanly and logs; cancel aborts the signal, calls `return()` and
    applies the 5 s bound (injected as a parameter for the test); the graceful close lets the
    source yield a final event, applies the grace bound, and writes the jittered `retry` within
    `[r, 2r]`.
- **`sse-parse.test.ts`:** the WHATWG examples from the HTML spec, BOM, a CR split across chunks,
  NUL in `id`, invalid `retry`, an unterminated final event, and the round trip with
  `encodeSseEvent` (property-based over random strings).
- **`event-channel.test.ts`:** each overflow policy, a signal abort, `return()` while `next()` is
  pending (it resolves immediately), the single-consumer guard, `onClose` once.
- **`context.test.ts`:** `setCookie` after `commit()` throws; `ctx.signal` laziness, a single
  abort, aborts ignored after `complete()`.

### 10.2 Compiler (`test/compiler/`)

- **`analysis.test.ts` / `generate.test.ts` snapshots:** every row of §5.4, optional cookies,
  enum, `Date`, schemas, `@Cookie()` record, `@Sse` with and without options, `sse: {}`, `(options)`
  only.
- **`diagnostics.test.ts`:** every row of §5.3 with locations and hints (the `@HttpCode` + `@Sse`
  output above is snapshotted).
- **`e2e.test.ts`** (compile a fixture app, then boot it): a cookie controller and an SSE controller
  on the default adapter; ZNIGHT006 at boot without secrets.

### 10.3 Runtime matrix

Each scenario runs on 4 adapters × `inject` and a real socket (`fetch` +
`parseSseStream` / raw `net` for headers), on Bun in-process and on Node.js 24 through
`fixtures/cookies-sse-check.ts` (new). The responses must be **identical** across all cells.

**Cookies:**

1. `@Cookie` coercion and 400 messages (no echo).
2. `@SignedCookie`: valid, tampered and rotated.
3. Two `Cookie` header fields on a raw socket, joined `; ` on every adapter.
4. `ctx.setCookie` + `HttpResponse.withCookie` with the same key (the response wins), plus raw
   `set-cookie` headers: the exact field order, and **one field line per cookie** on the wire
   (checked on the raw socket bytes).
5. Cookies on error responses (guard `clearCookie` + 401) and on 404 / redirect.
6. A Web `Response` with its own `Set-Cookie` plus jar cookies.
7. An invalid `withCookie` detected at serialization: generic 500 and a log.
8. `inject` `cookies` / `signedCookies` / `res.cookies`.

**SSE:**

1. Headers (exact set), status 200, the preamble received **before** the first event (the client
   reads within 100 ms while the source waits).
2. Events and framing byte for byte.
3. Heartbeat (`heartbeat: 1000` with a quiet source: comments arrive).
4. Last-Event-ID reconnect through `reconnect()`.
5. Client disconnect: `ctx.signal.reason.kind === 'client'`, the generator's `finally` ran, the
   request-scoped provider was disposed, `plugin.inflight` and `plugin.streams` are back to 0.
6. A generator blocked in an `await` ignoring the signal: released after the bound, with a warning.
7. Backpressure: the client does not read; a counting source has been pulled at most a few events
   beyond the socket buffers (as in the existing `streaming.test.ts` pattern).
8. Source failure mid-stream: a clean end and a log.
9. Pre-flight 404 / 204 / guard 401.
10. `HttpResponse.sse()` on `POST`: 200.
11. `HEAD` on an `@Sse` route: the generator body never runs.
12. `maxDuration`: `kind: 'expired'`, a final event yielded during the grace period, then the
    jittered `retry`.
13. **Shutdown:** `app.stop()` with an open stream; the source yields a final event; the stream
    ends in less than `shutdownGraceMs` plus 200 ms; the client receives `retry` within
    `[r, 2r]`; `onStop` completes well under `drainTimeoutMs`. A new SSE request while draining
    receives `retry` and ends at once.
14. `inject()` on an event stream rejects with the hint (it does not hang).
15. `EventChannel` fan-out with `overflow: 'close'` on a client that does not read.

**Compression:**

- `honoAdapter({ app })` with `hono/compress` (no new dependency): SSE is not compressed and
  events arrive one by one.
- `expressAdapter` with `compression()` and `fastifyAdapter` with `@fastify/compress` (global):
  new exact devDependencies of `@znight/http`, used by this test only. The assertions are the
  same: no `content-encoding`, and events arrive one by one. On Fastify the test also checks that
  a header set by an `onRequest` hook is still sent (hijack header merge).

**Timeouts:**

- `hono-bun.test.ts`: `serveOptions: { idleTimeout: 1 }` and a 1.5 s pause with heartbeats
  disabled; the stream survives (the timeout is lifted).
- A user-managed `Bun.serve({ fetch: adapter.fetch, idleTimeout: 2 })` with a 1 s heartbeat
  survives a 3 s quiet period.
- Node-based adapters on Bun (`node:http` emulation) and Node with `serverOptions: { timeout: 1000 }`:
  the stream survives a 1.5 s pause (`eventStream` → `setTimeout(0)`).
- A 12 s quiet stream with heartbeats disabled on every adapter × runtime, without any timeout
  option, is gated behind `ZNIGHT_E2E=1` because it is slow.

### 10.4 Testing package

`packages/testing/test`: `TestApp.inject` forwards `cookies` / `signedCookies` and returns
`cookies`; `injectSse` and `injectStream` delegate, and their missing-plugin errors (ZNIGHT001)
carry hints; `await using` closes the stream.

### 10.5 Examples and golden test

- `examples/rest-api` gains:
  - a `BookEventsController` (`@Sse('/books/events')`) fed by an `EventChannel` hub that
    `BookService.create()` publishes to;
  - a theme cookie on `/me`;
  - their tests, using `app.injectSse()` and `cookies`.
- `tests/` golden output is regenerated: new routes and metadata.

## 11. Documentation to update

- **`packages/http/README.md`:**
  - new sections **Cookies** (reading, writing, defaults, signing and rotation, limits, security)
    and **Server-Sent Events** (API, framing, lifecycle, `EventChannel`, proxies and compression,
    timeouts, GraphQL note);
  - tables to extend: Parameters (`@Cookie`, `@SignedCookie`), Controllers and routes (`@Sse`),
    Responses (`HttpResponse.sse`, `withCookie`), The request context (`cookies`, `signedCookie`,
    `setCookie`, `clearCookie`, `responseCookies`, `signal`), Plugin options (`cookies`, `sse`);
  - Testing (`cookies`, `injectSse`, `injectStream`, `parseSseStream`) and Lifecycle (SSE on
    shutdown);
  - Compiler: types of parameters and diagnostics. Compiler contract: params sources, the invoke
    table, `sse` metadata and decorator identities. Writing an adapter: `onAbort`,
    `eventStream`, `injectStream`;
  - **Limitations:** remove "cookies parsing".
- **`docs/packages/http.md`:** the same sections, condensed.
- **`docs/internals/architecture.md`:**
  - §5: the decorator catalogue rows `@Cookie(name?, schema?)`, `@SignedCookie(name, schema?)`
    and `@Sse(path? | options, options?)`;
  - §9.1: `HttpParamSource`, `HttpRouteDefinition.sse`, the cookie and SSE pipeline rules
    (normative text of §4.3 and §4.7 in short), `AdapterRequest.onAbort`,
    `AdapterReply.eventStream`, `HttpAdapter.injectStream`, `InjectRequest` / `InjectResponse`
    cookies, the plugin options and `onStop` order;
  - §10: `TestApp.injectSse` / `injectStream` and cookies.
- **`docs/guide/testing.md`** and **`packages/testing/README.md`:** cookie round trips and SSE tests.
- **`docs/guide/migrating-from-nestjs.md`**, HTTP table rows:
  - `@Req() req.cookies` / `cookie-parser` → `@Cookie()`;
  - `res.cookie()` → `ctx.setCookie()` / `HttpResponse.withCookie()`;
  - `@Sse()` returning `Observable<MessageEvent>` → `@Sse()` returning an `AsyncIterable<SseEvent>`
    (no RxJS; `EventChannel` in place of `Subject`).
- **`docs/guide/lifecycle.md`:** SSE streams on shutdown, and `shutdownGraceMs` < `drainTimeoutMs`
  < `hookTimeoutMs`.
- **`docs/guide/deployment.md`:** proxy settings for SSE (nginx, ALB, Cloudflare), HTTP/2, and the
  `Bun.serve()` idle timeout.
- **`docs/reference/error-codes.md`:** add the new ZNIGHT005, 006, 007 and 017 cases to the
  existing entries.
- **RFC 0001:** its "Cookie support … separate RFC" item points to this RFC.

## 12. Effort and rollout

| Step                             | Content                                                                                                                                                                                                                          | Estimate                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| PR 1: cookies                    | `cookies.ts`, `cookie-signer.ts`, context / response / serialize / pipeline / plugin, `coerce` labels, compiler (`@Cookie`, `@SignedCookie`), inject cookies, `TestApp`, unit + compiler + matrix + Node/Bun fixture, docs       | 5 dev-days                                                                          |
| PR 2: abort and streaming inject | `ctx.signal`, `RequestAbortedError`, `AdapterRequest.onAbort` × 4, `injectStream` × 4, `inject()` on top of it, `AdapterReply.eventStream`, tests, docs                                                                          | 3 dev-days                                                                          |
| PR 3: SSE                        | `sse.ts`, `sse-parse.ts`, `event-channel.ts`, `HttpResponse.sse`, pipeline / plugin (sessions, shutdown, options), compiler (`@Sse`), `injectSse` / `TestApp.injectSse`, unit + compiler + matrix + compression + timeouts, docs | 7 dev-days                                                                          |
| PR 4: example and guides         | rest-api example, golden test, migration / deployment / lifecycle guides                                                                                                                                                         | 1.5 dev-days                                                                        |
| **Total**                        |                                                                                                                                                                                                                                  | **≈ 16.5 dev-days** (3.5 weeks for one engineer; PR 1 and PR 2 can run in parallel) |

This is a minor `0.x` release. The changes are additive, with two observable differences:

- `inject()` on an event stream now rejects instead of hanging;
- `setCookie` after the headers were sent throws.

Exhaustive `switch` statements over `HttpParamSource` in user code must handle the two new
sources (typing only). Every PR updates the architecture document in the same change
(architecture preamble rule).

## 13. Alternatives considered

| Alternative                                                                   | Why not                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depend on the `cookie` npm package                                            | It is not zero-dependency. Its percent-encoding is not canonical with our parser, and it neither validates prefixes nor enforces size limits. ~300 lines of our own, tested against the RFC, are cheaper to own. |
| Adapter cookie middleware (`@fastify/cookie`, `cookie-parser`, `hono/cookie`) | It differs per adapter (encoding, signing format, duplicates), cannot be used with `nodeAdapter()` or `Bun.serve()`, and is invisible to the compiler.                                                           |
| WebCrypto signing                                                             | It is async-only, so every cookie API and `invoke` would become async (§4.5).                                                                                                                                    |
| `@Cookie('x', { signed: true })`                                              | It needs an options object next to the schema (`@Cookie(name, schemaOrOptions?)`), which is ambiguous. A dedicated `@SignedCookie` is explicit at the parameter, simple to analyse, and greppable in audits.     |
| Lenient coercion of cookies (an invalid value becomes `undefined`)            | It hides tampering and is inconsistent with `@Query`. Schemas with `.catch()` give leniency explicitly (§4.2).                                                                                                   |
| NestJS-style `Observable<MessageEvent>`                                       | It would require RxJS. `AsyncIterable` is the platform primitive, with native `return()` cancellation, and maps 1:1 to graphql-js subscriptions.                                                                 |
| Imperative `ctx.sse().write(event)` (Hono `streamSSE` style)                  | Push-only, with no backpressure. Error handling and completion become callback soup. Push ergonomics are offered by `EventChannel` while the transport stays pull-based.                                         |
| Detect SSE from `async *` methods or a return type, without `@Sse`            | It is ambiguous with `HttpResponse.stream()` of async generators, and invisible in routes and audits. `HttpResponse.sse()` already is the "convention" path for non-decorated cases.                             |
| A default `event: error` on failure                                           | It collides with EventSource's built-in `error` event, and the payload shape would be ours to impose.                                                                                                            |
| 503 for SSE requests while draining                                           | EventSource does not retry non-200 responses: clients would stop for good.                                                                                                                                       |
| A 15 s heartbeat (the HTML spec's example)                                    | It is above `Bun.serve()`'s 10 s default idle timeout, which the adapter cannot lift for user-managed servers. 8 s costs nothing.                                                                                |
