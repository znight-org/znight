/**
 * End-to-end test of the production build (opt-in: `ZNIGHT_E2E=1`, about 10 s):
 *
 * 1. `znight build` (Vite + the `znight()` plugin) bundles the service into `dist/main.js`;
 * 2. `znight start --runtime node`, then `--runtime bun`, run it as a real process (the in-memory
 *    broker, `PORT=0` / `METRICS_PORT=0`: the ports are read from the logs);
 * 3. the scenarios run over real HTTP: health check, confirmed / rejected / retried / dead-lettered
 *    orders, validation, trace propagation from `POST /orders` to the consumer (logs), metrics;
 * 4. `SIGTERM`: the process must exit with code 0 after running its shutdown hooks.
 *
 * With `ZNIGHT_INTEGRATION=1` and Docker, the same scenarios also run against RabbitMQ (a
 * `rabbitmq:4.1-alpine` container started with the Docker CLI).
 *
 * In this repository the `znight` binary and the framework packages run from their `dist`: run
 * `bun run build` at the repository root first.
 */

import type { Order } from '../src/orders/order.model.js'

import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { TestPaymentMethods } from '../src/payments/payment.gateway.js'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

const enabled = process.env['ZNIGHT_E2E'] === '1'
const withRabbitMQ = enabled && process.env['ZNIGHT_INTEGRATION'] === '1'

const ROOT = resolve(import.meta.dir, '..')
const ZNIGHT = join(ROOT, 'node_modules/.bin/znight')
const TIMEOUT = 120_000
const RABBITMQ_IMAGE = 'rabbitmq:4.1-alpine'

type LogEntry = Record<string, unknown> & { readonly msg?: string }

interface Result {
  readonly code: number | null
  readonly output: string
}

/** Runs a command to completion (output = stdout + stderr). */
function run(command: string, args: readonly string[], cwd = ROOT): Promise<Result> {
  return new Promise(done => {
    const child = spawn(command, [...args], { cwd, env: { ...process.env, NO_COLOR: '1' } })
    let output = ''
    child.stdout.on('data', chunk => {
      output += chunk
    })
    child.stderr.on('data', chunk => {
      output += chunk
    })
    child.on('error', error => done({ code: null, output: `${output}\n${error.message}` }))
    child.on('close', code => done({ code, output }))
  })
}

const sleep = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))

/** Polls `probe` until it returns a value (not `undefined`). */
async function eventually<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== undefined) return value
    await sleep(50)
  }
  throw new Error(`Timed out waiting for ${what}`)
}

/** The built service, running in its own process (`znight start`). */
class Service {
  readonly logs: LogEntry[] = []
  #output = ''
  #api = ''
  #metrics = ''
  readonly #exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>

  private constructor(private readonly child: ChildProcess) {
    let pending = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      this.#output += chunk
      pending += chunk
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) this.#parse(line)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      this.#output += chunk
    })
    this.#exit = new Promise(done => child.once('exit', (code, signal) => done({ code, signal })))
  }

  /** `znight start` on `runtime`, ready once the HTTP and metrics servers listen. */
  static async start(runtime: 'node' | 'bun', env: Record<string, string> = {}): Promise<Service> {
    const child = spawn('node', [ZNIGHT, 'start', '--runtime', runtime], {
      cwd: ROOT,
      env: {
        ...process.env,
        NO_COLOR: '1',
        RABBITMQ_URL: '', // the in-memory broker, unless `env` says otherwise
        ...env,
        PORT: '0', // free ports, read from the logs
        METRICS_PORT: '0',
        LOG_LEVEL: 'info',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const service = new Service(child)
    let exited = false
    void service.#exit.then(() => {
      exited = true
    })
    await eventually(
      'the service to listen',
      () => {
        if (exited) throw new Error(`The service exited during startup:\n${service.output}`)
        return Promise.resolve(service.#api !== '' && service.#metrics !== '' ? true : undefined)
      },
      30_000,
    )
    return service
  }

  get output(): string {
    return this.#output
  }

  url(path: string): string {
    return `${this.#api}${path}`
  }

  get metricsUrl(): string {
    return this.#metrics
  }

  /** Log entries with this message. */
  entries(msg: string): LogEntry[] {
    return this.logs.filter(entry => entry.msg === msg)
  }

  /** Sends SIGTERM and waits for the exit. */
  async stop(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    this.child.kill('SIGTERM')
    return await this.#exit
  }

  /** Kills the process if a test failed before stopping it. */
  kill(): void {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL')
  }

  #parse(line: string): void {
    if (!line.startsWith('{')) return
    const entry = JSON.parse(line) as LogEntry
    this.logs.push(entry)
    const listening = /^HTTP server listening on (\S+)$/.exec(entry.msg ?? '')
    if (listening?.[1] !== undefined) this.#api = listening[1]
    if (entry.msg === 'Metrics server listening' && typeof entry['url'] === 'string') this.#metrics = entry['url']
  }
}

