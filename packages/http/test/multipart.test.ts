/**
 * The streaming multipart parser: RFC 7578 / 2046 framing (boundaries split across chunks,
 * preamble, epilogue, transport padding, CRLF edge cases), part headers (quoted strings, RFC 5987
 * `filename*`, folding), limits and policies, and equivalence with the Web-standard `formData()`.
 */
import type { FileRule, MultipartPolicy, MultipartResult } from '../src/multipart.ts'

import {
  BadRequestException,
  type HttpException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '../src/index.ts'
import {
  MultipartParser,
  multipartBoundary,
  parseMultipart,
  parseParameters,
  readMultipart,
  toFormData,
} from '../src/multipart.ts'
import { caught } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

const ENCODER = new TextEncoder()
const OPEN: MultipartPolicy = { rules: [], maxParts: Number.POSITIVE_INFINITY, maxFieldSize: Number.POSITIVE_INFINITY }

function bytes(...parts: (string | Uint8Array)[]): Uint8Array {
  const chunks = parts.map(part => (typeof part === 'string' ? ENCODER.encode(part) : part))
  const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

interface Part {
  readonly name: string
  readonly value: string | Uint8Array
  readonly filename?: string
  readonly type?: string
  readonly headers?: readonly string[]
}

/** Builds a multipart body with CRLF line endings. */
function body(boundary: string, parts: readonly Part[], options: { preamble?: string; epilogue?: string } = {}) {
  const chunks: (string | Uint8Array)[] = []
  if (options.preamble !== undefined) chunks.push(`${options.preamble}\r\n`)
  for (const part of parts) {
    chunks.push(`--${boundary}\r\n`)
    const filename = part.filename === undefined ? '' : `; filename="${part.filename}"`
    chunks.push(`Content-Disposition: form-data; name="${part.name}"${filename}\r\n`)
    if (part.type !== undefined) chunks.push(`Content-Type: ${part.type}\r\n`)
    for (const header of part.headers ?? []) chunks.push(`${header}\r\n`)
    chunks.push('\r\n', part.value, '\r\n')
  }
  chunks.push(`--${boundary}--`)
  if (options.epilogue !== undefined) chunks.push(options.epilogue)
  return bytes(...chunks)
}

function parse(data: Uint8Array, boundary = 'b', policy: MultipartPolicy = OPEN): MultipartResult {
  return parseMultipart(data, `multipart/form-data; boundary=${boundary}`, policy)
}

/** Feeds `data` to a parser in the given chunks. */
function parseChunks(chunks: readonly Uint8Array[], boundary = 'b', policy: MultipartPolicy = OPEN) {
  return readMultipart(streamOf(chunks), `multipart/form-data; boundary=${boundary}`, policy)
}

function streamOf(chunks: readonly Uint8Array[], onCancel?: (reason: unknown) => void): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++]
      if (chunk === undefined) controller.close()
      else controller.enqueue(chunk)
    },
    cancel: onCancel,
  })
}

/** A comparable view of a result (files as name / type / text). */
function summary(result: MultipartResult) {
  return Promise.all(
    result.entries.map(async ([name, value]) =>
      typeof value === 'string'
        ? [name, value]
        : [name, { filename: value.name, type: value.type, bytes: [...new Uint8Array(await value.arrayBuffer())] }],
    ),
  )
}

function rule(overrides: Partial<FileRule> = {}): FileRule {
  return { field: 'file', multiple: false, maxSize: 1000, maxFiles: 1, mimeTypes: undefined, ...overrides }
}

function policy(rules: readonly FileRule[], extra: Partial<MultipartPolicy> = {}): MultipartPolicy {
  return { rules, maxParts: 100, maxFieldSize: 1000, ...extra }
}

const SAMPLE = body(
  'XyZ',
  [
    { name: 'title', value: 'Hello, world' },
    { name: 'file', value: 'line 1\r\nline 2--XyZ\r\n-XyZ\r\n--Xy', filename: 'a.txt', type: 'text/plain' },
    { name: 'tags', value: 'a' },
    { name: 'tags', value: 'b' },
    { name: 'binary', value: new Uint8Array([0, 13, 10, 45, 45, 255, 13]), filename: 'b.bin' },
  ],
  { preamble: 'This is the preamble, --XyZ inline.\r\n-XyZ', epilogue: '\r\nepilogue\r\n--XyZ\r\n' },
)

