/**
 * Server-Sent Events (RFC 0006 §4.6, §4.7): the encoder, the options and the event stream
 * lifecycle (preamble, heartbeats, raw bytes, failures, client disconnect, graceful close).
 */
import type { RequestAbortKind } from '../src/context.ts'
import type { SseEvent } from '../src/index.ts'
import type { SseHost, SseStreamSettings } from '../src/sse.ts'

import { EventChannel, encodeSseEvent, HttpResponse } from '../src/index.ts'
import { checkSseOptions, isSseSource, SseBody, SseSession } from '../src/sse.ts'
import { parseSseStream } from '../src/sse-parse.ts'
import { caught, sleep } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

describe('encodeSseEvent', () => {
  it('frames the fields in order and ends with an empty line', () => {
    expect(encodeSseEvent({ data: 'hi' })).toBe('data: hi\n\n')
    expect(encodeSseEvent({ comment: 'c1\nc2', id: 41, event: 'status', retry: 500, data: { a: 1 } })).toBe(
      ': c1\n: c2\nid: 41\nevent: status\nretry: 500\ndata: {"a":1}\n\n',
    )
  })

  it('splits data on CRLF, CR and LF (no field injection) and keeps a trailing newline', () => {
    expect(encodeSseEvent({ data: 'a\r\nb\rc\nd' })).toBe('data: a\ndata: b\ndata: c\ndata: d\n\n')
    expect(encodeSseEvent({ data: 'x\n' })).toBe('data: x\ndata: \n\n')
    expect(encodeSseEvent({ data: 'x\n\nevent: evil\nid: 9' })).toBe(
      'data: x\ndata: \ndata: event: evil\ndata: id: 9\n\n',
    )
  })

  it('keeps a leading space and sends empty strings', () => {
    expect(encodeSseEvent({ data: ' padded' })).toBe('data:  padded\n\n')
    expect(encodeSseEvent({ event: 'complete', data: '' })).toBe('event: complete\ndata: \n\n')
  })

  it('serialises non-strings as JSON (toJSON honoured)', () => {
    expect(encodeSseEvent({ data: null })).toBe('data: null\n\n')
    expect(encodeSseEvent({ data: 42 })).toBe('data: 42\n\n')
    expect(encodeSseEvent({ data: [1, 'two'] })).toBe('data: [1,"two"]\n\n')
    expect(encodeSseEvent({ data: new Date(0) })).toBe('data: "1970-01-01T00:00:00.000Z"\n\n')
    expect(encodeSseEvent({ data: { toJSON: () => 'custom' } })).toBe('data: "custom"\n\n')
    expect(encodeSseEvent({ data: { text: 'a\nb' } })).toBe('data: {"text":"a\\nb"}\n\n')
  })

  it('writes an empty data line for an event without data, none for id / retry / comment only', () => {
    expect(encodeSseEvent({ event: 'done' })).toBe('event: done\ndata: \n\n')
    expect(encodeSseEvent({ id: 'x' })).toBe('id: x\n\n')
    expect(encodeSseEvent({ id: '' })).toBe('id: \n\n')
    expect(encodeSseEvent({ retry: 0 })).toBe('retry: 0\n\n')
    expect(encodeSseEvent({ comment: '' })).toBe(':\n\n')
    expect(encodeSseEvent({ comment: 'ping' })).toBe(': ping\n\n')
    expect(encodeSseEvent({ data: undefined, event: 'e' })).toBe('event: e\ndata: \n\n')
    expect(encodeSseEvent(Object.assign(Object.create(null), { data: 1 }))).toBe('data: 1\n\n')
  })

  const invalid: readonly [string, unknown, string][] = [
    ['a string', 'hello', 'yield { data: value }'],
    ['a number', 42, 'received number'],
    ['null', null, 'received null'],
    ['an array', [1], 'received an array'],
    ['a class instance', new Map(), 'an instance of Map'],
    ['an empty object', {}, 'an empty event'],
    ['only undefined values', { data: undefined }, 'an empty event'],
    ['an unknown key', { data: 1, type: 'x' }, 'unknown key "type"'],
    ['an event with LF', { event: 'a\nb' }, 'event must be a string without CR or LF'],
    ['an event with CR', { event: 'a\rb' }, 'without CR or LF'],
    ['a non-string event', { event: 1 }, 'event must be a string'],
    ['an id with LF', { id: '1\n2' }, 'id must be a string without CR, LF or NUL'],
    ['an id with NUL', { id: 'a\u0000' }, 'NUL'],
    ['a non-finite id', { id: Number.NaN }, 'id must be'],
    ['a fractional retry', { retry: 1.5 }, 'retry must be an integer'],
    ['a negative retry', { retry: -1 }, 'retry must be an integer'],
    ['a non-string comment', { comment: 1 }, 'comment must be a string'],
    ['a bigint data', { data: 1n }, 'cannot be serialised as JSON'],
    ['a function data', { data: () => 1 }, 'cannot be serialised as JSON (function)'],
    [
      'a circular data',
      {
        data: (() => {
          const a: Record<string, unknown> = {}
          a['a'] = a
          return a
        })(),
      },
      'JSON',
    ],
  ]
  for (const [name, item, message] of invalid) {
    it(`rejects ${name}`, async () => {
      const error = await caught(() => encodeSseEvent(item as SseEvent))
      expect(error).toBeInstanceOf(TypeError)
      expect((error as Error).message).toContain(message)
    })
  }
})

