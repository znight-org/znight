/**
 * Regression check executed by `test/regressions-runtime.test.ts` with Node.js
 * (`node --conditions=@znight/source`) and Bun: serves a small application on every adapter and
 * prints, as JSON, what edge cases answer (file bodies and request scopes, invalid headers, returned
 * Web streams, unfinished body streams on keep-alive connections, bodyless uploads, raw-path routing,
 * unparseable content types, redirects, graceful drain, Express body parsers).
 */
import type { HttpContext } from '../../src/index.ts'

import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import express from 'express'

import { expressAdapter } from '../../src/adapters/express.ts'
import { BadRequestException, HttpResponse, uploads } from '../../src/index.ts'
import { ADAPTERS, controller, createApp, metadata, provider, route, sleep, t } from '../helpers.ts'

const REPORT_SIZE = 2 * 1024 * 1024
const events: string[] = []

/** A request-scoped provider owning a temporary directory, deleted when the request is over. */
class TempDir {
  readonly dir: string = fs.mkdtempSync(path.join(os.tmpdir(), 'znight-regressions-'));
  [Symbol.dispose](): void {
    events.push('dispose')
    fs.rmSync(this.dir, { recursive: true, force: true })
  }
}

/** Holds `GET /slow` in flight. */
const gate = {
  release: (): void => undefined,
  started: (): void => undefined,
  wait: Promise.resolve(),
  /** Resolves once a request waits at the gate. */
  reset(): Promise<void> {
    const started = new Promise<void>(resolve => {
      this.started = resolve
    })
    this.wait = new Promise<void>(resolve => {
      this.release = resolve
    })
    return started
  },
}

class Controller {
  readonly #tmp: TempDir
  constructor(tmp: TempDir) {
    this.#tmp = tmp
  }
  report() {
    const file = path.join(this.#tmp.dir, 'report.bin')
    fs.writeFileSync(file, new Uint8Array(REPORT_SIZE).fill(65))
    return HttpResponse.file(file, { filename: 'report.bin' })
  }
  badStream(ctx: HttpContext) {
    ctx.setHeader('x-bad', 'a\r\nb')
    return HttpResponse.stream(Readable.from(['hello']))
  }
  go(next: unknown) {
    return HttpResponse.redirect(String(next))
  }
  webStrings() {
    return new ReadableStream<string>({
      start(controller) {
        controller.enqueue('hello ')
        controller.enqueue('world')
        controller.close()
      },
    })
  }
  webBuffers() {
    return new HttpResponse(
      new ReadableStream<ArrayBuffer>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('hello ').buffer)
          controller.enqueue(new TextEncoder().encode('buffers').buffer)
          controller.close()
        },
      }),
    )
  }
  async sniff(ctx: HttpContext) {
    const reader = ctx.bodyStream().getReader()
    const first = await reader.read()
    if (first.value?.[0] !== 0x89) throw new BadRequestException('Not a PNG')
    return { ok: true }
  }
  ping() {
    return 'pong'
  }
  upload(file: File | undefined) {
    return { file: file?.name ?? null }
  }
  echo(ctx: HttpContext) {
    return { path: ctx.path, rest: ctx.params['*'] }
  }
  bytes(body: unknown) {
    if (body instanceof Uint8Array) return { type: 'bytes' }
    return { type: body === undefined ? 'none' : typeof body }
  }
  slug(slug: string) {
    return { slug }
  }
  mime(name: unknown) {
    return HttpResponse.stream(Readable.from(['x']), { filename: String(name) })
  }
  async slow() {
    gate.started()
    await gate.wait
    return 'slow done'
  }
}

const meta = metadata(
  {
    [t('TempDir')]: provider(TempDir, [], 'request'),
    [t('Controller')]: provider(Controller, [t('TempDir')], 'request'),
  },
  [
    controller(t('Controller'), '/', [
      route('report', '/report', (c: Controller) => c.report()),
      route('badStream', '/bad-stream', (c: Controller, ctx) => c.badStream(ctx)),
      route('go', '/go', (c: Controller, ctx) => c.go(ctx.query['next'])),
      route('webStrings', '/web/strings', (c: Controller) => c.webStrings()),
      route('webBuffers', '/web/buffers', (c: Controller) => c.webBuffers()),
      route('sniff', '/sniff', (c: Controller, ctx) => c.sniff(ctx), { method: 'PUT', bodyLimit: 10_000_000 }),
      route('ping', '/ping', (c: Controller) => c.ping()),
      route('upload', '/upload', (c: Controller, ctx) => c.upload(uploads.optionalFile(ctx, 'file')), {
        method: 'POST',
        params: [{ index: 0, source: 'file', name: 'file', optional: true }],
        uploads: [{ field: 'file' }],
      }),
      route('echo', '/echo/*', (c: Controller, ctx) => c.echo(ctx)),
      route('bytes', '/bytes', (c: Controller, ctx) => c.bytes(ctx.body), {
        method: 'POST',
        params: [{ index: 0, source: 'body' }],
      }),
      route('slug', '/:slug', (c: Controller, ctx) => c.slug(ctx.params['slug'] as string)),
      route('mime', '/mime', (c: Controller, ctx) => c.mime(ctx.query['name'])),
      route('slow', '/slow', (c: Controller) => c.slow()),
    ]),
  ],
)