describe('framing', () => {
  it('parses fields and files, in body order', async () => {
    const result = parse(SAMPLE, 'XyZ')
    expect({ ...result.fields }).toEqual({ title: 'Hello, world', tags: ['a', 'b'] })
    expect(Object.keys(result.files)).toEqual(['file', 'binary'])
    expect(result.list.map(file => file.name)).toEqual(['a.txt', 'b.bin'])
    expect(await summary(result)).toEqual([
      ['title', 'Hello, world'],
      [
        'file',
        {
          filename: 'a.txt',
          type: 'text/plain',
          bytes: [...ENCODER.encode('line 1\r\nline 2--XyZ\r\n-XyZ\r\n--Xy')],
        },
      ],
      ['tags', 'a'],
      ['tags', 'b'],
      ['binary', { filename: 'b.bin', type: 'application/octet-stream', bytes: [0, 13, 10, 45, 45, 255, 13] }],
    ])
    expect(Object.getPrototypeOf(result.fields)).toBeNull()
    expect(Object.getPrototypeOf(result.files)).toBeNull()
  })

  it('gives the same result whatever the chunk boundaries (every split point, every chunk size)', async () => {
    const expected = await summary(parse(SAMPLE, 'XyZ'))
    for (let split = 1; split < SAMPLE.byteLength; split++) {
      const result = await parseChunks([SAMPLE.subarray(0, split), SAMPLE.subarray(split)], 'XyZ')
      expect(await summary(result)).toEqual(expected)
    }
    for (const size of [1, 2, 3, 5, 7, 11, 64]) {
      const chunks: Uint8Array[] = []
      for (let offset = 0; offset < SAMPLE.byteLength; offset += size)
        chunks.push(SAMPLE.subarray(offset, offset + size))
      expect(await summary(await parseChunks(chunks, 'XyZ'))).toEqual(expected)
    }
  })

  it('accepts a body starting with the boundary, transport padding and an epilogue', () => {
    const data = bytes('--b \t \r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--b--\r\nignored')
    expect({ ...parse(data).fields }).toEqual({ a: '1' })
  })

  it('keeps CR, LF and dashes that do not form a delimiter', async () => {
    // (a line starting with the whole delimiter `--b` is a delimiter, RFC 2046 §5.1.1: see the malformed cases)
    for (const value of ['\r', '\n', '\r\n', '\r\n-', '\r\n--', '\r\n--c', '--b', 'x--b--', 'x\r\n\r\n--', '-b\r']) {
      const result = parse(body('b', [{ name: 'f', value, filename: 'x' }]))
      expect(await (result.list[0] as File).text()).toBe(value)
    }
  })

  it('handles empty values and empty files', () => {
    const result = parse(
      body('b', [
        { name: 'empty', value: '' },
        { name: 'file', value: '', filename: 'empty.txt', type: 'text/plain' },
      ]),
    )
    expect(result.fields['empty']).toBe('')
    expect((result.files['file'] as File[])[0]?.size).toBe(0)
  })

  it('ignores the empty part of an empty <input type="file"> (no filename, no content)', () => {
    const result = parse(
      body('b', [
        { name: 'avatar', value: '', filename: '', type: 'application/octet-stream' },
        { name: 'x', value: '1' },
      ]),
    )
    expect(result.list).toEqual([])
    expect({ ...result.fields }).toEqual({ x: '1' })
  })

  it('works with long boundaries with special characters', () => {
    const boundary = `----WebKitFormBoundary'()+_,-./:=?${'x'.repeat(30)}`
    const result = parseMultipart(
      body(boundary, [{ name: 'a', value: `--${boundary.slice(0, -1)}` }]),
      `multipart/form-data; boundary="${boundary}"`,
      OPEN,
    )
    expect(result.fields['a']).toBe(`--${boundary.slice(0, -1)}`)
  })

  it.each([
    ['garbage', 'garbage'],
    ['no closing delimiter', '--b\r\nContent-Disposition: form-data; name="a"\r\n\r\nvalue'],
    ['truncated closing delimiter', '--b\r\nContent-Disposition: form-data; name="a"\r\n\r\nvalue\r\n--b-'],
    ['LF line endings', '--b\nContent-Disposition: form-data; name="a"\n\nvalue\n--b--'],
    ['delimiter followed by text', '--b\r\nContent-Disposition: form-data; name="a"\r\n\r\nv\r\n--bX\r\n--b--'],
    [
      'delimiter line in a preamble',
      'preamble\r\n--b-not\r\n--b\r\nContent-Disposition: form-data; name="a"\r\n\r\nv\r\n--b--',
    ],
    ['empty body', ''],
  ])('rejects malformed bodies: %s', async (_name, text) => {
    const error = await caught(() => parse(bytes(text)))
    expect(error).toBeInstanceOf(BadRequestException)
    expect((error as Error).message).toStartWith('Invalid multipart body: ')
    expect((error as HttpException).headers).toEqual({ connection: 'close' })
  })

  it('matches the Web-standard formData() on random valid bodies', async () => {
    let seed = 42
    const random = (max: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed % max
    }
    const alphabet = ['a', 'b', '\r', '\n', '-', '=', ' ', '"', 'é', '\u0000']
    for (let round = 0; round < 60; round++) {
      const boundary = `bound${random(1000)}`
      const parts: Part[] = []
      for (let index = random(5) + 1; index > 0; index--) {
        const size = random(40)
        const content = Array.from({ length: size }, () => alphabet[random(alphabet.length)]).join('')
        const value = random(5) === 0 ? `${content}\r\n--${boundary.slice(0, random(boundary.length))}` : content
        parts.push(
          random(2) === 0
            ? { name: `field${random(3)}`, value: value.replaceAll('\u0000', '') }
            : { name: `file${random(3)}`, value, filename: `f${random(100)}.bin`, type: 'application/x-test' },
        )
      }
      const data = body(boundary, parts)
      const contentType = `multipart/form-data; boundary=${boundary}`
      const reference = await new Response(data, { headers: { 'content-type': contentType } }).formData()
      const ours = toFormData(parseMultipart(data, contentType, OPEN))
      const flatten = async (form: unknown) => {
        const entries: [string, unknown][] = []
        for (const [name, value] of form as Iterable<[string, string | File]>) {
          entries.push([
            name,
            typeof value === 'string'
              ? value
              : { name: value.name, text: [...new Uint8Array(await value.arrayBuffer())] },
          ])
        }
        return entries
      }
      expect(await flatten(ours)).toEqual(await flatten(reference))
    }
  })
})

