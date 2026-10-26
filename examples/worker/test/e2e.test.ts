/**
 * End-to-end: the production build (`znight build`), run as a real process with Node.js and with Bun.
 *
 *   ZNIGHT_E2E=1 bun test test/e2e.test.ts
 *   ZNIGHT_E2E=1 ZNIGHT_E2E_RABBITMQ_URL=amqp://guest:guest@localhost:5672 bun test test/e2e.test.ts
 *
 * With the memory driver, jobs are written to the worker's stdin inbox. With RabbitMQ (opt-in), they
 * are published by scripts/publish.ts. Each run ends with SIGTERM while a slow report is in flight:
 * the report must complete, the shutdown hooks run and the process exit with code 0.
 */
import type { LogEntry } from './support.js'

import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeAll, describe, expect, test as it } from 'bun:test'

const root = fileURLToPath(new URL('..', import.meta.url))
const enabled = process.env.ZNIGHT_E2E === '1'
const rabbitmqUrl = process.env.ZNIGHT_E2E_RABBITMQ_URL
const runtimes = ['node', 'bun'] as const
type Runtime = (typeof runtimes)[number]

/** The built worker, running in a child process. */
class WorkerProcess {
  readonly entries: LogEntry[] = []
  readonly #output: string[] = []
  readonly #child: ChildProcess
  readonly #waiters = new Set<() => void>()
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>

