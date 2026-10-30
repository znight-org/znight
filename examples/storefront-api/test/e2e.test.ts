/**
 * End-to-end test (opt-in, `ZNIGHT_E2E=1`, `bun run test:e2e`): builds the application for
 * production with `znight build`, starts the bundle with Node.js and with Bun as a separate process
 * configured through environment variables, talks to it over real HTTP with the **typed client**
 * generated from `openapi.json` (src/client), then stops it with SIGTERM during an upload and checks
 * the graceful shutdown (in-flight request drained, shutdown hooks, exit code 0).
 *
 * The client's types come from the committed document: a server change that breaks the contract
 * fails `bun run typecheck` on this file.
 *
 * In this repository the build imports the @znight/* packages from their `dist` (like packages
 * installed from npm): run `bun run build` at the repository root first.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createStorefrontClient, type Order, readNdjson } from '../src/client/client.js'
import { MUG, PNG_BYTES, TEE, UNKNOWN_ID } from './support/fixtures.js'
import { committedOpenApi, validateOpenApi } from './support/openapi.js'
import { AppProcess, type Exit, type LogEntry, ROOT, run, znightCli } from './support/process.js'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

const ENABLED = process.env.ZNIGHT_E2E === '1'
const TIMEOUT = 60_000

const ADMIN_KEY = 'e2e-admin-key'
const CATALOG_KEY = 'e2e-catalog-key'
const ALICE_TOKEN = 'e2e-alice-token'

/**
 * A multipart upload whose last bytes are only sent when `finish()` is called: an in-flight request
 * for as long as the test wants.
 */