describe('part headers', () => {
  const part = (headers: string, value = 'v') =>
    parse(
      bytes(`--b\r\n${headers}\r\n\r\n${value}\r\n--b--`),
      'b',
      policy([rule({ field: undefined, maxFiles: 9, multiple: true })]),
    )

  it('reads names case-insensitively, ignores other headers and supports folding', () => {
    const result = part(
      'X-Other: 1\r\ncontent-disposition: form-data;\r\n name="folded";\r\n\tfilename="f.txt"\r\nCONTENT-TYPE: Text/Plain; charset=UTF-8',
    )
    const file = (result.files['folded'] as File[])[0] as File
    expect(file.name).toBe('f.txt')
    expect(file.type).toBe('text/plain; charset=utf-8')
  })

  it('decodes quoted strings and percent-encoded quotes (HTML form encoding)', () => {
    expect(part('Content-Disposition: form-data; name="a\\"b\\\\c"').fields['a"b\\c']).toBe('v')
    expect(part('Content-Disposition: form-data; name="a%22b%0D%0Ac"').fields['a"b\r\nc']).toBe('v')
    expect(part('Content-Disposition: form-data; name=unquoted').fields['unquoted']).toBe('v')
    expect(part('Content-Disposition: form-data ; name = "spaced" ; ; ').fields['spaced']).toBe('v')
    expect(part('Content-Disposition: form-data; name="first"; name="second"').fields['first']).toBe('v')
    expect(part('Content-Disposition: form-data; name="C:\\\\path"').fields['C:\\path']).toBe('v')
  })

  it('reads UTF-8 filenames and prefers a valid RFC 5987 filename*', () => {
    const name = (headers: string): string | undefined => part(headers).list[0]?.name
    expect(name('Content-Disposition: form-data; name="f"; filename="résumé.pdf"')).toBe('résumé.pdf')
    expect(
      name(`Content-Disposition: form-data; name="f"; filename="plain.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`),
    ).toBe('résumé.pdf')
    expect(name(`Content-Disposition: form-data; name="f"; filename*=iso-8859-1'fr'caf%E9.txt`)).toBe('café.txt')
    // invalid or unsupported extended values fall back to `filename`
    expect(name(`Content-Disposition: form-data; name="f"; filename="ok.txt"; filename*=UTF-8''%E0%A4%A`)).toBe(
      'ok.txt',
    )
    expect(name(`Content-Disposition: form-data; name="f"; filename="ok.txt"; filename*=koi8-r''x`)).toBe('ok.txt')
    expect(name('Content-Disposition: form-data; name="f"; filename="a%22b.txt"')).toBe('a"b.txt')
  })

  it('lower-cases file types identically on every runtime and defaults to application/octet-stream', () => {
    expect(
      part('Content-Disposition: form-data; name="f"; filename="a"\r\nContent-Type: IMAGE/PNG').list[0]?.type,
    ).toBe('image/png')
    expect(
      part('Content-Disposition: form-data; name="f"; filename="a"\r\nContent-Type: text/plain').list[0]?.type,
    ).toBe('text/plain')
    expect(part('Content-Disposition: form-data; name="f"; filename="a"').list[0]?.type).toBe(
      'application/octet-stream',
    )
  })

  it.each([
    ['no Content-Disposition', 'Content-Type: text/plain', 'a part has no Content-Disposition header'],
    ['another disposition', 'Content-Disposition: attachment; name="a"', 'a part is not "form-data"'],
    ['no name', 'Content-Disposition: form-data; filename="a"', 'a part has no name'],
    ['header without colon', 'Content-Disposition form-data', 'invalid part header'],
    [
      'unterminated quoted string',
      'Content-Disposition: form-data; name="a',
      'unterminated quoted string in a part header',
    ],
    [
      'text after a quoted string',
      'Content-Disposition: form-data; name="a"b',
      'invalid quoted string in a part header',
    ],
    ['parameter without value', 'Content-Disposition: form-data; name', 'invalid parameter in "form-data; name"'],
  ])('rejects invalid headers: %s', async (_name, headers, reason) => {
    const error = await caught(() => part(headers))
    expect(error).toBeInstanceOf(BadRequestException)
    expect((error as Error).message).toBe(`Invalid multipart body: ${reason}`)
  })

  it('rejects headers larger than 16 KiB, even when they arrive in small chunks', async () => {
    const data = bytes(`--b\r\nContent-Disposition: form-data; name="${'x'.repeat(17 * 1024)}"\r\n\r\nv\r\n--b--`)
    const chunks: Uint8Array[] = []
    for (let offset = 0; offset < data.byteLength; offset += 100) chunks.push(data.subarray(offset, offset + 100))
    const error = await caught(() => parseChunks(chunks))
    expect((error as Error).message).toBe('Invalid multipart body: the headers of a part are too large')
  })

  it('parses Content-Type / Content-Disposition parameters', () => {
    expect(parseParameters('Form-Data; Name="x"; FILENAME=y')).toEqual({
      type: 'form-data',
      params: new Map([
        ['name', 'x'],
        ['filename', 'y'],
      ]),
    })
  })
})