/** `POST /orders`; returns the created order and the trace id of the request (`traceresponse`). */
async function placeOrder(service: Service, paymentMethod: string): Promise<{ order: Order; traceId: string }> {
  const response = await fetch(service.url('/orders'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      customerId: 'customer-e2e',
      paymentMethod,
      lines: [{ sku: 'BOOK-42', quantity: 2, unitPrice: 1250 }],
    }),
  })
  expect(response.status).toBe(201)
  const order = (await response.json()) as Order
  expect(response.headers.get('location')).toBe(`/orders/${order.id}`)
  const traceId = response.headers.get('traceresponse')?.split('-')[1]
  expect(traceId).toMatch(/^[\da-f]{32}$/)
  return { order, traceId: traceId as string }
}

/** Polls `GET /orders/:id` until the order leaves the `pending` status. */
function settled(service: Service, id: string): Promise<Order> {
  return eventually(`order ${id} to be processed`, async () => {
    const order = (await (await fetch(service.url(`/orders/${id}`))).json()) as Order
    return order.status === 'pending' ? undefined : order
  })
}

/** The scenarios, against the service started by `start`; the last one stops it. */
function scenarios(start: () => Promise<Service>): void {
  let service: Service

  beforeAll(async () => {
    service = await start()
  }, TIMEOUT)

  afterAll(() => {
    service?.kill()
  })

  it('answers the health check', async () => {
    const response = await fetch(service.url('/health'))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: 'ok',
      consumers: [{ queue: 'orders.created', state: 'running' }],
    })
  })

  it(
    'confirms a paid order; the consumer continues the trace of the request',
    async () => {
      const { order, traceId } = await placeOrder(service, TestPaymentMethods.visa)
      expect(order.status).toBe('pending')

      const confirmed = await settled(service, order.id)
      expect(confirmed).toMatchObject({ status: 'confirmed', amount: 2500 })

      // logs of the HTTP request and of the message delivery share the trace id
      const created = await eventually('the "Order created" log', () =>
        Promise.resolve(service.entries('Order created').find(entry => entry['orderId'] === order.id)),
      )
      expect(created['traceId']).toBe(traceId)
      const processed = await eventually('the "Order confirmed" log', () =>
        Promise.resolve(service.entries('Order confirmed').find(entry => entry['orderId'] === order.id)),
      )
      expect(processed['traceId']).toBe(traceId)
      expect(processed['spanId']).not.toBe(created['spanId']) // the consumer span, child of the producer span
    },
    TIMEOUT,
  )

  it(
    'rejects an order whose payment is declined (no retry)',
    async () => {
      const { order } = await placeOrder(service, TestPaymentMethods.declined)
      expect(await settled(service, order.id)).toMatchObject({
        status: 'rejected',
        reason: expect.stringContaining('declined'),
      })
    },
    TIMEOUT,
  )

  it(
    'retries transient failures with an exponential backoff',
    async () => {
      const { order } = await placeOrder(service, TestPaymentMethods.flaky)
      const confirmed = await settled(service, order.id)
      expect(confirmed.status).toBe('confirmed')
      expect(service.entries('Order confirmed').find(entry => entry['orderId'] === order.id)).toMatchObject({
        attempt: 3,
      })
    },
    TIMEOUT,
  )

  it(
    'fails the order and dead-letters the message once every attempt failed',
    async () => {
      const { order } = await placeOrder(service, TestPaymentMethods.unavailable)
      expect(await settled(service, order.id)).toMatchObject({
        status: 'failed',
        reason: 'Payment gateway unavailable (503)',
      })
      const deadLettered = await eventually('the "message dead-lettered" log', () =>
        Promise.resolve(service.entries('message dead-lettered').find(entry => entry['messageId'] === order.id)),
      )
      expect(deadLettered).toMatchObject({ queue: 'orders.created', attempt: 4, outcome: 'dead-letter' })
    },
    TIMEOUT,
  )

  it('rejects invalid requests with 400 and unknown orders with 404', async () => {
    const invalid = await fetch(service.url('/orders'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customerId: '', paymentMethod: 'visa', lines: [] }),
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ statusCode: 400, message: 'Invalid body' })
    expect((await fetch(service.url('/orders/42'))).status).toBe(400)
    expect((await fetch(service.url(`/orders/${crypto.randomUUID()}`))).status).toBe(404)
  })

  it('exposes HTTP, messaging and business metrics', async () => {
    const metrics = await (await fetch(service.metricsUrl)).text()
    /** Value of the series of `name` carrying every label of `labels` (`key="value"`). */
    const value = (name: string, ...labels: string[]): number => {
      const line = metrics
        .split('\n')
        .find(candidate => candidate.startsWith(`${name}{`) && labels.every(label => candidate.includes(label)))
      return line === undefined ? 0 : Number(line.slice(line.lastIndexOf(' ') + 1))
    }
    // acknowledged: visa, declined (by @OnError) and flaky (third attempt)
    expect(value('messaging_messages_processed_total', 'outcome="ack"')).toBe(3)
    // retried: flaky (2) and unavailable (3); dead-lettered: unavailable
    expect(value('messaging_messages_processed_total', 'outcome="retry"')).toBe(5)
    expect(value('messaging_messages_processed_total', 'outcome="dead-letter"')).toBe(1)
    expect(value('orders_created_total', 'outcome="success"')).toBe(4)
    expect(value('http_server_requests_total', 'method="POST"', 'route="/orders"', 'status="201"')).toBe(4)
    expect(value('http_server_requests_total', 'route="/orders/:id"', 'status="404"')).toBe(1)
  })

  it(
    'stops gracefully on SIGTERM (exit code 0, shutdown hooks run)',
    async () => {
      const { code, signal } = await service.stop()
      if (code !== 0) throw new Error(`exit code ${code} (signal ${signal}):\n${service.output}`)
      const messages = service.logs.map(entry => entry.msg)
      expect(messages).toContain('Received SIGTERM: shutting down gracefully')
      expect(messages).toContain('Order store closed') // provider disposal
      expect(messages).toContain('Tracing stopped') // plugin onDispose
      expect(messages.at(-1)).toBe('Application stopped')
    },
    TIMEOUT,
  )
}

