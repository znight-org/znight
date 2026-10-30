/**
 * End-to-end test (opt-in, `ZNIGHT_E2E=1`, `bun run test:e2e`): builds the application for
 * production with `znight build`, starts the bundle with Node.js and with Bun as separate processes
 * configured through environment variables, and talks to them over real HTTP:
 *
 * - on Node.js, the tokens are verified with the key set of an identity provider served over HTTP
 *   (`AUTH_JWKS_URL`, a local server of this test);
 * - on Bun, with the development key set written by `scripts/dev-token.ts` (`AUTH_JWKS_FILE`), and
 *   the token printed by the script;
 * - both stop with SIGTERM while a webhook delivery is still being received: the request is drained
 *   and answered, the shutdown hooks run, and the process exits with code 0.
 *
 * In this repository the build imports the @znight/* packages from their `dist` (like packages
 * installed from npm): run `bun run build` at the repository root first.
 */
import type { NotesExport } from '../src/admin/admin.controller.js'
import type { Note } from '../src/notes/note.js'
import type { SessionResponse } from '../src/session/session.controller.js'
import type { StatusDetails } from '../src/status/status.controller.js'

import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ADA,
  BROWSER_ORIGIN,
  EXPORT_KEY,
  LOCAL_ACCOUNTS,
  SESSION_SECRET,
  signWebhook,
  WEBHOOK_SECRET,
} from './support/fixtures.js'
import { type JwksServer, startJwksServer } from './support/jwks-server.js'
import { AUDIENCE, ISSUER, jwks, mintToken } from './support/tokens.js'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

const ENABLED = process.env.ZNIGHT_E2E === '1'
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TIMEOUT = 60_000

/** A JSON log line of the application. */
interface LogEntry {
  readonly level: number
  readonly msg: string
  readonly [field: string]: unknown
}

interface Exit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

/** The application running in a child process. */
class AppProcess {
  readonly #child: ChildProcess
  readonly exited: Promise<Exit>
  #output = ''

  constructor(command: string, args: readonly string[], env: Record<string, string | undefined>) {
    this.#child = spawn(command, [...args], {
      cwd: ROOT,
      env: Object.fromEntries(
        Object.entries({ ...process.env, NO_COLOR: '1', ...env }).filter(([, value]) => value !== undefined),
      ),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.#child.stdout?.on('data', chunk => {
      this.#output += chunk
    })
    this.#child.stderr?.on('data', chunk => {
      this.#output += chunk
    })
    this.exited = new Promise(resolve => this.#child.once('exit', (code, signal) => resolve({ code, signal })))
  }

  get output(): string {
    return this.#output
  }

  /** The JSON log lines written so far. */
  logs(): LogEntry[] {
    return this.#output
      .split('\n')
      .filter(line => line.startsWith('{'))
      .flatMap(line => {
        try {
          return [JSON.parse(line) as LogEntry]
        } catch {
          return []
        }
      })
  }

  /** Waits for a log entry (fails early when the process exits). */
  async waitForLog(message: string, timeoutMs = TIMEOUT): Promise<LogEntry> {
    const deadline = Date.now() + timeoutMs
    let exited = false
    void this.exited.then(() => {
      exited = true
    })
    while (Date.now() < deadline) {
      const entry = this.logs().find(log => log.msg === message)
      if (entry !== undefined) return entry
      if (exited) throw new Error(`The application exited before logging "${message}":\n${this.#output}`)
      await Bun.sleep(50)
    }
    throw new Error(`The application did not log "${message}" within ${timeoutMs} ms:\n${this.#output}`)
  }

  /** Sends SIGTERM and waits for the process to exit. */
  async stop(): Promise<Exit> {
    this.#child.kill('SIGTERM')
    return await this.exited
  }

  kill(): void {
    if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill('SIGKILL')
  }
}

function run(command: string, args: readonly string[]): Promise<{ code: number | null; output: string }> {
  return new Promise(resolve => {
    const child = spawn(command, [...args], { cwd: ROOT, env: { ...process.env, NO_COLOR: '1' } })
    let output = ''
    child.stdout.on('data', chunk => {
      output += chunk
    })
    child.stderr.on('data', chunk => {
      output += chunk
    })
    child.once('exit', code => resolve({ code, output }))
  })
}