function slowImageUpload(
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
          `--${boundary}\r\ncontent-disposition: form-data; name="image"; filename="slow.png"\r\ncontent-type: image/png\r\n\r\n`,
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

describe.skipIf(!ENABLED)('end to end (production build)', () => {
  const running: AppProcess[] = []

  /** Starts the build; `undefined` values remove variables from the environment. */
  function start(runtime: 'node' | 'bun', env: Record<string, string | undefined> = {}): AppProcess {
    const args = runtime === 'node' ? ['--enable-source-maps', 'dist/main.js'] : ['dist/main.js']
    const app = new AppProcess(runtime, args, {
      NODE_ENV: 'production', // serves dist/openapi.json (src/main.ts)
      HOST: '127.0.0.1',
      PORT: '0', // a free port: the actual URL is read from the "ready" log line
      LOG_LEVEL: 'info',
      ADMIN_API_KEY: ADMIN_KEY,
      CATALOG_API_KEY: CATALOG_KEY,
      CUSTOMER_TOKENS: JSON.stringify({ alice: ALICE_TOKEN }),
      CATALOG_SEED: 'true',
      ...env,
    })
    running.push(app)
    return app
  }

  beforeAll(async () => {
    // `npm run build`: the CLI runs on Node.js, Vite builds src/main.ts into dist/main.js, then the
    // `openapi()` plugin of vite.config.ts writes dist/openapi.json (and checks openapi.json)
    const build = await run('node', [znightCli(), 'build'])
    if (build.code !== 0) throw new Error(`znight build failed:\n${build.output}`)
  }, TIMEOUT)

  afterAll(() => {
    for (const app of running) app.kill()
  })

  it('emits the committed document next to the bundle', async () => {
    const emitted = readFileSync(join(ROOT, 'dist/openapi.json'), 'utf8')

    expect(emitted).toBe(committedOpenApi())
    expect(await validateOpenApi(JSON.parse(emitted))).toMatchObject({ valid: true, version: '3.1' })
  })

  it(
    'refuses to start without its required configuration',
    async () => {
      const app = start('node', { ADMIN_API_KEY: undefined })

      const exit = await app.exited

      expect(exit.code).toBe(1)
      expect(app.output).toContain('ZNIGHT006')
      expect(app.output).toContain('ADMIN_API_KEY')
      expect(app.output).not.toContain(ALICE_TOKEN) // secrets are never printed
    },
    TIMEOUT,
  )

  /**
   * The main scenarios through the typed client, then SIGTERM during an upload: the server stops
   * accepting connections but lets the in-flight request finish, then providers stop and the
   * process exits. Returns the exit and the messages logged.
   */
  async function exercise(runtime: 'node' | 'bun'): Promise<{ exit: Exit; messages: string[] }> {
    const app = start(runtime)
    const ready: LogEntry = await app.waitForLog('Storefront API ready')
    const baseUrl = String(ready.url)
    expect(ready.operations).toBe(13)

    // the documentation, served from dist/openapi.json in production: the committed bytes
    const served = await fetch(`${baseUrl}/openapi.json`)
    expect(served.headers.get('etag')).toMatch(/^"[\w-]{27}"$/)
    expect(await served.text()).toBe(committedOpenApi())
    expect((await fetch(`${baseUrl}/docs`)).headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200)

    const shop = createStorefrontClient({ baseUrl })
    const backOffice = createStorefrontClient({ baseUrl, apiKey: CATALOG_KEY })
    const admin = createStorefrontClient({ baseUrl, apiKey: ADMIN_KEY })
    const alice = createStorefrontClient({ baseUrl, token: ALICE_TOKEN })

    // the public catalogue: typed query parameters (`sort` is a union of literals, `tag` an array)
    const list = await shop.GET('/products', { params: { query: { sort: 'price-asc', tag: ['gift'] } } })
    expect(list.data?.items.map(product => product.sku)).toEqual(['MUG-ZNIGHT', 'TEE-DI-BLACK'])
    const missing = await shop.GET('/products/{id}', { params: { path: { id: UNKNOWN_ID } } })
    expect(missing.response.status).toBe(404)
    expect(missing.error?.message).toBe(`No product ${UNKNOWN_ID}`) // the error body is typed too

    // the back office adds a product: the body is the schema input (a price in euros, as a string)
    const created = await backOffice.POST('/products', {
      body: { sku: 'e2e-cap', name: 'Znight cap', category: 'apparel', price: '19.90', stock: 3, tags: ['Cap'] },
    })
    expect(created.response.status).toBe(201)
    expect(created.data).toMatchObject({ sku: 'E2E-CAP', priceCents: 1990, tags: ['cap'], inStock: true })
    expect(created.response.headers.get('location')).toBe(`/products/${created.data?.id}`)
    const forbidden = await alice.POST('/products', {
      body: { sku: 'e2e-hat', name: 'Hat', category: 'apparel', price: '9' },
    })
    expect(forbidden.response.status).toBe(403)

    // an image: multipart upload (openapi-typescript types file fields as strings, so `fetch` here)
    const form = new FormData()
    form.append('image', new File([PNG_BYTES], 'mug.png', { type: 'image/png' }))
    const upload = await fetch(`${baseUrl}/products/${MUG}/image`, {
      method: 'PUT',
      headers: { 'x-api-key': CATALOG_KEY },
      body: form,
    })
    expect(upload.status).toBe(200)
    const image = await fetch(`${baseUrl}/products/${MUG}/image`)
    expect(image.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG_BYTES)

    // a customer fills a cart and orders it, paid by card
    const cart = await alice.POST('/carts')
    const cartId = cart.data?.id ?? ''
    expect(cart.response.status).toBe(201)
    await alice.POST('/carts/{id}/items', { params: { path: { id: cartId } }, body: { productId: MUG, quantity: 2 } })
    const filled = await alice.POST('/carts/{id}/items', { params: { path: { id: cartId } }, body: { productId: TEE } })
    expect(filled.data?.totalCents).toBe(2 * 1490 + 2400)
    const placed = await alice.POST('/orders', {
      body: { cartId, payment: { method: 'card', token: 'tok_visa_4242' } },
    })
    expect(placed.response.status).toBe(201)
    const order = placed.data
    if (order === undefined) throw new Error(`POST /orders failed: ${JSON.stringify(placed.error)}`)
    // `payment` is a tagged union in the generated types: `method` narrows it
    expect(order.payment.method === 'card' ? order.payment.last4 : undefined).toBe('4242')
    expect(order.status).toBe('paid')
    const again = await alice.GET('/orders/{id}', { params: { path: { id: order.id } } })
    expect(again.data).toEqual(order)

    // the back office: statistics and the NDJSON export, read as it streams
    const stats = await admin.GET('/admin/stats')
    expect(stats.data).toMatchObject({ orders: 1, revenueCents: 2 * 1490 + 2400, ordersByStatus: { paid: 1 } })
    const exported = await admin.GET('/orders/export', { parseAs: 'stream' })
    expect(exported.response.headers.get('content-type')).toBe('application/x-ndjson')
    const orders: Order[] = []
    if (exported.data) for await (const line of readNdjson<Order>(exported.data)) orders.push(line)
    expect(orders.map(line => line.id)).toEqual([order.id])

    // structured logs: one line per request, the documentation requests left out
    const completed = app.logs().filter(log => log.msg === 'request completed')
    expect(completed).toContainEqual(expect.objectContaining({ method: 'POST', route: '/orders', status: 201 }))
    expect(completed.map(log => log.route)).not.toContain('/openapi.json')

    // graceful shutdown during an upload
    const slow = slowImageUpload(`${baseUrl}/products/${TEE}/image`, { 'x-api-key': CATALOG_KEY })
    await Bun.sleep(300) // the request is in flight: its headers and first bytes were received
    const exiting = app.stop()
    await app.waitForLog('Received SIGTERM: shutting down gracefully')
    await Bun.sleep(300) // the HTTP plugin is draining
    slow.finish()

    expect((await slow.response).status).toBe(200) // drained
    const exit = await exiting
    expect(app.logs().filter(log => log.level >= 50)).toEqual([]) // no error during the whole run
    return { exit, messages: app.logs().map(log => log.msg) }
  }

  for (const [runtime, server] of [
    ['node', '@hono/node-server'],
    ['bun', 'Bun.serve'],
  ] as const) {
    it(
      `serves the API on ${runtime === 'node' ? 'Node.js' : 'Bun'} (${server}) and stops gracefully`,
      async () => {
        const { exit, messages } = await exercise(runtime)

        expect(exit).toEqual({ code: 0, signal: null })
        expect(messages).toContain('Storefront API stopping') // AppLifecycle.onStop
        expect(messages).toContain('Application stopped')
      },
      TIMEOUT,
    )
  }
})