/** Sends raw bytes on one connection and resolves with everything received (closed or timed out). */
function exchange(
  port: number,
  first: string | Uint8Array,
  next?: { readonly after: string; readonly send: string },
  timeoutMs = 4000,
): Promise<string> {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1')
    let received = ''
    let sent = false
    const done = (suffix = ''): void => {
      clearTimeout(timer)
      socket.destroy()
      resolve(received + suffix)
    }
    const timer = setTimeout(() => done(' [timeout]'), timeoutMs)
    socket.on('connect', () => socket.write(first))
    socket.on('data', data => {
      received += data.toString('latin1')
      if (next !== undefined && !sent && received.includes(next.after)) {
        sent = true
        socket.write(next.send)
      }
    })
    socket.on('end', () => done())
    socket.on('error', error => done(` [${(error as NodeJS.ErrnoException).code ?? error.message}]`))
  })
}

/** Status line, selected headers and body of the raw responses in `received`. */
function responses(received: string, headers: readonly string[] = []): string[] {
  const result: string[] = []
  for (const match of received.matchAll(/HTTP\/1\.1 (\d{3})[^\r]*\r\n([\s\S]*?)\r\n\r\n/g)) {
    const lines = (match[2] ?? '').split('\r\n')
    const picked = headers.map(name => {
      const line = lines.find(candidate => candidate.toLowerCase().startsWith(`${name}:`))
      return `${name}=${line === undefined ? '' : line.slice(name.length + 1).trim()}`
    })
    result.push([match[1], ...picked].join(' '))
  }
  if (received.endsWith(']')) result.push(received.slice(received.lastIndexOf(' [') + 1))
  return result
}

function bodyOf(received: string): string {
  const start = received.indexOf('\r\n\r\n')
  if (start === -1) return ''
  const head = received.slice(0, start).toLowerCase()
  const rest = received.slice(start + 4)
  if (!head.includes('transfer-encoding: chunked')) return rest
  let body = ''
  let offset = 0
  for (;;) {
    const end = rest.indexOf('\r\n', offset)
    if (end === -1) return body
    const size = Number.parseInt(rest.slice(offset, end), 16)
    if (!(size > 0)) return body
    body += rest.slice(end + 2, end + 2 + size)
    offset = end + 2 + size + 2
  }
}

/** Runs one check; a failure (connection reset...) is reported instead of aborting the run. */
async function check(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn()
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code
    return { error: `${(error as Error).message}${cause === undefined ? '' : ` (${cause})`}` }
  }
}

