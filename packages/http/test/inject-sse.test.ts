/**
 * `injectSse()` never hangs while opening: it waits at most 2 000 ms for the response headers (then
 * fails with the request, which is aborted) and at most 2 000 ms for the first chunk (then the quiet
 * stream is open anyway). Unit tests on a fake `injectStream()` (short bound), then
 * `fixtures/inject-sse-check.ts` on every adapter, in a Node.js 24 process and a Bun process.
 */
import type { InjectStreamOptions, InjectStreamResponse } from '../src/index.ts'

import { fileURLToPath } from 'node:url'

import { openInjectSse } from '../src/inject-sse.ts'
import { describe, expect, it } from 'bun:test'

const ENCODER = new TextEncoder()

/** A body that sends nothing until the test enqueues; `cancelled` resolves when the client cancels it. */
function quietBody(): {
  body: ReadableStream<Uint8Array>
  controller: ReadableStreamDefaultController<Uint8Array>
  cancelled: Promise<true>
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let cancel: (value: true) => void = () => undefined
  const cancelled = new Promise<true>(resolve => {
    cancel = resolve
  })
  const body = new ReadableStream<Uint8Array>({
    start: started => {
      controller = started
    },
    cancel: () => cancel(true),
  })
  return { body, controller: controller as ReadableStreamDefaultController<Uint8Array>, cancelled }
}

function eventStream(body: ReadableStream<Uint8Array>): InjectStreamResponse {
  return { status: 200, headers: { 'content-type': 'text/event-stream' }, cookies: {}, body }
}

function failure(promise: Promise<unknown>): Promise<Error | undefined> {
  return promise.then(
    () => undefined,
    (error: unknown) => error as Error,
  )
}

describe('openInjectSse', () => {
  it('fails with the request when no response headers arrive in time, and aborts the request', async () => {
    let signal: AbortSignal | undefined
    let answer: (response: InjectStreamResponse) => void = () => undefined
    const injectStream = (request: InjectStreamOptions): Promise<InjectStreamResponse> => {
      signal = request.signal
      return new Promise(resolve => {
        answer = resolve
      })
    }
    const started = performance.now()
    const error = await failure(openInjectSse(injectStream, { url: '/stuck' }, 50))
    expect(error?.message).toBe(
      'injectSse(): no response from GET /stuck within 50 ms: the handler has not answered, or the adapter holds the response headers until the first byte of the body',
    )
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(signal?.aborted).toBe(true)
    // a late response is cancelled: the server sees a client disconnect
    const late = quietBody()
    answer(eventStream(late.body))
    expect(await late.cancelled).toBe(true)
  })

  it('opens a quiet event stream after the bound, then reads what it sends later', async () => {
    const quiet = quietBody()
    const started = performance.now()
    const stream = await openInjectSse(async () => eventStream(quiet.body), { url: '/quiet' }, 50)
    expect(performance.now() - started).toBeGreaterThanOrEqual(45)
    expect(stream.status).toBe(200)
    expect(stream.retry).toBeUndefined()
    expect(stream.comments).toEqual([])
    expect((await failure(stream.next({ timeoutMs: 20 })))?.message).toBe(
      'injectSse(): no event received within 20 ms from GET /quiet (the stream has sent nothing since it opened)',
    )
    quiet.controller.enqueue(ENCODER.encode('retry: 3000\n\ndata: late\n\n'))
    expect((await stream.next()).data).toBe('late')
    expect(stream.retry).toBe(3_000)
    // the quiet hint only describes a stream that sent nothing
    expect((await failure(stream.next({ timeoutMs: 20 })))?.message).toBe(
      'injectSse(): no event received within 20 ms from GET /quiet',
    )
    await stream.close()
    expect(await quiet.cancelled).toBe(true)
  })

  it('does not wait for the bound when the first chunk comes at once (the @Sse preamble)', async () => {
    const quiet = quietBody()
    quiet.controller.enqueue(ENCODER.encode('retry: 5000\n\n'))
    const started = performance.now()
    const stream = await openInjectSse(async () => eventStream(quiet.body), { url: '/events' }, 5_000)
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(stream.retry).toBe(5_000)
    await stream.close()
  })

  it('still hands the caller signal to the adapter', async () => {
    const controller = new AbortController()
    let signal: AbortSignal | undefined
    const quiet = quietBody()
    quiet.controller.enqueue(ENCODER.encode(':\n\n'))
    const stream = await openInjectSse(
      request => {
        signal = request.signal
        return Promise.resolve(eventStream(quiet.body))
      },
      { url: '/events', signal: controller.signal },
      50,
    )
    expect(signal?.aborted).toBe(false)
    controller.abort()
    expect(signal?.aborted).toBe(true)
    await stream.close()
  })

  it('reconnect() is bounded the same way', async () => {
    let calls = 0
    const quiet = quietBody()
    quiet.controller.enqueue(ENCODER.encode('id: 7\ndata: one\n\n'))
    const stream = await openInjectSse(
      request => {
        calls++
        if (calls === 1) return Promise.resolve(eventStream(quiet.body))
        expect(request.headers?.['last-event-id']).toBe('7')
        return new Promise(() => undefined)
      },
      { url: '/events' },
      50,
    )
    expect((await stream.next()).data).toBe('one')
    expect((await failure(stream.reconnect()))?.message).toStartWith(
      'injectSse(): no response from GET /events within 50 ms',
    )
  })
})

// ---------------------------------------------------------------------------------------------------
// every adapter, Node.js and Bun

const SCRIPT = fileURLToPath(new URL('./fixtures/inject-sse-check.ts', import.meta.url))

async function run(command: string): Promise<Record<string, unknown>> {
  const child = Bun.spawn([command, '--conditions=@znight/source', SCRIPT], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`${command} exited with ${code}: ${stderr}`)
  return JSON.parse(stdout) as Record<string, unknown>
}

function opened(path: string): Record<string, unknown> {
  return {
    opened: 'opened',
    bounded: true,
    status: 200,
    contentType: 'text/event-stream',
    retry: null,
    comments: [],
    early: `injectSse(): no event received within 50 ms from GET ${path} (the stream has sent nothing since it opened)`,
    closed: 'closed',
  }
}

const EXPECTED = {
  // the headers of a quiet stream are sent at once on every adapter (Fastify held them until the first byte)
  late: { ...opened('/quiet/late'), late: 'late' },
  silent: opened('/quiet/silent'),
  inflight: 0,
}

for (const runtime of ['node', 'bun']) {
  describe(`${runtime} runtime`, () => {
    it('opens quiet event streams after a bounded wait on every adapter, then reads them', async () => {
      const results = await run(runtime === 'node' ? 'node' : process.execPath)
      expect(Object.keys(results)).toEqual(['node', 'fastify', 'express', 'hono'])
      for (const [adapter, observed] of Object.entries(results)) {
        expect({ adapter, observed }).toEqual({ adapter, observed: EXPECTED })
      }
    }, 60_000)
  })
}
