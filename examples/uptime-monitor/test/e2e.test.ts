/**
 * End-to-end test (opt-in, `ZNIGHT_E2E=1`, `bun run test:e2e`): builds the application for
 * production with `znight build`, starts the bundle with Node.js and with Bun as a separate process
 * configured through environment variables, and lets it monitor a real HTTP target on the system
 * clock: monitors probed every 2 seconds, live results over Server-Sent Events, the admin endpoints,
 * and a SIGTERM while a probe is in flight (its fetch aborted, the scheduler drained, exit code 0).
 *
 * Both runtimes use the same PGlite data directory: the Bun process schedules again, at startup, the
 * monitors created through the Node.js process.
 *
 * In this repository the build imports the @znight/* packages from their `dist` (like packages
 * installed from npm): run `bun run build` at the repository root first.
 */
import type { Server } from 'bun'
import type { JobView } from '../src/schedule/jobs.controller.js'

import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSseStream } from '@znight/http'

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

  /** Waits for a log entry matching `message` and `fields` (fails early when the process exits). */
  async waitForLog(
    message: string | RegExp,
    fields: Record<string, unknown> = {},
    timeoutMs = TIMEOUT,
  ): Promise<LogEntry> {
    const deadline = Date.now() + timeoutMs
    let exited = false
    void this.exited.then(() => {
      exited = true
    })
    const matches = (log: LogEntry): boolean =>
      (typeof message === 'string' ? log.msg === message : message.test(log.msg)) &&
      Object.entries(fields).every(([key, value]) => log[key] === value)
    while (Date.now() < deadline) {
      const entry = this.logs().find(matches)
      if (entry !== undefined) return entry
      if (exited) throw new Error(`The application exited before logging "${String(message)}":\n${this.#output}`)
      await Bun.sleep(50)
    }
    throw new Error(
      `The application did not log "${String(message)}" ${JSON.stringify(fields)} within ${timeoutMs} ms:\n${this.#output}`,
    )
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
 * The monitored service: `/ok` answers 200, `/slow` never answers until the client goes away (a
 * probe in flight for as long as the test wants), and counts the probes it saw abort.
 */
class Target {
  readonly #server: Server<undefined>
  slowStarted = 0
  slowAborted = 0

  constructor() {
    this.#server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      idleTimeout: 0,
      fetch: request => {
        const path = new URL(request.url).pathname
        if (path !== '/slow') return new Response('ok')
        this.slowStarted++
        return new Promise<Response>(resolve => {
          request.signal.addEventListener('abort', () => {
            this.slowAborted++
            resolve(new Response(null, { status: 499 }))
          })
        })
      },
    })
  }

  url(path: string): string {
    return new URL(path, this.#server.url).href
  }

  /** Waits until a probe of `/slow` is in flight. */
  async waitForSlowProbe(): Promise<void> {
    const deadline = Date.now() + 10_000
    while (this.slowStarted === this.slowAborted) {
      if (Date.now() > deadline) throw new Error('No probe reached /slow within 10 s')
      await Bun.sleep(25)
    }
  }

  stop(): void {
    void this.#server.stop(true)
  }
}