  constructor(runtime: Runtime, env: Readonly<Record<string, string>>) {
    this.#child = spawn(runtime, ['dist/main.js'], {
      cwd: root,
      env: { ...process.env, NODE_ENV: 'production', LOG_LEVEL: 'info', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const collect = (stream: NodeJS.ReadableStream | null, label: string, json: boolean): void => {
      if (stream === null) return
      createInterface({ input: stream }).on('line', line => {
        this.#output.push(`${label} ${line}`)
        if (json && line.startsWith('{')) this.entries.push(JSON.parse(line) as LogEntry)
        for (const waiter of this.#waiters) waiter()
      })
    }
    collect(this.#child.stdout, 'out', true)
    collect(this.#child.stderr, 'err', false)
    this.exited = new Promise(resolve => this.#child.on('exit', (code, signal) => resolve({ code, signal })))
  }

  /** Lines written on stderr. */
  get stderr(): string[] {
    return this.#output.filter(line => line.startsWith('err ')).map(line => line.slice(4))
  }

  /** Writes a job to the stdin inbox. */
  send(job: object): void {
    this.#child.stdin?.write(`${JSON.stringify(job)}\n`)
  }

  /** Resolves with the first log entry matching `predicate` (already logged or to come). */
  waitFor(description: string, predicate: (entry: LogEntry) => boolean, timeoutMs = 15_000): Promise<LogEntry> {
    return new Promise((resolve, reject) => {
      const check = (): void => {
        const entry = this.entries.find(predicate)
        if (entry === undefined) return
        cleanup()
        resolve(entry)
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`Timed out waiting for ${description}. Output:\n${this.#output.slice(-40).join('\n')}`))
      }, timeoutMs)
      const cleanup = (): void => {
        clearTimeout(timer)
        this.#waiters.delete(check)
      }
      this.#waiters.add(check)
      check()
    })
  }

  /** Index of the first entry with this message (and fields), -1 when absent. */
  indexOf(msg: string, fields: Readonly<Record<string, unknown>> = {}): number {
    return this.entries.findIndex(
      entry => entry.msg === msg && Object.entries(fields).every(([key, value]) => entry[key] === value),
    )
  }

  kill(signal: NodeJS.Signals): void {
    if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill(signal)
  }
}

const processes: WorkerProcess[] = []

function startWorker(runtime: Runtime, env: Readonly<Record<string, string>>): WorkerProcess {
  const worker = new WorkerProcess(runtime, env)
  processes.push(worker)
  return worker
}

const emailJob = (to: string, data: Record<string, string> = { name: 'Ada' }) => ({
  queue: 'emails.send',
  type: 'email.send',
  payload: { to, template: 'welcome', data },
})

const reportJob = (reportId: string, from: string, to: string, notify?: string) => ({
  queue: 'reports.generate',
  type: 'report.generate',
  payload: { reportId, kind: 'sales', from, to, ...(notify === undefined ? {} : { notify }) },
})

/** SIGTERM while `reportId` is being generated: the report completes, then the worker stops cleanly. */
async function expectGracefulShutdown(worker: WorkerProcess, reportId: string, outputDir: string): Promise<void> {
  await worker.waitFor('the slow report to start', e => e.msg === 'Generating report' && e.reportId === reportId)
  worker.kill('SIGTERM')
  const exit = await worker.exited

  expect(exit).toEqual({ code: 0, signal: null })
  const signalled = worker.indexOf('Received SIGTERM: shutting down gracefully')
  const finishing = worker.indexOf('Shutdown requested: finishing the report first', { reportId })
  const generated = worker.indexOf('Report generated', { reportId })
  const smtpClosed = worker.indexOf('SMTP connection closed') // @Provides({ dispose: 'close' })
  const stopped = worker.indexOf('Application stopped')
  expect(signalled).toBeGreaterThan(-1)
  expect(finishing).toBeGreaterThan(signalled)
  expect(generated).toBeGreaterThan(finishing) // the in-flight message completed after SIGTERM...
  expect(smtpClosed).toBeGreaterThan(generated) // ...before the providers were disposed
  expect(stopped).toBeGreaterThan(smtpClosed)
  expect(worker.entries.at(-1)?.msg).toBe('Application stopped')
  const csv = await readFile(join(outputDir, `${reportId}.csv`), 'utf8')
  expect(csv.trimEnd().split('\n')).toHaveLength(1 + 365)
  expect(worker.stderr).toEqual([])
}

describe.skipIf(!enabled)('worker, end to end', () => {
  let outputDir: string

  beforeAll(() => {
    // the real production build: src/main.ts -> dist/main.js
    const build = spawnSync('node', ['node_modules/.bin/znight', 'build'], { cwd: root, encoding: 'utf8' })
    if (build.status !== 0) throw new Error(`znight build failed:\n${build.stdout}\n${build.stderr}`)
  }, 120_000)

  afterEach(async () => {
    for (const worker of processes.splice(0)) worker.kill('SIGKILL')
    if (outputDir !== undefined) await rm(outputDir, { recursive: true, force: true })
  })

  it.each(runtimes)(
    '%s, memory broker: handles jobs from the stdin inbox and drains on SIGTERM',
    async runtime => {
      outputDir = await mkdtemp(join(tmpdir(), 'znight-worker-e2e-'))
      const worker = startWorker(runtime, {
        WORKER_STDIN_INBOX: 'true',
        RABBITMQ_URL: '', // blank = unset, even if a local .env file sets it: the memory driver
        REPORTS_OUTPUT_DIR: outputDir,
        REPORTS_MS_PER_DAY: '5', // the yearly report below takes ~2 s
        SMTP_LATENCY_MS: '5',
      })
      await worker.waitFor('the stdin inbox', e => e.msg.startsWith('Stdin inbox: reading jobs'))

      worker.send(emailJob('ada@example.com'))
      worker.send(emailJob('grace@flaky.test', { name: 'Grace' }))
      worker.send(emailJob('ghost@bounce.test'))
      worker.send({ queue: 'emails.send', type: 'email.send', payload: { to: 'nope', template: 'welcome' } })
      worker.send(reportJob('e2e-q1', '2026-01-01', '2026-03-31', 'ada@example.com'))

      await worker.waitFor('the welcome email', e => e.msg === 'Email sent' && e.to === 'ada@example.com')
      await worker.waitFor('the retried email', e => e.msg === 'Email sent' && e.to === 'grace@flaky.test')
      const retried = await worker.waitFor('the retry', e => e.msg === 'message failed, will be retried')
      expect(retried).toMatchObject({ consumer: 'EmailConsumer', attempt: 1, outcome: 'retry' })
      await worker.waitFor('the hard bounce', e => e.msg === 'Hard bounce: recipient suppressed')
      const deadLetter = await worker.waitFor('the dead letter', e => e.msg === 'message dead-lettered')
      expect(deadLetter).toMatchObject({ queue: 'emails.send', err: { type: 'MessageValidationError' } })
      await worker.waitFor('the report', e => e.msg === 'Report generated' && e.reportId === 'e2e-q1')
      await worker.waitFor('the report email', e => e.msg === 'Email sent' && e.template === 'report-ready')

      worker.send(reportJob('e2e-yearly', '2025-01-01', '2025-12-31'))
      await expectGracefulShutdown(worker, 'e2e-yearly', outputDir)

      // only the expected failure was logged as an error (the dead-lettered invalid payload)
      const errors = worker.entries.filter(entry => entry.level >= 50)
      expect(errors.every(entry => JSON.stringify(entry).includes('MessageValidationError'))).toBe(true)
    },
    60_000,
  )

  it.skipIf(rabbitmqUrl === undefined).each(runtimes)(
    '%s, RabbitMQ: handles jobs published by scripts/publish.ts and drains on SIGTERM',
    async runtime => {
      const url = rabbitmqUrl as string
      outputDir = await mkdtemp(join(tmpdir(), 'znight-worker-e2e-'))
      const run = `e2e-${runtime}-${Date.now()}`
      const worker = startWorker(runtime, { RABBITMQ_URL: url, REPORTS_OUTPUT_DIR: outputDir, REPORTS_MS_PER_DAY: '5' })
      await worker.waitFor(
        'the consumers',
        e => e.msg === 'Messaging: 2 consumer(s) subscribed with the rabbitmq driver',
      )

      const publish = (...args: string[]): void => {
        const result = spawnSync('node', ['scripts/publish.ts', ...args], {
          cwd: root,
          encoding: 'utf8',
          env: { ...process.env, RABBITMQ_URL: url },
        })
        if (result.status !== 0) throw new Error(`publish.ts failed:\n${result.stdout}\n${result.stderr}`)
      }
      publish('report', `${run}-q1`, '2026-01-01', '2026-03-31', 'ada@example.com')
      await worker.waitFor('the report', e => e.msg === 'Report generated' && e.reportId === `${run}-q1`)
      await worker.waitFor('the report email', e => e.msg === 'Email sent' && e.correlationId === `report-${run}-q1`)

      publish('report', `${run}-yearly`, '2025-01-01', '2025-12-31')
      await expectGracefulShutdown(worker, `${run}-yearly`, outputDir)
    },
    60_000,
  )
})