describe('SSE options and sources', () => {
  it('validates options', () => {
    expect(() => checkSseOptions({ heartbeat: 1_000, retry: 0, maxDuration: 60_000 }, 'x')).not.toThrow()
    expect(() => checkSseOptions({ heartbeat: false, retry: undefined }, 'x')).not.toThrow()
    expect(() => checkSseOptions({ heartbeat: 999 }, 'x')).toThrow('x: heartbeat must be')
    expect(() => checkSseOptions({ heartbeat: true }, 'x')).toThrow('heartbeat')
    expect(() => checkSseOptions({ retry: -1 }, 'x')).toThrow('retry')
    expect(() => checkSseOptions({ maxDuration: 10 }, 'x')).toThrow('maxDuration')
    // above the longest setTimeout delay, the timer would fire after 1 ms
    expect(() => checkSseOptions({ maxDuration: 2_147_483_647, heartbeat: 2_147_483_647 }, 'x')).not.toThrow()
    expect(() => checkSseOptions({ maxDuration: 30 * 24 * 3_600_000 }, 'x')).toThrow(
      'x: maxDuration must be an integer number of ms from 1000 to 2147483647',
    )
    expect(() => checkSseOptions({ heartbeat: 2 ** 31 }, 'x')).toThrow('x: heartbeat must be')
    expect(() => checkSseOptions({ ping: 1 }, 'x')).toThrow('unknown option "ping"')
    expect(() => checkSseOptions(null, 'x')).toThrow('options must be an object')
  })

  it('recognises sources', () => {
    expect(isSseSource([{ data: 1 }])).toBe(true)
    expect(isSseSource(new EventChannel())).toBe(true)
    expect(isSseSource(new ReadableStream())).toBe(true)
    expect(isSseSource((function* () {})())).toBe(true)
    expect(isSseSource('text')).toBe(false)
    expect(isSseSource(undefined)).toBe(false)
    expect(isSseSource({ data: 1 })).toBe(false)
  })

  it('HttpResponse.sse() checks its source and options', () => {
    const response = HttpResponse.sse([{ data: 1 }], { retry: 1 })
    expect(response.body).toBeInstanceOf(SseBody)
    expect(response.status).toBeUndefined()
    expect(() => HttpResponse.sse('data: x\n\n' as never)).toThrow('not a string')
    expect(() => HttpResponse.sse([], { heartbeat: 10 })).toThrow('HttpResponse.sse(): heartbeat')
  })
})

// -------------------------------------------------------------------------------------------------
// The event stream
// -------------------------------------------------------------------------------------------------

const DECODER = new TextDecoder()
const ENCODER = new TextEncoder()

interface Harness {
  readonly session: SseSession
  readonly reader: ReadableStreamDefaultReader<Uint8Array>
  readonly aborts: RequestAbortKind[]
  readonly errors: { message: string; error: unknown }[]
  readonly warnings: string[]
  /** Next chunk as text (`null` at the end). */
  read(): Promise<string | null>
  /** Every remaining chunk. */
  rest(): Promise<string[]>
}