describe('boundary', () => {
  it('reads the boundary of the content type (quoted or not)', () => {
    expect(multipartBoundary('multipart/form-data; boundary=abc')).toBe('abc')
    expect(multipartBoundary('multipart/form-data; charset=utf-8; boundary="a b:c"')).toBe('a b:c')
  })

  it.each([
    ['multipart/form-data', 'missing boundary in the content type'],
    ['multipart/form-data; boundary=', 'missing boundary in the content type'],
    ['multipart/form-data; boundary="unterminated', 'missing boundary in the content type'],
    [`multipart/form-data; boundary=${'x'.repeat(71)}`, 'invalid boundary in the content type'],
    ['multipart/form-data; boundary="a\u0001b"', 'invalid boundary in the content type'],
    ['multipart/form-data; boundary="é"', 'invalid boundary in the content type'],
  ])('rejects %s', async (contentType, reason) => {
    const error = await caught(() => multipartBoundary(contentType))
    expect(error).toBeInstanceOf(BadRequestException)
    expect((error as Error).message).toBe(`Invalid multipart body: ${reason}`)
  })
})

describe('limits and upload rules', () => {
  it('limits the size of text fields (413)', async () => {
    const error = await caught(() =>
      parse(body('b', [{ name: 'note', value: 'x'.repeat(11) }]), 'b', policy([], { maxFieldSize: 10 })),
    )
    expect(error).toBeInstanceOf(PayloadTooLargeException)
    expect((error as HttpException).message).toBe('Field "note" exceeds the maximum size of 10 bytes')
    expect((error as HttpException).details).toEqual({ field: 'note', maxSize: 10 })
    expect((error as HttpException).headers).toEqual({ connection: 'close' })
    expect(
      parse(body('b', [{ name: 'note', value: 'x'.repeat(10) }]), 'b', policy([], { maxFieldSize: 10 })),
    ).toBeDefined()
  })

  it('limits the number of parts (413)', async () => {
    const parts = Array.from({ length: 4 }, (_, index) => ({ name: `f${index}`, value: 'v' }))
    const error = await caught(() => parse(body('b', parts), 'b', policy([], { maxParts: 3 })))
    expect(error).toBeInstanceOf(PayloadTooLargeException)
    expect((error as Error).message).toBe('Too many parts in the multipart body (at most 3)')
  })

  it('limits the size of files (413), per rule', async () => {
    const data = body('b', [{ name: 'file', value: 'x'.repeat(1025), filename: 'big.bin' }])
    const error = await caught(() => parse(data, 'b', policy([rule({ maxSize: 1024 })])))
    expect(error).toBeInstanceOf(PayloadTooLargeException)
    expect((error as Error).message).toBe('File in field "file" exceeds the maximum size of 1 KiB')
    expect((error as HttpException).details).toEqual({ field: 'file', maxSize: 1024 })
    expect(parse(data, 'b', policy([rule({ maxSize: 1025 })])).list).toHaveLength(1)
  })

  it('rejects a second file for a single-file field (400) and too many files (413)', async () => {
    const two = body('b', [
      { name: 'file', value: '1', filename: '1.txt' },
      { name: 'file', value: '2', filename: '2.txt' },
    ])
    const single = await caught(() => parse(two, 'b', policy([rule()])))
    expect(single).toBeInstanceOf(BadRequestException)
    expect((single as Error).message).toBe('Expected a single file in field "file"')
    expect((single as HttpException).details).toEqual([{ path: 'file', message: 'Expected a single file' }])
    const many = await caught(() => parse(two, 'b', policy([rule({ multiple: true, maxFiles: 1 })])))
    expect(many).toBeInstanceOf(PayloadTooLargeException)
    expect((many as Error).message).toBe('Too many files in field "file" (at most 1)')
    expect(parse(two, 'b', policy([rule({ multiple: true, maxFiles: 2 })])).files['file']).toHaveLength(2)
    const anyField = await caught(() =>
      parse(two, 'b', policy([rule({ field: undefined, multiple: true, maxFiles: 1 })])),
    )
    expect((anyField as Error).message).toBe('Too many files (at most 1)')
  })

  it('rejects files of undeclared fields (400) but accepts text fields anywhere', async () => {
    const data = body('b', [
      { name: 'title', value: 'kept' },
      { name: 'other', value: 'x', filename: 'x.txt' },
    ])
    const error = await caught(() => parse(data, 'b', policy([rule()])))
    expect(error).toBeInstanceOf(BadRequestException)
    expect((error as Error).message).toBe('Unexpected file field "other"')
    // 400 details: the issues of a validation error (ValidationErrorBody of @znight/openapi)
    expect((error as HttpException).details).toEqual([
      { path: 'other', message: 'Unexpected file field (expected file)' },
    ])
    expect(parse(data, 'b', policy([rule({ field: undefined })])).files['other']).toHaveLength(1)
  })

  it('filters media types with wildcards (415), on the declared type without parameters', async () => {
    const image = (type: string) => body('b', [{ name: 'file', value: 'x', filename: 'x', type }])
    const accepting = policy([rule({ mimeTypes: ['image/*', 'application/pdf'] })])
    expect(parse(image('image/png'), 'b', accepting).list).toHaveLength(1)
    expect(parse(image('IMAGE/JPEG; q=1'), 'b', accepting).list).toHaveLength(1)
    expect(parse(image('application/pdf'), 'b', accepting).list).toHaveLength(1)
    const error = await caught(() => parse(image('text/plain; charset=utf-8'), 'b', accepting))
    expect(error).toBeInstanceOf(UnsupportedMediaTypeException)
    expect((error as Error).message).toBe(
      'Unsupported file type "text/plain" in field "file" (accepted: image/*, application/pdf)',
    )
    expect((error as HttpException).details).toEqual({
      field: 'file',
      type: 'text/plain',
      accepted: ['image/*', 'application/pdf'],
    })
    // no declared type: application/octet-stream
    const untyped = await caught(() => parse(body('b', [{ name: 'file', value: 'x', filename: 'x' }]), 'b', accepting))
    expect(untyped).toBeInstanceOf(UnsupportedMediaTypeException)
  })

  it('applies every matching rule (named and any-field)', async () => {
    const data = body('b', [{ name: 'file', value: 'x'.repeat(20), filename: 'x' }])
    const rules = [rule({ maxSize: 100 }), rule({ field: undefined, multiple: true, maxFiles: 5, maxSize: 10 })]
    expect(await caught(() => parse(data, 'b', policy(rules)))).toBeInstanceOf(PayloadTooLargeException)
  })

  it('rejects an oversized file while reading and cancels the source', async () => {
    let cancelled: unknown
    const head = bytes('--b\r\nContent-Disposition: form-data; name="file"; filename="x"\r\n\r\n')
    const chunks = [head, ...Array.from({ length: 1000 }, () => new Uint8Array(100))]
    let read = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[read++]
        if (chunk === undefined) controller.close()
        else controller.enqueue(chunk)
      },
      cancel(reason) {
        cancelled = reason
      },
    })
    const error = await caught(() =>
      readMultipart(stream, 'multipart/form-data; boundary=b', policy([rule({ maxSize: 250 })])),
    )
    expect(error).toBeInstanceOf(PayloadTooLargeException)
    expect(cancelled).toBe(error)
    expect(read).toBeLessThan(10)
  })

  it('fails when the stream fails', async () => {
    const failure = new Error('connection reset')
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes('--b\r\n'))
        controller.error(failure)
      },
    })
    expect(await caught(() => readMultipart(stream, 'multipart/form-data; boundary=b', OPEN))).toBe(failure)
  })
})