const results: Record<string, unknown> = {}
for (const adapter of ADAPTERS) {
  const app = await createApp(meta, { adapter: adapter.create(), trailingSlash: 'redirect' })
  const base = String(app.http.address)
  const port = app.http.address?.port as number
  const statuses: number[] = []
  app.app.hooks.on('http:request', event => {
    if (event.path === '/bad-stream') statuses.push(event.status ?? 0)
  })
  const result: Record<string, unknown> = {}

  // file bodies keep the request scope (and the file it owns) until they are sent
  result['file'] = await check(async () => {
    events.length = 0
    const report = await fetch(`${base}/report`)
    const length = report.headers.get('content-length')
    const received = (await report.arrayBuffer()).byteLength
    for (let index = 0; index < 100 && app.http.inflight > 0; index++) await sleep(10)
    return { status: report.status, length, received, disposed: events.length, inflight: app.http.inflight }
  })

  // an invalid header on a streamed response: one plain 500, the stream released
  result['badHeader'] = await check(async () => {
    const bad = await fetch(`${base}/bad-stream`)
    const body = await bad.text()
    await sleep(50)
    return { status: bad.status, body, inflight: app.http.inflight, hooks: [...statuses] }
  })
  result['badHeaderInject'] = await check(async () => {
    const injected = await app.http.inject({ method: 'GET', url: '/bad-stream' })
    return { status: injected.status, body: injected.body }
  })
  result['crlfRedirect'] = await check(async () => {
    const redirect = await fetch(`${base}/go?next=/x%0d%0aSet-Cookie:a=b`, { redirect: 'manual' })
    return { status: redirect.status, body: await redirect.text(), cookie: redirect.headers.get('set-cookie') }
  })

  // returned Web streams of strings / ArrayBuffers
  result['webStreams'] = await check(async () => {
    const strings = await fetch(`${base}/web/strings`)
    const buffers = await fetch(`${base}/web/buffers`)
    const injected = await app.http.inject({ method: 'GET', url: '/web/strings' })
    return {
      strings: [strings.status, await strings.text()],
      buffers: [buffers.status, await buffers.text()],
      inject: [injected.status, injected.body],
    }
  })
  await sleep(20)
  result['webStreamsInflight'] = app.http.inflight

  // a handler reading the first chunk of a 1 MiB body, then failing: the connection serves the next request
  result['keepAlive'] = await check(async () => {
    const size = 1024 * 1024
    const wedge = await exchange(
      port,
      Buffer.concat([
        Buffer.from(`PUT /sniff HTTP/1.1\r\nHost: x\r\ncontent-length: ${size}\r\n\r\n`),
        Buffer.alloc(size, 0x41),
      ]),
      { after: 'Not a PNG', send: 'GET /ping HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n' },
    )
    return { responses: responses(wedge), pong: wedge.includes('pong') }
  })

  // bodyless requests to an upload route: no file
  result['bodylessUpload'] = await check(async () => {
    const empty = await exchange(
      port,
      'POST /upload HTTP/1.1\r\nHost: x\r\ncontent-length: 0\r\nConnection: close\r\n\r\n',
    )
    const unframed = await exchange(port, 'POST /upload HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
    return [responses(empty), bodyOf(empty), responses(unframed), bodyOf(unframed)]
  })

  // routing on the raw path (dot segments are not resolved)
  result['routing'] = await check(async () => {
    const routing: string[] = []
    for (const target of ['/echo/a/../b', '/echo/%2e%2e/x', '/echo/./c']) {
      const raw = await exchange(port, `GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)
      routing.push(`${responses(raw).join(' ')} ${bodyOf(raw)}`)
    }
    return routing
  })

  // content types Fastify cannot parse reach the route (bytes)
  result['contentTypes'] = await check(async () => {
    const contentTypes: string[] = []
    for (const type of ['foo', '']) {
      const raw = await exchange(
        port,
        `POST /bytes HTTP/1.1\r\nHost: x\r\ncontent-type: ${type}\r\ncontent-length: 7\r\nConnection: close\r\n\r\n{"a":1}`,
      )
      contentTypes.push(`${responses(raw).join(' ')} ${bodyOf(raw)}`)
    }
    return contentTypes
  })

  // trailingSlash redirects never leave the origin
  result['redirect'] = await check(async () => {
    const backslash = await exchange(port, 'GET /\\evil.com/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
    return responses(backslash, ['location'])
  })

  // an extension that is an Object.prototype key
  result['mime'] = await check(async () => {
    const proto = await fetch(`${base}/mime?name=data.__proto__`)
    await proto.arrayBuffer()
    return [proto.status, proto.headers.get('content-type')]
  })

  await Promise.race([app.stop(), sleep(6000)])

  // drainTimeoutMs: Infinity waits for in-flight requests
  result['drainInfinity'] = await check(async () => {
    const draining = await createApp(meta, { adapter: adapter.create(), drainTimeoutMs: Number.POSITIVE_INFINITY })
    const started = gate.reset()
    const pending = fetch(`${String(draining.http.address)}/slow`).then(
      response => response.text(),
      () => 'failed',
    )
    await started
    const stopping = draining.app.stop()
    await sleep(300)
    gate.release()
    const answer = await pending
    await stopping
    return answer
  })

  results[adapter.name] = result
}

// Express: a body parser registered before the Znight routes consumed the body
results['expressBodyParser'] = await check(async () => {
  const parsed = express()
  parsed.use(express.json())
  const app = await createApp(meta, { adapter: expressAdapter({ app: parsed }) })
  const consumed = await fetch(`${String(app.http.address)}/bytes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"a":1}',
  })
  await consumed.arrayBuffer()
  await app.stop()
  return {
    status: consumed.status,
    logged: app.logger.entries.some(entry => /already read by a middleware/.test(String(entry.context?.['err']))),
  }
})

process.stdout.write(JSON.stringify(results))
process.exit(0)