/** Reads `url` as an event stream until an event of `type` arrives. */
async function firstEvent(url: string, type: string, timeoutMs = 15_000): Promise<{ id: string; data: unknown }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'text/event-stream' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
    for await (const item of parseSseStream(response.body as ReadableStream<Uint8Array>, {
      signal: controller.signal,
    })) {
      if (item.type === 'event' && item.event === type) return { id: item.id, data: item.json() }
    }
    throw new Error(`The event stream ended without a "${type}" event`)
  } finally {
    clearTimeout(timer)
    controller.abort() // disconnects: the server sees its ctx.signal abort
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

describe.skipIf(!ENABLED)('end to end (production build)', () => {
  let dataDir = ''
  let target: Target
  const running: AppProcess[] = []
  const admin = { 'x-api-key': ADMIN_KEY, 'content-type': 'application/json' }

  /** Starts the build; `undefined` values remove variables from the environment. */
  function start(runtime: 'node' | 'bun', env: Record<string, string | undefined> = {}): AppProcess {
    const args = runtime === 'node' ? ['--enable-source-maps', 'dist/main.js'] : ['dist/main.js']
    const app = new AppProcess(runtime, args, {
      NODE_ENV: 'production',
      API_KEY: ADMIN_KEY,
      READONLY_API_KEY: READER_KEY,
      HOST: '127.0.0.1',
      PORT: '0', // a free port: the actual URL is read from the "ready" log line
      DATABASE_DATA_DIR: dataDir,
      LOG_LEVEL: 'info',
      SCHEDULE_TIME_ZONE: 'Europe/Paris',
      ...env,
    })
    running.push(app)
    return app
  }

  async function post(url: string, body: unknown): Promise<Response> {
    return await fetch(url, { method: 'POST', headers: admin, body: JSON.stringify(body) })
  }

  /**
   * SIGTERM while the probe of the `/slow` monitor is in flight: HTTP stops, the scheduler aborts
   * the run's signal (`shutdown`), fetch closes the connection, the run returns without recording a
   * result, the drain completes, providers stop, the database closes and the process exits with 0.
   */
  async function expectGracefulShutdown(app: AppProcess, slowJob: string): Promise<void> {
    await target.waitForSlowProbe()
    const aborted = target.slowAborted
    const started = performance.now()

    const exit = await app.stop()

    expect(exit).toEqual({ code: 0, signal: null })
    expect(performance.now() - started).toBeLessThan(5_000) // drained, not abandoned
    expect(target.slowAborted).toBeGreaterThan(aborted) // ctx.signal reached fetch
    const logs = app.logs()
    const messages = logs.map(log => log.msg)
    expect(messages).toContain('Received SIGTERM: shutting down gracefully')
    expect(logs).toContainEqual(expect.objectContaining({ msg: 'job completed', job: slowJob, aborted: 'shutdown' }))
    expect(messages).toContain('Uptime monitor stopping') // AppLifecycle.onStop, after the drain
    expect(messages).toContain('Application stopped')
    expect(logs.filter(log => log.level >= 50)).toEqual([]) // no error during the whole run
  }

  beforeAll(async () => {
    const cli = join(ROOT, 'node_modules/@znight/cli/dist/cli.mjs')
    if (!existsSync(cli))
      throw new Error('The @znight/* packages are not built: run `bun run build` at the repository root')
    dataDir = mkdtempSync(join(tmpdir(), 'uptime-monitor-e2e-'))
    target = new Target()
    // `npm run build`: the CLI runs on Node.js, Vite builds src/main.ts into dist/main.js
    const build = await run('node', [cli, 'build'])
    if (build.code !== 0) throw new Error(`znight build failed:\n${build.output}`)
    expect(existsSync(join(ROOT, 'dist/main.js'))).toBe(true)
  }, TIMEOUT)

  afterAll(() => {
    for (const app of running) app.kill()
    target?.stop()
    if (dataDir !== '') rmSync(dataDir, { recursive: true, force: true })
  })

  it(
    'refuses to start with an invalid schedule in its configuration',
    async () => {
      const app = start('node', { DIGEST_CRON: '0 8 * * MON-FRX' })

      const exit = await app.exited

      expect(exit.code).toBe(1)
      expect(app.output).toContain('ZNIGHT040')
      expect(app.output).toContain('MON-FRX')
    },
    TIMEOUT,
  )

  it(
    'monitors a target on Node.js',
    async () => {
      const app = start('node')
      const ready = await app.waitForLog('Uptime monitor ready')
      const url = String(ready.url)
      // the scheduler armed the decorated jobs once everything listened
      await app.waitForLog(/^Schedule: 5 job\(s\), next: /)

      // public health check and status page; the admin endpoints need the admin key
      expect(await (await fetch(`${url}/health`)).json()).toMatchObject({
        status: 'ok',
        scheduler: { state: 'running' },
      })
      expect((await fetch(`${url}/admin/jobs`)).status).toBe(401)
      expect((await fetch(`${url}/admin/jobs`, { headers: { 'x-api-key': READER_KEY } })).status).toBe(403)

      // a monitor every 2 seconds: a dynamic job, armed at once
      const created = await post(`${url}/monitors`, { name: 'Target', url: target.url('/ok'), every: '2s' })
      expect(created.status).toBe(201)
      const { id } = (await created.json()) as { id: number }
      const job = `monitor.${id}`

      // its results, live, over Server-Sent Events
      const event = await firstEvent(`${url}/status/events`, 'probe')
      expect(event.data).toMatchObject({ monitorId: id, up: true, status: 200, error: null })

      // one log line per run, with its job and run id
      const completed = await app.waitForLog('job completed', { job })
      expect(completed).toMatchObject({
        trigger: 'schedule',
        runId: expect.any(String),
        durationMs: expect.any(Number),
      })

      // the registry over HTTP: static and dynamic jobs
      const jobs = (await (await fetch(`${url}/admin/jobs`, { headers: admin })).json()) as JobView[]
      expect(jobs.find(view => view.name === job)).toMatchObject({
        origin: 'dynamic',
        schedule: 'every 2s',
        locked: true,
      })
      expect(jobs.find(view => view.name === 'probes.purge')?.schedule).toBe('0 30 3 * * * (Europe/Paris)')

      // a manual run: 202 at once, then its own log line
      expect((await post(`${url}/admin/jobs/probes.purge/run`, {})).status).toBe(202)
      await app.waitForLog('job completed', { job: 'probes.purge', trigger: 'manual' })

      // a monitor whose target never answers within the test: its probe is in flight at SIGTERM
      const slow = await post(`${url}/monitors`, {
        name: 'Slow',
        url: target.url('/slow'),
        every: '2s',
        timeout: '30s',
      })
      expect(slow.status).toBe(201)
      const slowJob = `monitor.${((await slow.json()) as { id: number }).id}`

      await expectGracefulShutdown(app, slowJob)
    },
    TIMEOUT,
  )

  it(
    'schedules the same monitors on Bun after a restart',
    async () => {
      const app = start('bun')
      await app.waitForLog('Uptime monitor ready')

      // created through the Node.js process, read back from the database by MonitorScheduler.onReady
      expect(await app.waitForLog('Monitors scheduled')).toMatchObject({ monitors: 2 })
      await app.waitForLog('job completed', { job: 'monitor.1', trigger: 'schedule' })

      await expectGracefulShutdown(app, 'monitor.2')
    },
    TIMEOUT,
  )
})