describe('MultipartParser', () => {
  it('reports parts to its handler and ignores writes after the closing delimiter', () => {
    const events: string[] = []
    const parser = new MultipartParser('b', {
      start: info => {
        events.push(`start ${info.name} ${info.filename ?? '-'} ${info.contentType ?? '-'}`)
        return { data: chunk => events.push(`data ${new TextDecoder().decode(chunk)}`), end: () => events.push('end') }
      },
    })
    parser.write(bytes('--b\r\nContent-Disposition: form-data; name="a"\r\n\r\nvalue\r\n--b--'))
    expect(parser.done).toBe(true)
    parser.write(bytes('--b\r\nignored'))
    parser.end()
    expect(events).toEqual(['start a - -', 'data value', 'end'])
  })

  it('converts a result to a FormData (body order)', () => {
    const form = toFormData(parse(SAMPLE, 'XyZ'))
    expect([...(form as unknown as Iterable<[string, unknown]>)].map(([name]) => name)).toEqual([
      'title',
      'file',
      'tags',
      'tags',
      'binary',
    ])
  })
})

describe('streams of the body', () => {
  it('reads a stream of many small chunks', async () => {
    const chunks = [...SAMPLE].map(byte => new Uint8Array([byte]))
    expect(await summary(await parseChunks(chunks, 'XyZ'))).toEqual(await summary(parse(SAMPLE, 'XyZ')))
  })

  it('keeps file content identical for large binary files', async () => {
    const content = new Uint8Array(300_000).map((_, index) => (index * 7919) % 256)
    const data = body('----edge', [{ name: 'f', value: content, filename: 'big.bin' }])
    const chunks: Uint8Array[] = []
    for (let offset = 0; offset < data.byteLength; offset += 65_536) chunks.push(data.subarray(offset, offset + 65_536))
    const file = (await parseChunks(chunks, '----edge')).list[0] as File
    expect(file.size).toBe(content.byteLength)
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(content)
  })

  it('errors when the boundary never shows up', async () => {
    expect(await caught(() => parseChunks([bytes('x'.repeat(1000))]))).toBeInstanceOf(BadRequestException)
  })

  it('cancels the source with the error', async () => {
    let reason: unknown
    const stream = streamOf([bytes('--b\r\nbad header\r\n\r\n')], cancel => {
      reason = cancel
    })
    const error = await caught(() => readMultipart(stream, 'multipart/form-data; boundary=b', OPEN))
    expect(reason).toBe(error)
  })
})