/**
 * A webhook delivery whose last bytes are only sent when `finish()` is called: an in-flight request
 * for as long as the test wants (the signature guard waits for the whole raw body).
 */
function slowWebhook(url: string, id: string): { response: Promise<Response>; finish(): void } {
  const body = JSON.stringify({ id, type: 'subscription.renewed', data: { customerId: 'cus_42', plan: 'pro' } })
  const encoder = new TextEncoder()
  const { promise: finished, resolve: finish } = Promise.withResolvers<void>()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(body.slice(0, 20)))
      await finished
      controller.enqueue(encoder.encode(body.slice(20)))
      controller.close()
    },
  })
  const response = fetch(`${url}/webhooks/billing`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      'x-signature': signWebhook(body),
    },
    body: stream,
    duplex: 'half',
  } as RequestInit)
  return { response, finish: () => finish() }
}

describe.skipIf(!ENABLED)('end to end (production build)', () => {
  const running: AppProcess[] = []
  let idp: JwksServer
  let devKeysDir = ''

  /** Starts the build; `undefined` values remove variables from the environment. */
  function start(runtime: 'node' | 'bun', env: Record<string, string | undefined> = {}): AppProcess {
    const args = runtime === 'node' ? ['--enable-source-maps', 'dist/main.js'] : ['dist/main.js']
    const app = new AppProcess(runtime, args, {
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: '0', // a free port: the actual URL is read from the "ready" log line
      LOG_LEVEL: 'info',
      AUTH_ISSUER: ISSUER,
      AUTH_AUDIENCE: AUDIENCE,
      AUTH_JWKS_URL: idp.jwksUrl,
      EXPORT_API_KEYS: EXPORT_KEY,
      SESSION_SECRETS: SESSION_SECRET,
      LOCAL_ACCOUNTS: JSON.stringify(LOCAL_ACCOUNTS),
      WEBHOOK_SECRET,
      CORS_ORIGINS: BROWSER_ORIGIN,
      TRUSTED_PROXIES: 'loopback',
      ...env,
    })
    running.push(app)
    return app
  }

  /**
   * SIGTERM while a webhook delivery is still being received: the server stops accepting connections
   * but lets the in-flight request finish (drain), then providers stop and the process exits with 0.
   */
  async function expectGracefulShutdown(app: AppProcess, url: string, admin: Record<string, string>): Promise<void> {
    const delivery = slowWebhook(url, `evt_shutdown_${Date.now()}`)
    // the delivery is in flight once the server counts it (with the status request itself)
    const deadline = Date.now() + 10_000
    for (;;) {
      const details = (await (await fetch(`${url}/status/details`, { headers: admin })).json()) as StatusDetails
      if (details.inflightRequests === 2) break
      if (Date.now() > deadline) throw new Error('the webhook delivery never reached the server')
      await Bun.sleep(25)
    }

    const exiting = app.stop()
    await app.waitForLog('Received SIGTERM: shutting down gracefully')
    await Bun.sleep(300) // the HTTP plugin is draining
    delivery.finish()

    const drained = await delivery.response
    expect(drained.status).toBe(204)
    expect(drained.headers.get('connection')).toBe('close')
    expect(await exiting).toEqual({ code: 0, signal: null })
    const messages = app.logs().map(log => log.msg)
    expect(messages).toContain('Billing event processed') // the drained delivery was handled
    expect(messages).toContain('Notes API stopping') // AppLifecycle.onStop
    expect(messages).toContain('Application stopped')
    expect(app.logs().filter(log => log.level >= 50)).toEqual([]) // no error during the whole run
  }

  beforeAll(async () => {
    const cli = join(ROOT, 'node_modules/@znight/cli/dist/cli.mjs')
    if (!existsSync(cli)) {
      throw new Error('The @znight/* packages are not built: run `bun run build` at the repository root')
    }
    idp = await startJwksServer(jwks)
    devKeysDir = mkdtempSync(join(tmpdir(), 'secure-api-e2e-'))
    // `npm run build`: the CLI runs on Node.js, Vite builds src/main.ts into dist/main.js
    const build = await run('node', [cli, 'build'])
    if (build.code !== 0) throw new Error(`znight build failed:\n${build.output}`)
    expect(existsSync(join(ROOT, 'dist/main.js'))).toBe(true)
  }, TIMEOUT)

  afterAll(async () => {
    for (const app of running) app.kill()
    await idp?.close()
    if (devKeysDir !== '') rmSync(devKeysDir, { recursive: true, force: true })
  })

  it(
    'refuses to start without its required configuration, without printing secrets',
    async () => {
      const app = start('node', { SESSION_SECRETS: undefined, WEBHOOK_SECRET: undefined })

      const exit = await app.exited

      expect(exit.code).toBe(1)
      expect(app.output).toContain('ZNIGHT006')
      expect(app.output).toContain('SESSION_SECRETS')
      expect(app.output).toContain('WEBHOOK_SECRET')
      expect(app.output).not.toContain(EXPORT_KEY)
      expect(app.output).not.toContain('$scrypt$')
    },
    TIMEOUT,
  )

  it(
    'serves the API on Node.js, with the key set of the identity provider',
    async () => {
      const app = start('node')
      const url = String((await app.waitForLog('Notes API ready')).url)
      const editor = { authorization: `Bearer ${await mintToken({ sub: 'u-editor', roles: ['editor'] })}` }
      const reader = { authorization: `Bearer ${await mintToken({ sub: 'u-reader', roles: ['reader'] })}` }
      const admin = { authorization: `Bearer ${await mintToken({ sub: 'u-admin', roles: ['admin'] })}` }
      const json = { 'content-type': 'application/json' }

      // public routes, security headers
      const health = await fetch(`${url}/health`)
      expect(health.status).toBe(200)
      expect(health.headers.get('x-content-type-options')).toBe('nosniff')
      expect(health.headers.get('cache-control')).toBe('no-store')

      // no credentials: 401 with both challenges (two header fields, joined by fetch)
      const anonymous = await fetch(`${url}/notes`)
      expect(anonymous.status).toBe(401)
      expect(anonymous.headers.get('www-authenticate')).toBe('Bearer realm="api", ApiKey header="x-api-key"')

      // a browser preflight is answered before the guards
      const preflight = await fetch(`${url}/notes`, {
        method: 'OPTIONS',
        headers: { origin: BROWSER_ORIGIN, 'access-control-request-method': 'POST' },
      })
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get('access-control-allow-origin')).toBe(BROWSER_ORIGIN)

      // roles, then ownership
      const created = await fetch(`${url}/notes`, {
        method: 'POST',
        headers: { ...editor, ...json },
        body: JSON.stringify({ text: 'Ship the secure API' }),
      })
      expect(created.status).toBe(201)
      const note = (await created.json()) as Note
      expect(created.headers.get('location')).toBe(`/notes/${note.id}`)
      const forbidden = await fetch(`${url}/notes`, {
        method: 'POST',
        headers: { ...reader, ...json },
        body: '{"text":"x"}',
      })
      expect(forbidden.status).toBe(403)
      expect((await fetch(`${url}/notes/${note.id}`, { headers: reader })).status).toBe(404)
      expect((await fetch(`${url}/notes/${note.id}`, { headers: admin })).status).toBe(200)

      // token checks
      const expired = await mintToken({ sub: 'u-editor', exp: Math.floor(Date.now() / 1000) - 120 })
      const rejected = await fetch(`${url}/me`, { headers: { authorization: `Bearer ${expired}` } })
      expect(rejected.status).toBe(401)
      expect(rejected.headers.get('www-authenticate')).toBe('Bearer realm="api", error="invalid_token"')

      // API key of the export client; a wrong key is logged with the client address behind the proxy
      const exported = await fetch(`${url}/admin/export`, { headers: { 'x-api-key': EXPORT_KEY } })
      expect(((await exported.json()) as NotesExport).notes.map(n => n.id)).toEqual([note.id])
      const wrongKey = await fetch(`${url}/admin/export`, {
        headers: { 'x-api-key': 'guessed', 'x-forwarded-for': '203.0.113.7' },
      })
      expect(wrongKey.status).toBe(401)

      // webhook: the signature covers the raw body
      const event = JSON.stringify({
        id: 'evt_e2e',
        type: 'subscription.created',
        data: { customerId: 'c', plan: 'pro' },
      })
      const signature = signWebhook(event)
      const webhook = (body: string) =>
        fetch(`${url}/webhooks/billing`, { method: 'POST', headers: { ...json, 'x-signature': signature }, body })
      expect((await webhook(event)).status).toBe(204)
      expect((await webhook(event.replace('pro', 'max'))).status).toBe(401)

      // password sign-in, cookie session, CSRF token
      const signIn = await fetch(`${url}/session`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ username: ADA.username, password: ADA.password }),
      })
      expect(signIn.status).toBe(200)
      const { csrfToken } = (await signIn.json()) as SessionResponse
      const cookie = signIn.headers
        .getSetCookie()
        .map(line => line.split(';')[0])
        .join('; ')
      expect(cookie).toContain('__Host-session=')
      const fromPage = { ...json, cookie, origin: BROWSER_ORIGIN, 'sec-fetch-site': 'same-site' }
      const withoutToken = await fetch(`${url}/notes`, { method: 'POST', headers: fromPage, body: '{"text":"x"}' })
      expect(withoutToken.status).toBe(403)
      const withToken = await fetch(`${url}/notes`, {
        method: 'POST',
        headers: { ...fromPage, 'x-csrf-token': csrfToken },
        body: JSON.stringify({ text: 'From the browser' }),
      })
      expect(withToken.status).toBe(201)

      const logs = app.logs()
      expect(logs).toContainEqual(expect.objectContaining({ msg: 'Invalid API key', ip: '203.0.113.7' }))
      expect(logs).toContainEqual(expect.objectContaining({ msg: 'Billing event processed', eventId: 'evt_e2e' }))
      expect(app.output).not.toContain(csrfToken) // nor any credential: request logs hold no header

      await expectGracefulShutdown(app, url, admin)
    },
    TIMEOUT,
  )

  it(
    'serves the API on Bun, with the development key set and token of scripts/dev-token.ts',
    async () => {
      const devToken = (roles: string) =>
        run('node', [
          'scripts/dev-token.ts',
          '--dir',
          devKeysDir,
          '--iss',
          ISSUER,
          '--aud',
          AUDIENCE,
          '--sub',
          'u-dev',
          '--roles',
          roles,
        ])
      const editorToken = await devToken('editor')
      expect(editorToken.code).toBe(0)
      const adminToken = await devToken('admin')
      const editor = { authorization: `Bearer ${editorToken.output.trim().split('\n').at(-1)}` }
      const admin = { authorization: `Bearer ${adminToken.output.trim().split('\n').at(-1)}` }

      const app = start('bun', { AUTH_JWKS_URL: undefined, AUTH_JWKS_FILE: join(devKeysDir, 'jwks.json') })
      const url = String((await app.waitForLog('Notes API ready')).url)

      const me = await fetch(`${url}/me`, { headers: editor })
      expect(await me.json()).toMatchObject({ id: 'u-dev', roles: ['editor'], via: 'token' })
      // a token of the test identity provider is signed by another key: not accepted here
      const foreign = await fetch(`${url}/me`, {
        headers: { authorization: `Bearer ${await mintToken({ sub: 'u-dev', roles: ['admin'] })}` },
      })
      expect(foreign.status).toBe(401)

      const created = await fetch(`${url}/notes`, {
        method: 'POST',
        headers: { ...editor, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'From Bun' }),
      })
      expect(created.status).toBe(201)
      const details = (await (await fetch(`${url}/status/details`, { headers: admin })).json()) as StatusDetails
      expect(details.runtime).toStartWith('bun ')

      await expectGracefulShutdown(app, url, admin)
    },
    TIMEOUT,
  )

  it(
    'answers 503 while the identity provider is down, on Bun',
    async () => {
      const app = start('bun', { AUTH_JWKS_URL: idp.brokenUrl })
      const url = String((await app.waitForLog('Notes API ready')).url)

      const response = await fetch(`${url}/me`, {
        headers: { authorization: `Bearer ${await mintToken({ sub: 'u-1' })}` },
      })

      expect(response.status).toBe(503)
      expect(response.headers.get('retry-after')).toBe('5')
      expect(await app.stop()).toEqual({ code: 0, signal: null })
    },
    TIMEOUT,
  )
})
