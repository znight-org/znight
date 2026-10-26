/**
 * End-to-end test (opt-in, `ZNIGHT_E2E=1`, `bun run test:e2e`): builds the application for
 * production with `znight build`, starts the bundle with Node.js and with Bun as a separate process
 * configured through environment variables, talks to it over real HTTP, then stops it with SIGTERM
 * during an upload and checks the graceful shutdown (in-flight request drained, shutdown hooks,
 * exit code 0).
 *
 * Both runtimes use the same PGlite data directory: what the Node.js process writes, the Bun process
 * reads back after a restart (persistence, idempotent migrations, a database closed cleanly).
 *
 * In this repository the build imports the @znight/* packages from their `dist` (like packages
 * installed from npm): run `bun run build` at the repository root first.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PNG_BYTES } from './support/fixtures.js'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

const ENABLED = process.env.ZNIGHT_E2E === '1'
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ADMIN_KEY = 'e2e-admin-key'
const READER_KEY = 'e2e-reader-key'
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
      cwd: ROOT, // the migrations folder (`drizzle/`) and .env files are relative to the working directory
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

/**
 * A multipart upload whose last bytes are only sent when `finish()` is called: an in-flight request
 * for as long as the test wants.
 */
function slowCoverUpload(
  url: string,
  headers: Record<string, string>,
): { response: Promise<Response>; finish(): void } {
  const boundary = 'e2e-slow-upload'
  const encoder = new TextEncoder()
  const { promise: finished, resolve: finish } = Promise.withResolvers<void>()
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(
        encoder.encode(
          `--${boundary}\r\ncontent-disposition: form-data; name="cover"; filename="slow.png"\r\ncontent-type: image/png\r\n\r\n`,
        ),
      )
      controller.enqueue(PNG_BYTES)
      await finished
      controller.enqueue(encoder.encode(`\r\n--${boundary}--\r\n`))
      controller.close()
    },
  })
  const response = fetch(url, {
    method: 'PUT',
    headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
    body,
    duplex: 'half',
  } as RequestInit)
  return { response, finish: () => finish() }
}

/** Polls the Prometheus endpoint until a series matches. */
async function waitForMetric(url: string, pattern: RegExp, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pattern.test(await (await fetch(url)).text())) return
    await Bun.sleep(25)
  }
  throw new Error(`No metric matching ${pattern} within ${timeoutMs} ms`)
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