function open(source: unknown, settings: Partial<SseStreamSettings> = {}): Harness {
  const aborts: RequestAbortKind[] = []
  const errors: { message: string; error: unknown }[] = []
  const warnings: string[] = []
  const host: SseHost = {
    abort: kind => aborts.push(kind),
    error: (message, error) => errors.push({ message, error }),
    warn: message => warnings.push(message),
  }
  const session = new SseSession(
    source as never,
    { heartbeat: 0, retry: undefined, maxDuration: undefined, graceMs: 100, ...settings },
    host,
  )
  const reader = session.stream.getReader() as ReadableStreamDefaultReader<Uint8Array>
  const read = async (): Promise<string | null> => {
    const { done, value } = await reader.read()
    return done ? null : DECODER.decode(value)
  }
  return {
    session,
    reader,
    aborts,
    errors,
    warnings,
    read,
    async rest() {
      const chunks: string[] = []
      for (let chunk = await read(); chunk !== null; chunk = await read()) chunks.push(chunk)
      return chunks
    },
  }
}

/** A source counting its reads, blocked until `release()`. */
function gatedSource() {
  const state = { reads: 0, returned: false, release: () => undefined as void }
  async function* source(): AsyncGenerator<SseEvent> {
    try {
      for (;;) {
        state.reads++
        await new Promise<void>(resolve => {
          state.release = resolve
        })
        yield { data: state.reads }
      }
    } finally {
      state.returned = true
    }
  }
  return { state, source: source() }
}