describe.skipIf(!enabled)('production build (ZNIGHT_E2E=1)', () => {
  beforeAll(async () => {
    if (!existsSync(ZNIGHT) || !existsSync(join(ROOT, '../../packages/cli/dist/cli.mjs'))) {
      throw new Error('The znight CLI is not built: run `bun run build` at the repository root')
    }
    const build = await run('node', [ZNIGHT, 'build'])
    if (build.code !== 0) throw new Error(`znight build failed:\n${build.output}`)
    expect(readFileSync(join(ROOT, 'dist/main.js'), 'utf8')).toContain('Application.create')
  }, TIMEOUT)

  describe('on Node.js', () => {
    scenarios(() => Service.start('node'))
  })

  describe('on Bun', () => {
    scenarios(() => Service.start('bun'))
  })

  describe.skipIf(!withRabbitMQ)('on Node.js with RabbitMQ (ZNIGHT_INTEGRATION=1)', () => {
    let container = ''

    beforeAll(async () => {
      const started = await run('docker', ['run', '-d', '-p', '127.0.0.1::5672', RABBITMQ_IMAGE])
      if (started.code !== 0) throw new Error(`docker run failed:\n${started.output}`)
      container = started.output.trim().split('\n').at(-1) ?? ''
      // the logs, not `rabbitmq-diagnostics`: run as root before the broker created its Erlang
      // cookie, the CLI would create it and the broker could not read it anymore
      let logs: Result | undefined
      await eventually(
        'RabbitMQ to start',
        async () => {
          logs = await run('docker', ['logs', container])
          return logs.output.includes('Server startup complete') ? true : undefined
        },
        90_000,
      ).catch((error: unknown) => {
        throw new Error(`${String(error)}:\n${logs?.output.slice(-3000)}`)
      })
    }, TIMEOUT)

    afterAll(async () => {
      if (container !== '') await run('docker', ['rm', '-f', container])
    })

    // retried messages are republished through RabbitMQ (attempts counted with x-znight-attempt)
    scenarios(async () => {
      const port = (await run('docker', ['port', container, '5672/tcp'])).output.trim().split(':').at(-1)
      return await Service.start('node', { RABBITMQ_URL: `amqp://guest:guest@127.0.0.1:${port}` })
    })

    it(
      'kept the failed message in the dead-letter queue',
      async () => {
        // queue statistics are refreshed every few seconds
        let queues = ''
        const found = await eventually(
          'the dead letter in orders.created.dlq',
          async () => {
            queues = (await run('docker', ['exec', container, 'rabbitmqctl', 'list_queues', '-q', 'name', 'messages']))
              .output
            return /orders\.created\.dlq\s+1\b/.test(queues) ? true : undefined
          },
          20_000,
        ).catch(() => false)
        expect(found ? queues : `missing dead letter:\n${queues}`).toMatch(/orders\.created\.dlq\s+1\b/)
      },
      TIMEOUT,
    )
  })
})
