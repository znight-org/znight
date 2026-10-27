/** `parseSseStream` (RFC 0006 §4.12): the WHATWG "interpreting an event stream" algorithm. */
import { encodeSseEvent, parseSseStream } from '../src/index.ts'
import { describe, expect, it } from 'bun:test'

const ENCODER = new TextEncoder()

function streamOf(chunks: readonly (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++]
      if (chunk === undefined) controller.close()
      else controller.enqueue(typeof chunk === 'string' ? ENCODER.encode(chunk) : chunk)
    },
  })
}

/** Items without their `json` functions (comparable). */
async function parse(...chunks: (string | Uint8Array)[]): Promise<unknown[]> {
  const items: unknown[] = []
  for await (const item of parseSseStream(streamOf(chunks))) {
    items.push(item.type === 'event' ? { type: item.type, event: item.event, data: item.data, id: item.id } : item)
  }
  return items
}

const event = (data: string, extra: { event?: string; id?: string } = {}) => ({
  type: 'event',
  event: extra.event ?? 'message',
  data,
  id: extra.id ?? '',
})

describe('parseSseStream', () => {
  it('parses the examples of the HTML specification', async () => {
    expect(await parse('data: YHOO\ndata: +2\ndata: 10\n\n')).toEqual([event('YHOO\n+2\n10')])
    expect(
      await parse(': test stream\n\ndata: first event\nid: 1\n\ndata:second event\nid\n\ndata:  third event\n\n'),
    ).toEqual([
      { type: 'comment', text: 'test stream' },
      event('first event', { id: '1' }),
      event('second event'),
      event(' third event'),
    ])
    expect(await parse('data\n\ndata\ndata\n\ndata:')).toEqual([event(''), event('\n')])
    expect(await parse('data:test\n\ndata: test\n\n')).toEqual([event('test'), event('test')])
  })

  it('handles CR, LF and CRLF, including a CR split from its LF across chunks', async () => {
    expect(await parse('data: a\r\ndata: b\rdata: c\n\r\n')).toEqual([event('a\nb\nc')])
    expect(await parse('data: a\r', '\n', '\r\n')).toEqual([event('a')])
    expect(await parse('data: a\r', '\r')).toEqual([event('a')])
  })

  it('strips the BOM and decodes UTF-8 split across chunks', async () => {
    const bytes = ENCODER.encode('\uFEFFdata: café ☕\n\n')
    expect(await parse(bytes.slice(0, 10), bytes.slice(10, 11), bytes.slice(11))).toEqual([event('café ☕')])
  })

  it('reads event types, ids, retries and comments', async () => {
    expect(
      await parse(
        'retry: 2500\nevent: status\nid: 41\ndata: {"a":1}\n\n:\n\nretry: 1x\nretry: -1\nevent: done\ndata\n\n',
      ),
    ).toEqual([
      { type: 'retry', retry: 2500 },
      event('{"a":1}', { event: 'status', id: '41' }),
      { type: 'comment', text: '' },
      event('', { event: 'done', id: '41' }),
    ])
  })

  it('ignores ids containing NUL, unknown fields and events without data', async () => {
    expect(await parse('id: 1\n\nid: a\u0000b\nfoo: bar\ndata: x\n\nevent: lonely\n\ndata: y\n\n')).toEqual([
      event('x', { id: '1' }),
      event('y', { id: '1' }),
    ])
  })

  it('discards an unterminated final event', async () => {
    expect(await parse('data: complete\n\ndata: partial\n')).toEqual([event('complete')])
  })

  it('exposes json()', async () => {
    for await (const item of parseSseStream(streamOf(['data: {"n":2}\n\n']))) {
      expect(item.type === 'event' && item.json()).toEqual({ n: 2 })
    }
  })

  it('cancels the body on return() and when the signal aborts', async () => {
    let cancelled = 0
    const body = (): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(ENCODER.encode('data: 1\n\n'))
        },
        cancel() {
          cancelled++
        },
      })
    for await (const item of parseSseStream(body())) {
      expect(item.type).toBe('event')
      break
    }
    expect(cancelled).toBe(1)
    const controller = new AbortController()
    const items = parseSseStream(body(), { signal: controller.signal })
    expect((await items.next()).done).toBe(false)
    const pending = items.next()
    controller.abort()
    expect(await pending).toEqual({ done: true, value: undefined })
    expect(cancelled).toBe(2)
  })

  it('round-trips encodeSseEvent for random strings', async () => {
    const alphabet = ['a', ' ', '\n', '\r', '\r\n', ':', 'é', '😀', 'data: ', '\u0000', '\t']
    let seed = 42
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31
      return seed / 2 ** 31
    }
    for (let round = 0; round < 200; round++) {
      let data = ''
      const length = Math.floor(random() * 12)
      for (let index = 0; index < length; index++) data += alphabet[Math.floor(random() * alphabet.length)]
      const items = await parse(encodeSseEvent({ data, event: 'x', id: round }))
      // line ends are normalised to LF by the protocol
      expect(items).toEqual([event(data.replace(/\r\n|\r/g, '\n'), { event: 'x', id: String(round) })])
    }
  })
})