describe('SseSession', () => {
  it('queues the preamble before reading the source', async () => {
    const { state, source } = gatedSource()
    const stream = open(source)
    expect(await stream.read()).toBe(':\n\n')
    expect(state.reads).toBe(0)
    const retried = open([], { retry: 5_000 })
    expect(await retried.rest()).toEqual(['retry: 5000\n\n'])
  })

  it('encodes each event as one chunk and pulls the source once per read', async () => {
    let reads = 0
    function* events(): Generator<SseEvent> {
      for (const n of [1, 2, 3]) {
        reads++
        yield { id: n, data: `event ${n}` }
      }
    }
    const stream = open(events())
    expect(await stream.read()).toBe(':\n\n')
    expect(await stream.read()).toBe('id: 1\ndata: event 1\n\n')
    expect(reads).toBe(1)
    expect(await stream.rest()).toEqual(['id: 2\ndata: event 2\n\n', 'id: 3\ndata: event 3\n\n'])
    expect(stream.session.closed).toBe(true)
  })

  it('reads ReadableStream sources and skips empty raw chunks', async () => {
    const source = new ReadableStream<SseEvent | Uint8Array>({
      start(controller) {
        controller.enqueue({ data: 'a' })
        controller.enqueue(new Uint8Array(0))
        controller.enqueue(ENCODER.encode('data: raw\n\n'))
        controller.close()
      },
    })
    expect(await open(source).rest()).toEqual([':\n\n', 'data: a\n\n', 'data: raw\n\n'])
  })

  it('sends heartbeats only while a read waits, and keeps the pending read', async () => {
    const { state, source } = gatedSource()
    const stream = open(source, { heartbeat: 20 })
    expect(await stream.read()).toBe(':\n\n')
    expect(await stream.read()).toBe(':\n\n') // the source is quiet: a heartbeat
    expect(await stream.read()).toBe(':\n\n')
    expect(state.reads).toBe(1) // the pending read is kept
    await sleep(80) // nobody reads: heartbeats do not pile up
    state.release()
    expect(await stream.read()).toBe('data: 1\n\n')
    expect(state.reads).toBe(1)
    await stream.reader.cancel()
  })

  it('keeps one reaction on a quiet read, however many heartbeats are sent (no leak)', async () => {
    let reactions = 0
    /** Counts the reactions attached to the read (and to the promises derived from it). */
    class Watched<T> extends Promise<T> {
      // biome-ignore lint/suspicious/noThenProperty: a Promise subclass counting its reactions
      override then<A = T, B = never>(
        onFulfilled?: ((value: T) => A | PromiseLike<A>) | null,
        onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
      ): Promise<A | B> {
        reactions++
        return super.then(onFulfilled, onRejected)
      }
    }
    let release: (result: IteratorResult<SseEvent>) => void = () => undefined
    let reads = 0
    const source = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          reads++
          return new Watched<IteratorResult<SseEvent>>(resolve => {
            release = resolve
          })
        },
        return: () => Promise.resolve({ done: true as const, value: undefined }),
      }),
    }
    const stream = open(source, { heartbeat: 1 })
    expect(await stream.read()).toBe(':\n\n')
    for (let beat = 0; beat < 50; beat++) expect(await stream.read()).toBe(':\n\n')
    expect(reads).toBe(1)
    // the outcome mapping and the single recording reaction (it was one more per heartbeat)
    expect(reactions).toBe(2)
    release({ done: false, value: { data: 'late' } })
    expect(await stream.read()).toBe('data: late\n\n')
    await stream.reader.cancel()
  })

  it('an item read while the pull was woken up (graceful close) is still sent', async () => {
    const { state, source } = gatedSource()
    const stream = open(source, { heartbeat: 1_000, graceMs: 30, random: () => 0, stopTimeoutMs: 30 })
    expect(await stream.read()).toBe(':\n\n')
    const next = stream.read()
    await sleep(5)
    // the read settles and the wake-up races it in the same tick
    state.release()
    stream.session.close('shutdown')
    expect(await next).toBe('data: 1\n\n')
    expect(await stream.rest()).toEqual(['retry: 3000\n\n'])
    state.release()
  })

  it('never inserts a heartbeat inside raw bytes that do not end at an event boundary', async () => {
    let release: () => void = () => undefined
    async function* upstream(): AsyncGenerator<Uint8Array> {
      yield ENCODER.encode('data: par')
      await new Promise<void>(resolve => {
        release = resolve
      })
      yield ENCODER.encode('tial\r\n\r\n')
      await new Promise<void>(resolve => {
        release = resolve
      })
    }
    const stream = open(upstream(), { heartbeat: 15 })
    expect(await stream.read()).toBe(':\n\n')
    expect(await stream.read()).toBe('data: par')
    const next = stream.read()
    await sleep(60)
    release()
    expect(await next).toBe('tial\r\n\r\n') // no heartbeat in between
    expect(await stream.read()).toBe(':\n\n') // at a boundary again
    const cancelled = stream.reader.cancel()
    release() // the generator waits in an await: it stops once it settles
    await cancelled
  })

  it('treats a trailing CR as a possible CRLF (no heartbeat until the next byte)', async () => {
    let release: () => void = () => undefined
    async function* upstream(): AsyncGenerator<Uint8Array> {
      yield ENCODER.encode('data: x\r\n\r')
      await new Promise<void>(resolve => {
        release = resolve
      })
      yield ENCODER.encode('\ndata: y\n\n')
    }
    const stream = open(upstream(), { heartbeat: 15 })
    await stream.read()
    expect(await stream.read()).toBe('data: x\r\n\r')
    const next = stream.read()
    await sleep(50)
    release()
    expect(await next).toBe('\ndata: y\n\n')
    expect(await stream.rest()).toEqual([])
  })

  it('resumes heartbeats once the LF of a CRLF boundary split across chunks arrives', async () => {
    let release: () => void = () => undefined
    async function* upstream(): AsyncGenerator<Uint8Array> {
      yield ENCODER.encode('data: x\r\n\r')
      await new Promise<void>(resolve => {
        release = resolve
      })
      yield ENCODER.encode('\n') // the LF completing \r\n\r\n, alone, then a quiet upstream
      await new Promise<void>(resolve => {
        release = resolve
      })
    }
    const stream = open(upstream(), { heartbeat: 15 })
    await stream.read()
    expect(await stream.read()).toBe('data: x\r\n\r')
    const lf = stream.read()
    await sleep(30)
    release()
    expect(await lf).toBe('\n')
    expect(await stream.read()).toBe(':\n\n') // at a boundary again: heartbeats resume
    const cancelled = stream.reader.cancel()
    release()
    await cancelled
  })

  it('never writes the final retry inside an unterminated raw event (shutdown, maxDuration)', async () => {
    const parse = async (chunks: readonly string[]): Promise<string[]> => {
      const events: string[] = []
      const body = new Response(chunks.join('')).body as ReadableStream<Uint8Array>
      for await (const item of parseSseStream(body)) {
        if (item.type === 'event') events.push(item.data)
        else if (item.type === 'retry') events.push(`retry ${item.retry}`)
      }
      return events
    }
    // the grace period ends while the last raw chunk is a partial event
    let release: () => void = () => undefined
    async function* upstream(): AsyncGenerator<Uint8Array> {
      try {
        yield ENCODER.encode('data: {"token":"a"}\n\n')
        yield ENCODER.encode('data: {"token":"hel')
        await new Promise<void>(resolve => {
          release = resolve
        })
      } finally {
        release = () => undefined
      }
    }
    const cut = open(upstream(), { graceMs: 20, random: () => 0, stopTimeoutMs: 20 })
    expect(await cut.read()).toBe(':\n\n')
    expect(await cut.read()).toBe('data: {"token":"a"}\n\n')
    expect(await cut.read()).toBe('data: {"token":"hel')
    void cut.read() // a read waits on the source
    cut.session.close('expired')
    const rest = await cut.rest()
    release()
    expect(rest).toEqual([]) // no retry glued to the fragment: the client discards it at EOF
    expect(await parse([':\n\n', 'data: {"token":"a"}\n\n', 'data: {"token":"hel', ...rest])).toEqual(['{"token":"a"}'])
    // the upstream ends mid-event during the grace period
    function* truncated(): Generator<Uint8Array> {
      yield ENCODER.encode('data: {"token":"hel')
    }
    const ended = open(truncated(), { graceMs: 1_000 })
    expect(await ended.read()).toBe(':\n\n')
    ended.session.close('shutdown')
    expect(await ended.rest()).toEqual(['data: {"token":"hel'])
    // at a boundary (LF, CRLF or a final CR ending an empty line), the retry is sent
    for (const tail of ['data: a\n\n', 'data: a\r\n\r\n', 'data: a\r\n\r']) {
      function* framed(): Generator<Uint8Array> {
        yield ENCODER.encode(tail)
      }
      const stream = open(framed(), { graceMs: 1_000, random: () => 0 })
      expect(await stream.read()).toBe(':\n\n')
      stream.session.close('shutdown')
      const chunks = await stream.rest()
      expect(chunks).toEqual([tail, 'retry: 3000\n\n'])
      expect(await parse([':\n\n', ...chunks])).toEqual(['a', 'retry 3000'])
    }
  })

  it('refuses an SseEvent after raw bytes that do not end at an event boundary', async () => {
    function* mixed(): Generator<unknown> {
      yield ENCODER.encode('data: {"token":"hel')
      yield { event: 'done', data: 'x' }
    }
    const stream = open(mixed())
    expect(await stream.rest()).toEqual([':\n\n', 'data: {"token":"hel'])
    expect(String((stream.errors[0]?.error as Error | undefined)?.message)).toContain(
      'an SseEvent cannot follow raw bytes that do not end at an event boundary',
    )
    function* framed(): Generator<unknown> {
      yield ENCODER.encode('data: a\r\n\r')
      yield { event: 'done', data: 'x' }
    }
    expect(await open(framed()).rest()).toEqual([':\n\n', 'data: a\r\n\r', 'event: done\ndata: x\n\n'])
  })

  it('caps its timers at the longest setTimeout delay (a larger one would fire after 1 ms)', async () => {
    const channel = new EventChannel<SseEvent>()
    const stream = open(channel, { maxDuration: 30 * 24 * 3_600_000, heartbeat: 2 ** 31 })
    expect(await stream.read()).toBe(':\n\n')
    const next = stream.read()
    await sleep(50)
    expect(stream.aborts).toEqual([]) // neither expired nor flooded with heartbeats
    channel.push({ data: 1 })
    expect(await next).toBe('data: 1\n\n')
    await stream.reader.cancel()
  })

  it('ends cleanly and logs when the source fails', async () => {
    function* failing(): Generator<SseEvent> {
      yield { data: 1 }
      throw new Error('upstream down')
    }
    const stream = open(failing())
    expect(await stream.rest()).toEqual([':\n\n', 'data: 1\n\n'])
    expect(stream.errors).toEqual([{ message: 'The SSE stream failed', error: expect.any(Error) }])
    expect(stream.errors[0]?.error).toMatchObject({ message: 'upstream down' })
  })

  it('stops the source and ends cleanly on an invalid item', async () => {
    let returned = false
    function* invalid(): Generator<unknown> {
      try {
        yield { data: 1 }
        yield 'raw text'
        yield { data: 'never' }
      } finally {
        returned = true
      }
    }
    const stream = open(invalid())
    expect(await stream.rest()).toEqual([':\n\n', 'data: 1\n\n'])
    expect(returned).toBe(true)
    expect(String((stream.errors[0]?.error as Error | undefined)?.message)).toContain('yield { data: value }')
  })

  it('on cancel: aborts the signal (client), returns the source and ends', async () => {
    const { state, source } = gatedSource()
    const stream = open(source)
    await stream.read()
    const pending = stream.read() // a read waits on the source
    await sleep(5)
    const cancelled = stream.reader.cancel()
    state.release() // the generator honours the stop once its await settles
    await cancelled
    expect(await pending).toBeNull()
    expect(stream.aborts).toEqual(['client'])
    expect(state.returned).toBe(true)
    expect(stream.warnings).toEqual([])
    await stream.session.ended
  })

  it('bounds the wait for a source ignoring its signal, with a warning', async () => {
    const { state, source } = gatedSource()
    const stream = open(source, { stopTimeoutMs: 50 })
    await stream.read()
    void stream.read()
    await sleep(5)
    const started = performance.now()
    await stream.reader.cancel()
    expect(performance.now() - started).toBeGreaterThanOrEqual(45)
    expect(state.returned).toBe(false)
    expect(stream.warnings).toEqual([
      'The SSE source did not stop within 50 ms after its signal was aborted: make it honour ctx.signal',
    ])
    state.release()
  })

  it('cancelled before its first read (HEAD): an async generator body never runs', async () => {
    let ran = false
    async function* body(): AsyncGenerator<SseEvent> {
      ran = true
      await Promise.resolve()
      yield { data: 1 }
    }
    const session = new SseSession(
      body(),
      { heartbeat: 0, retry: undefined, maxDuration: undefined, graceMs: 10 },
      {
        abort: () => undefined,
        error: () => undefined,
        warn: () => undefined,
      },
    )
    await session.stream.cancel()
    expect(ran).toBe(false)
    // an unread EventChannel is closed
    const channel = new EventChannel<SseEvent>()
    await new SseSession(
      channel,
      { heartbeat: 0, retry: undefined, maxDuration: undefined, graceMs: 10 },
      {
        abort: () => undefined,
        error: () => undefined,
        warn: () => undefined,
      },
    ).stream.cancel()
    expect(channel.closed).toBe(true)
  })

  it('graceful close: the source yields its final events, then a jittered retry ends the stream', async () => {
    const channel = new EventChannel<SseEvent>()
    const stream = open(channel, { retry: 1_000, random: () => 0.5, graceMs: 1_000 })
    expect(await stream.read()).toBe('retry: 1000\n\n')
    stream.session.close('shutdown')
    stream.session.close('expired') // idempotent
    expect(stream.aborts).toEqual(['shutdown'])
    channel.push({ event: 'bye', data: 'final' })
    channel.close()
    const started = performance.now()
    expect(await stream.rest()).toEqual(['event: bye\ndata: final\n\n', 'retry: 1500\n\n'])
    expect(performance.now() - started).toBeLessThan(500) // the source finished by itself
  })

  it('graceful close: the grace period bounds a source that does not finish', async () => {
    const { state, source } = gatedSource()
    const stream = open(source, { graceMs: 40, random: () => 0, stopTimeoutMs: 50 })
    await stream.read()
    const started = performance.now()
    stream.session.close('expired')
    const chunks = await stream.rest()
    expect(chunks).toEqual(['retry: 3000\n\n']) // default reconnection delay, no jitter drawn
    expect(performance.now() - started).toBeGreaterThanOrEqual(35)
    expect(stream.aborts).toEqual(['expired'])
    state.release()
  })

  it('draws the final retry uniformly in [r, 2r]', async () => {
    for (const draw of [0, 0.25, 0.999]) {
      const stream = open([], { retry: 2_000, random: () => draw })
      stream.session.close('shutdown')
      const chunks = await stream.rest()
      const retry = Number(/retry: (\d+)/.exec(chunks.at(-1) ?? '')?.[1])
      expect(retry).toBeGreaterThanOrEqual(2_000)
      expect(retry).toBeLessThanOrEqual(4_000)
    }
  })

  it('maxDuration closes the stream gracefully (expired)', async () => {
    const channel = new EventChannel<SseEvent>({ signal: undefined })
    const stream = open(channel, { maxDuration: 30, graceMs: 20 })
    expect(await stream.read()).toBe(':\n\n')
    const chunks = await stream.rest()
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatch(/^retry: \d+\n\n$/)
    expect(stream.aborts).toEqual(['expired'])
  })

  it('does not log an AbortError raised by a source honouring the signal while closing', async () => {
    let reject: (error: unknown) => void = () => undefined
    async function* source(): AsyncGenerator<SseEvent> {
      await new Promise((_, fail) => {
        reject = fail
      })
      yield { data: 'never' }
    }
    const stream = open(source())
    await stream.read()
    const rest = stream.rest()
    await sleep(5)
    stream.session.close('shutdown')
    reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    expect((await rest).at(-1)).toMatch(/^retry: /)
    expect(stream.errors).toEqual([])
  })
})