describe.skipIf(!ENABLED)('end to end (production build)', () => {
  let dataDir = ''
  const running: AppProcess[] = []
  /** Book created by the Node.js process, read back by the Bun process. */
  let created: { id: number; isbn: string } | undefined

  /** Starts the build; `undefined` values remove variables from the environment. */
  function start(runtime: 'node' | 'bun', env: Record<string, string | undefined> = {}): AppProcess {
    const args = runtime === 'node' ? ['--enable-source-maps', 'dist/main.js'] : ['dist/main.js']
    const app = new AppProcess(runtime, args, {
      NODE_ENV: 'production',
      API_KEY: ADMIN_KEY,
      READONLY_API_KEY: READER_KEY,
      HOST: '127.0.0.1',
      PORT: '0', // free ports: the actual URLs are read from the "ready" log line
      METRICS_PORT: '0',
      DATABASE_DATA_DIR: dataDir,
      LOG_LEVEL: 'info',
      ...env,
    })
    running.push(app)
    return app
  }

  /**
   * SIGTERM while a cover upload is still being sent: the server stops accepting connections but
   * lets the in-flight request finish (drain), then providers stop, the database closes and the
   * process exits with code 0.
   */
  async function expectGracefulShutdown(app: AppProcess, ready: LogEntry, coverUrl: string): Promise<void> {
    const upload = slowCoverUpload(coverUrl, { 'x-api-key': ADMIN_KEY })
    await waitForMetric(String(ready.metricsUrl), /http_server_active_requests\{method="PUT"[^}]*\} 1/)

    const exiting = app.stop()
    await app.waitForLog('Received SIGTERM: shutting down gracefully')
    await Bun.sleep(300) // the HTTP plugin is draining
    upload.finish()

    const drained = await upload.response
    expect(drained.status).toBe(200)
    expect(drained.headers.get('connection')).toBe('close')
    expect(await exiting).toEqual({ code: 0, signal: null })
    const messages = app.logs().map(log => log.msg)
    expect(messages).toContain('Bookshelf API stopping') // AppLifecycle.onStop
    expect(messages).toContain('Application stopped')
    expect(app.logs().filter(log => log.level >= 50)).toEqual([]) // no error during the whole run
  }

  beforeAll(async () => {
    const cli = join(ROOT, 'node_modules/@znight/cli/dist/cli.mjs')
    if (!existsSync(cli))
      throw new Error('The @znight/* packages are not built: run `bun run build` at the repository root')
    dataDir = mkdtempSync(join(tmpdir(), 'bookshelf-e2e-'))
    // `npm run build`: the CLI runs on Node.js, Vite builds src/main.ts into dist/main.js
    const build = await run('node', [cli, 'build'])
    if (build.code !== 0) throw new Error(`znight build failed:\n${build.output}`)
    expect(existsSync(join(ROOT, 'dist/main.js'))).toBe(true)
  }, TIMEOUT)

  afterAll(() => {
    for (const app of running) app.kill()
    if (dataDir !== '') rmSync(dataDir, { recursive: true, force: true })
  })

  it(
    'refuses to start without its required configuration',
    async () => {
      const app = start('node', { API_KEY: undefined })

      const exit = await app.exited

      expect(exit.code).toBe(1)
      expect(app.output).toContain('ZNIGHT006')
      expect(app.output).toContain('API_KEY')
      expect(app.output).not.toContain(READER_KEY) // secrets are never printed
    },
    TIMEOUT,
  )

  it(
    'serves the API on Node.js',
    async () => {
      const app = start('node')
      const ready = await app.waitForLog('Bookshelf API ready')
      const url = String(ready.url)
      const admin = { 'x-api-key': ADMIN_KEY }

      // public health check, authentication
      expect((await fetch(`${url}/health`)).status).toBe(200)
      expect((await fetch(`${url}/books`)).status).toBe(401)
      expect((await fetch(`${url}/books`, { headers: { 'x-api-key': 'wrong' } })).status).toBe(401)

      // create (zod-validated body), duplicate (409), invalid (400)
      const book = { isbn: '978-0-441-17271-9', title: 'Dune', author: 'Frank Herbert', tags: ['Classic'] }
      const createdResponse = await fetch(`${url}/books`, {
        method: 'POST',
        headers: { ...admin, 'content-type': 'application/json', 'x-request-id': 'e2e-create-dune' },
        body: JSON.stringify(book),
      })
      expect(createdResponse.status).toBe(201)
      expect(createdResponse.headers.get('x-request-id')).toBe('e2e-create-dune')
      created = (await createdResponse.json()) as { id: number; isbn: string }
      expect(created).toMatchObject({ isbn: '9780441172719', createdBy: 'admin' })
      expect(createdResponse.headers.get('location')).toBe(`/books/${created.id}`)

      const duplicate = await fetch(`${url}/books`, {
        method: 'POST',
        headers: { ...admin, 'content-type': 'application/json' },
        body: JSON.stringify(book),
      })
      expect(duplicate.status).toBe(409)
      const invalid = await fetch(`${url}/books`, {
        method: 'POST',
        headers: { ...admin, 'content-type': 'application/json' },
        body: JSON.stringify({ isbn: 'nope' }),
      })
      expect(invalid.status).toBe(400)

      // query coercion, filtering
      const list = await fetch(`${url}/books?tag=classic&sort=year&limit=5`, { headers: admin })
      expect(await list.json()).toMatchObject({ total: 1, limit: 5, items: [{ id: created.id }] })
      expect((await fetch(`${url}/books?limit=many`, { headers: admin })).status).toBe(400)
      expect((await fetch(`${url}/books/abc`, { headers: admin })).status).toBe(400)
      expect((await fetch(`${url}/books/424242`, { headers: admin })).status).toBe(404)

      // roles: the read-only key cannot delete
      const forbidden = await fetch(`${url}/books/${created.id}`, {
        method: 'DELETE',
        headers: { 'x-api-key': READER_KEY },
      })
      expect(forbidden.status).toBe(403)

      // cover upload (multipart) and public download with conditional and range requests
      const form = new FormData()
      form.append('cover', new File([PNG_BYTES], 'dune.png', { type: 'image/png' }))
      const upload = await fetch(`${url}/books/${created.id}/cover`, { method: 'PUT', headers: admin, body: form })
      expect(upload.status).toBe(200)
      const cover = await fetch(`${url}/books/${created.id}/cover`)
      expect(cover.status).toBe(200)
      expect(cover.headers.get('content-type')).toBe('image/png')
      expect(new Uint8Array(await cover.arrayBuffer())).toEqual(PNG_BYTES)
      const etag = cover.headers.get('etag') ?? ''
      expect((await fetch(`${url}/books/${created.id}/cover`, { headers: { 'if-none-match': etag } })).status).toBe(304)
      const range = await fetch(`${url}/books/${created.id}/cover`, { headers: { range: 'bytes=0-3' } })
      expect(range.status).toBe(206)
      expect(new Uint8Array(await range.arrayBuffer())).toEqual(PNG_BYTES.slice(0, 4))

      // Prometheus metrics on their own server: RED metrics and the @Metric counter
      const metrics = await (await fetch(String(ready.metricsUrl))).text()
      expect(metrics).toContain('http_server_requests_total{method="POST",route="/books",status="201"')
      expect(metrics).toMatch(/bookshelf_books_added_total\{[^}]*outcome="success"[^}]*\} 1/)

      // structured logs: one line per request carrying its request id, @Logged on BookService.add
      const logs = app.logs()
      expect(logs).toContainEqual(
        expect.objectContaining({ msg: 'request completed', requestId: 'e2e-create-dune', status: 201 }),
      )
      expect(logs).toContainEqual(
        expect.objectContaining({ msg: 'BookService.add() completed', requestId: 'e2e-create-dune' }),
      )

      await expectGracefulShutdown(app, ready, `${url}/books/${created.id}/cover`)
    },
    TIMEOUT,
  )

  it(
    'serves the same database on Bun after a restart',
    async () => {
      if (created === undefined) throw new Error('the Node.js test did not create its book')
      const app = start('bun')
      const ready = await app.waitForLog('Bookshelf API ready')
      const url = String(ready.url)
      const admin = { 'x-api-key': ADMIN_KEY }

      // written by the Node.js process: persisted, and the migrations were not applied twice
      const book = await fetch(`${url}/books/${created.id}`, { headers: admin })
      expect(book.status).toBe(200)
      expect(await book.json()).toMatchObject({ isbn: created.isbn, coverUrl: `/books/${created.id}/cover` })
      const cover = await fetch(`${url}/books/${created.id}/cover`)
      expect(new Uint8Array(await cover.arrayBuffer())).toEqual(PNG_BYTES)

      const me = await fetch(`${url}/me`, { headers: { 'x-api-key': READER_KEY } })
      expect(await me.json()).toEqual({ name: 'reader', roles: ['reader'] })

      // a book of its own, deleted with its cover
      const other = await fetch(`${url}/books`, {
        method: 'POST',
        headers: { ...admin, 'content-type': 'application/json' },
        body: JSON.stringify({ isbn: '9780547928227', title: 'The Hobbit', author: 'J. R. R. Tolkien' }),
      })
      expect(other.status).toBe(201)
      const { id } = (await other.json()) as { id: number }
      expect((await fetch(`${url}/books/${id}`, { method: 'DELETE', headers: admin })).status).toBe(204)
      expect((await fetch(`${url}/books/${id}`, { headers: admin })).status).toBe(404)

      await expectGracefulShutdown(app, ready, `${url}/books/${created.id}/cover`)
    },
    TIMEOUT,
  )
})
