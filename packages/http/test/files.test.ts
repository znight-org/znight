/**
 * Download primitives: media types, byte sizes, `Range` parsing, `Content-Disposition`, file
 * resolution (preconditions, ranges, `root` confinement) and the stream helpers.
 */
import type { FileRequest, LazyFile, LazyFileContent, ResolvedFile } from '../src/files.ts'
import type { FilesDir } from './files-app.ts'

import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'

import { FileBody, isFileBody, resolveFile } from '../src/files.ts'
import {
  contentDisposition,
  contentTypeFor,
  formatByteSize,
  HttpException,
  HttpResponse,
  matchesMediaType,
  NotFoundException,
  parseByteSize,
  parseRange,
} from '../src/index.ts'
import { isMediaTypePattern, mediaTypeEssence } from '../src/mime.ts'
import { serializeResult } from '../src/serialize.ts'
import { captureContext, discardStream, failedStream, toByteStream, trackStream } from '../src/stream.ts'
import { createFilesDir } from './files-app.ts'
import { caught, sleep } from './helpers.ts'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

const DECODER = new TextDecoder()

describe('media types', () => {
  it('looks up types from extensions (case-insensitive, text with charset)', () => {
    expect(contentTypeFor('report.PDF')).toBe('application/pdf')
    // extensions named like Object.prototype members are unknown, not `Object` / `Object.prototype`
    for (const name of ['a.constructor', 'data.__proto__', 'x.toString', 'x.hasownproperty', 'x.valueOf']) {
      expect({ name, type: contentTypeFor(name) }).toEqual({ name, type: undefined })
    }
    expect(contentTypeFor('notes.txt')).toBe('text/plain; charset=utf-8')
    expect(contentTypeFor('/a/b/data.json')).toBe('application/json; charset=utf-8')
    expect(contentTypeFor('C:\\dir\\photo.jpeg')).toBe('image/jpeg')
    expect(contentTypeFor('archive.tar.gz')).toBe('application/gzip')
    expect(contentTypeFor('icon.svg')).toBe('image/svg+xml; charset=utf-8')
    expect(contentTypeFor('noext')).toBeUndefined()
    expect(contentTypeFor('trailing.')).toBeUndefined()
    expect(contentTypeFor('dir.d/file')).toBeUndefined()
    expect(contentTypeFor('file.unknown')).toBeUndefined()
    expect(contentTypeFor('.bashrc')).toBeUndefined()
  })

  it('validates and matches media type patterns', () => {
    for (const pattern of ['image/png', 'image/*', '*/*', 'application/vnd.ms-excel', 'TEXT/Plain']) {
      expect(isMediaTypePattern(pattern)).toBe(true)
    }
    for (const pattern of ['image', '*/png', 'image/png*', 'image/png; q=1', '', 'a/b/c', 'ima ge/png']) {
      expect(isMediaTypePattern(pattern)).toBe(false)
    }
    expect(mediaTypeEssence(' Text/Plain ; charset=x')).toBe('text/plain')
    expect(matchesMediaType('image/png', ['image/*'])).toBe(true)
    expect(matchesMediaType('IMAGE/PNG; x=1', ['image/png'])).toBe(true)
    expect(matchesMediaType('text/plain', ['image/*', 'application/pdf'])).toBe(false)
    expect(matchesMediaType('anything/at-all', ['*/*'])).toBe(true)
    expect(matchesMediaType('invalid', ['*/*'])).toBe(false)
    expect(matchesMediaType('image/', ['image/*'])).toBe(false)
    // a single type only: browsers render the last type of a list
    expect(matchesMediaType('image/png, text/html', ['image/*'])).toBe(false)
    expect(matchesMediaType('image/png; x=1, text/html', ['image/*'])).toBe(false)
    expect(matchesMediaType('image/p ng', ['image/*'])).toBe(false)
    expect(matchesMediaType('image/png; x="a", text/html', ['image/*'])).toBe(false)
    // a comma inside a quoted parameter value is legal (RFC 2046 boundaries, file names)
    expect(matchesMediaType('multipart/form-data; boundary="----a,b"', ['multipart/form-data'])).toBe(true)
    expect(matchesMediaType('text/plain; name="a,b"', ['text/*'])).toBe(true)
    expect(matchesMediaType('text/plain; name="a\\",b"', ['text/*'])).toBe(true)
    expect(matchesMediaType('text/plain; name="a\\"", b/c', ['text/*'])).toBe(false)
  })
})

describe('byte sizes', () => {
  it('parses numbers and sizes with units (binary)', () => {
    expect(parseByteSize(0)).toBe(0)
    expect(parseByteSize(1024)).toBe(1024)
    expect(parseByteSize(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY)
    expect(parseByteSize('512')).toBe(512)
    expect(parseByteSize('10b')).toBe(10)
    expect(parseByteSize('1kb')).toBe(1024)
    expect(parseByteSize('1.5 KiB')).toBe(1536)
    expect(parseByteSize('10MB')).toBe(10 * 1024 * 1024)
    expect(parseByteSize('2g')).toBe(2 * 1024 ** 3)
    expect(parseByteSize('1tb')).toBe(1024 ** 4)
    expect(parseByteSize(' .5k ')).toBe(512)
  })

  it('rejects invalid sizes', () => {
    for (const value of [
      -1,
      1.5,
      Number.NaN,
      Number.NEGATIVE_INFINITY,
      '-1kb',
      '1xb',
      'mb',
      '',
      '1e3',
      'Infinity',
      null,
      {},
    ]) {
      expect(parseByteSize(value)).toBeUndefined()
    }
    expect(parseByteSize('99999999tb')).toBeUndefined()
  })

  it('formats sizes for messages', () => {
    expect(formatByteSize(1)).toBe('1 byte')
    expect(formatByteSize(512)).toBe('512 bytes')
    expect(formatByteSize(1024)).toBe('1 KiB')
    expect(formatByteSize(1536)).toBe('1.5 KiB')
    expect(formatByteSize(5 * 1024 * 1024)).toBe('5 MiB')
    expect(formatByteSize(Number.POSITIVE_INFINITY)).toBe('unlimited')
  })
})

describe('Range header', () => {
  it.each([
    ['bytes=0-99', { start: 0, end: 99 }],
    ['bytes=10-', { start: 10, end: 299 }],
    ['bytes=-50', { start: 250, end: 299 }],
    ['bytes=-500', { start: 0, end: 299 }],
    ['bytes=290-1000', { start: 290, end: 299 }],
    ['Bytes = 5 - 6 ', { start: 5, end: 6 }],
  ])('parses %s', (header, expected) => {
    expect(parseRange(header, 300)).toEqual(expected)
  })

  it.each([
    'items=0-1',
    'bytes=0-1,5-6',
    'bytes=5-1',
    'bytes=-',
    'bytes=a-b',
    'bytes 0-1',
    'bytes=99999999999999999999-',
  ])('ignores %s (the whole representation is sent)', header => {
    expect(parseRange(header, 300)).toBeUndefined()
  })

  it.each([`bytes=${' '.repeat(16_000)}x`, `bytes=-${' '.repeat(16_000)}x`, `bytes=0${' '.repeat(16_000)}x-1`])(
    'parses a long malformed header in linear time',
    header => {
      const started = performance.now()
      expect(parseRange(header, 100)).toBeUndefined()
      expect(performance.now() - started).toBeLessThan(20)
    },
  )

  it('reports unsatisfiable ranges', () => {
    expect(parseRange('bytes=300-', 300)).toBe('unsatisfiable')
    expect(parseRange('bytes=-0', 300)).toBe('unsatisfiable')
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable')
    expect(parseRange('bytes=-1', 0)).toBe('unsatisfiable')
    expect(parseRange('bytes=400-500', 300)).toBe('unsatisfiable')
  })
})

describe('Content-Disposition', () => {
  it('quotes ASCII names and adds an RFC 5987 filename* for the others', () => {
    expect(contentDisposition()).toBe('attachment')
    expect(contentDisposition(undefined, 'inline')).toBe('inline')
    expect(contentDisposition('report.pdf')).toBe('attachment; filename="report.pdf"')
    expect(contentDisposition('report.pdf', 'inline')).toBe('inline; filename="report.pdf"')
    expect(contentDisposition('say "hi".txt')).toBe('attachment; filename="say \\"hi\\".txt"')
    expect(contentDisposition('résumé été.pdf')).toBe(
      `attachment; filename="r_sum_ _t_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%C3%A9t%C3%A9.pdf`,
    )
    expect(contentDisposition('100%.txt')).toBe(`attachment; filename="100_.txt"; filename*=UTF-8''100%25.txt`)
    expect(contentDisposition("it's (1)*.txt")).toBe(`attachment; filename="it's (1)*.txt"`)
    expect(contentDisposition('日本.txt')).toBe(
      `attachment; filename="__.txt"; filename*=UTF-8''%E6%97%A5%E6%9C%AC.txt`,
    )
  })

  it('removes directories and control characters', () => {
    expect(contentDisposition('../../etc/passwd')).toBe('attachment; filename="passwd"')
    expect(contentDisposition('C:\\Users\\x\\a.txt')).toBe('attachment; filename="a.txt"')
    expect(contentDisposition('a\r\nb\u0000.txt')).toBe('attachment; filename="ab.txt"')
    expect(contentDisposition('dir/')).toBe('attachment')
  })

  it('round-trips through a decoder', () => {
    const name = "rapport été 'final' (v2)*.pdf"
    const header = contentDisposition(name)
    const encoded = /filename\*=UTF-8''(.+)$/.exec(header)?.[1] ?? ''
    expect(decodeURIComponent(encoded)).toBe(name)
    expect(encoded).not.toMatch(/['()* ]/)
  })

  it('rejects unknown dispositions', async () => {
    expect(await caught(() => contentDisposition('a', 'download' as never))).toBeInstanceOf(TypeError)
  })
})

describe('resolveFile', () => {
  let dir: FilesDir
  const get = (headers: Record<string, string> = {}): FileRequest => ({ method: 'GET', headers })
  const text = async (resolved: ResolvedFile): Promise<string> =>
    resolved.body === null ? '' : DECODER.decode(new Uint8Array(await new Response(resolved.body).arrayBuffer()))

  beforeAll(() => {
    dir = createFilesDir()
  })
  afterAll(() => dir.cleanup())

  it('serves a file with its metadata', async () => {
    const resolved = await resolveFile(new FileBody(dir.sample), get())
    expect(resolved.status).toBe(200)
    expect({ ...resolved.headers }).toEqual({
      'content-type': 'text/plain; charset=utf-8',
      'accept-ranges': 'bytes',
      etag: `"${(Date.parse('2024-05-06T07:08:09Z')).toString(16)}-12c"`,
      'last-modified': 'Mon, 06 May 2024 07:08:09 GMT',
      'content-length': '300',
    })
    expect(await text(resolved)).toBe('0123456789'.repeat(30))
  })

  it('accepts file: URLs and options', async () => {
    const resolved = await resolveFile(
      new FileBody(pathToFileURL(dir.sample), { filename: 'données.csv', contentType: 'text/x-mine' }),
      get(),
    )
    expect(resolved.headers['content-type']).toBe('text/x-mine')
    expect(resolved.headers['content-disposition']).toBe(
      `attachment; filename="donn_es.csv"; filename*=UTF-8''donn%C3%A9es.csv`,
    )
    const inline = await resolveFile(new FileBody(dir.sample, { disposition: 'inline' }), get())
    expect(inline.headers['content-disposition']).toBe('inline; filename="sample.txt"')
    expect((await resolveFile(new FileBody(dir.sample, { filename: 'x.pdf' }), get())).headers['content-type']).toBe(
      'application/pdf',
    )
  })

  it('answers 304 for matching If-None-Match / If-Modified-Since (GET and HEAD)', async () => {
    const first = await resolveFile(new FileBody(dir.sample), get())
    const etag = first.headers['etag'] as string
    const notModified: Record<string, string>[] = [
      { 'if-none-match': etag },
      { 'if-none-match': `"other", W/${etag}` },
      { 'if-none-match': '*' },
      { 'if-modified-since': 'Mon, 06 May 2024 07:08:09 GMT' },
      { 'if-modified-since': 'Tue, 07 May 2024 00:00:00 GMT' },
    ]
    for (const headers of notModified) {
      const resolved = await resolveFile(new FileBody(dir.sample), get(headers))
      expect(resolved.status).toBe(304)
      expect(resolved.body).toBeNull()
      expect({ ...resolved.headers }).toEqual({ etag, 'last-modified': 'Mon, 06 May 2024 07:08:09 GMT' })
    }
    const head = await resolveFile(new FileBody(dir.sample), { method: 'HEAD', headers: { 'if-none-match': etag } })
    expect(head.status).toBe(304)
    const fresh: Record<string, string>[] = [
      { 'if-none-match': '"other"' },
      { 'if-modified-since': 'Sun, 05 May 2024 00:00:00 GMT' },
      { 'if-modified-since': 'not a date' },
      // If-None-Match wins over If-Modified-Since
      { 'if-none-match': '"other"', 'if-modified-since': 'Tue, 07 May 2024 00:00:00 GMT' },
    ]
    for (const headers of fresh) {
      const resolved = await resolveFile(new FileBody(dir.sample), get(headers))
      expect(resolved.status).toBe(200)
    }
  })

  it('answers 412 for failed If-Match / If-Unmodified-Since', async () => {
    const failing: Record<string, string>[] = [
      { 'if-match': '"other"' },
      { 'if-unmodified-since': 'Sun, 05 May 2024 00:00:00 GMT' },
    ]
    for (const headers of failing) {
      const error = await caught(() => resolveFile(new FileBody(dir.sample), get(headers)))
      expect(error).toBeInstanceOf(HttpException)
      expect((error as HttpException).status).toBe(412)
    }
    const ok = await resolveFile(new FileBody(dir.sample), get({ 'if-match': '*' }))
    expect(ok.status).toBe(200)
    // If-None-Match on an unsafe method
    const put = await caught(() =>
      resolveFile(new FileBody(dir.sample), { method: 'PUT', headers: { 'if-none-match': '*' } }),
    )
    expect((put as HttpException).status).toBe(412)
  })

  it('serves single byte ranges (206) and rejects unsatisfiable ones (416)', async () => {
    const partial = await resolveFile(new FileBody(dir.sample), get({ range: 'bytes=10-19' }))
    expect(partial.status).toBe(206)
    expect(partial.headers['content-range']).toBe('bytes 10-19/300')
    expect(partial.headers['content-length']).toBe('10')
    expect(await text(partial)).toBe('0123456789')
    const suffix = await resolveFile(new FileBody(dir.sample), get({ range: 'bytes=-3' }))
    expect(await text(suffix)).toBe('789')
    const error = await caught(() => resolveFile(new FileBody(dir.sample), get({ range: 'bytes=300-' })))
    expect((error as HttpException).status).toBe(416)
    expect((error as HttpException).headers).toEqual({ 'content-range': 'bytes */300', 'accept-ranges': 'bytes' })
    // several ranges: the whole file
    const several = await resolveFile(new FileBody(dir.sample), get({ range: 'bytes=0-1,4-5' }))
    expect(several.status).toBe(200)
    // HEAD ignores Range
    const head = await resolveFile(new FileBody(dir.sample), { method: 'HEAD', headers: { range: 'bytes=0-1' } })
    expect(head.status).toBe(200)
    expect(head.body).toBeNull()
    expect(head.headers['content-length']).toBe('300')
  })

  it('honours If-Range (entity tag or exact date)', async () => {
    const first = await resolveFile(new FileBody(dir.sample), get())
    const etag = first.headers['etag'] as string
    const ranged = async (ifRange: string): Promise<number> => {
      const resolved = await resolveFile(new FileBody(dir.sample), get({ range: 'bytes=0-0', 'if-range': ifRange }))
      return resolved.status
    }
    expect(await ranged(etag)).toBe(206)
    expect(await ranged('Mon, 06 May 2024 07:08:09 GMT')).toBe(206)
    expect(await ranged('"stale"')).toBe(200)
    expect(await ranged(`W/${etag}`)).toBe(200)
    expect(await ranged('Tue, 07 May 2024 00:00:00 GMT')).toBe(200)
  })

  it('serves empty files', async () => {
    const resolved = await resolveFile(new FileBody(path.join(dir.publicDir, 'empty.bin')), get())
    expect(resolved.status).toBe(200)
    expect(resolved.body).toBeNull()
    expect(resolved.headers['content-length']).toBe('0')
  })

  it('answers 404 for missing files, directories and invalid paths', async () => {
    for (const target of [
      path.join(dir.root, 'missing.txt'),
      dir.publicDir,
      '',
      'a\u0000b',
      path.join(dir.sample, 'x'),
    ]) {
      const error = await caught(() => resolveFile(new FileBody(target), get()))
      expect(error).toBeInstanceOf(NotFoundException)
      expect((error as Error).message).toBe('File not found')
    }
  })

  it('confines paths to root (.., absolute paths, symbolic links)', async () => {
    const options = { root: dir.publicDir }
    const ok = await resolveFile(new FileBody('docs/readme.md', options), get())
    expect(await text(ok)).toBe('# readme\n')
    expect(ok.headers['content-type']).toBe('text/markdown; charset=utf-8')
    for (const target of [
      '../secret.txt',
      'docs/../../secret.txt',
      path.join(dir.root, 'secret.txt'),
      'escape.txt',
      '.',
      '',
      'docs',
    ]) {
      const error = await caught(() => resolveFile(new FileBody(target, options), get()))
      expect(error).toBeInstanceOf(NotFoundException)
    }
    // an absolute path inside the root is accepted
    const absolute = await resolveFile(new FileBody(dir.sample, options), get())
    expect(absolute.status).toBe(200)
  })

  it('hides dotfiles inside root unless allowed', async () => {
    fs.mkdirSync(path.join(dir.publicDir, '.git'), { recursive: true })
    fs.writeFileSync(path.join(dir.publicDir, '.git', 'config'), '[core]')
    fs.writeFileSync(path.join(dir.publicDir, '.env'), 'SECRET=1')
    for (const target of ['.env', '.git/config', 'docs/../.env']) {
      expect(await caught(() => resolveFile(new FileBody(target, { root: dir.publicDir }), get()))).toBeInstanceOf(
        NotFoundException,
      )
    }
    const allowed = await resolveFile(new FileBody('.env', { root: dir.publicDir, dotfiles: 'allow' }), get())
    expect(await text(allowed)).toBe('SECRET=1')
    // a name starting with two dots is not a parent directory
    fs.writeFileSync(path.join(dir.publicDir, '..dots'), 'dots')
    const dots = await resolveFile(new FileBody('..dots', { root: dir.publicDir, dotfiles: 'allow' }), get())
    expect(await text(dots)).toBe('dots')
    // without root the path is the application's choice
    expect((await resolveFile(new FileBody(path.join(dir.publicDir, '.env')), get())).status).toBe(200)
    // a dot directory above the root is fine
    const hidden = path.join(dir.root, '.hidden')
    fs.mkdirSync(hidden, { recursive: true })
    fs.writeFileSync(path.join(hidden, 'a.txt'), 'a')
    expect((await resolveFile(new FileBody('a.txt', { root: hidden }), get())).status).toBe(200)
  })

  it('sends file-backed blobs, read lazily, without keeping files open', async () => {
    const before = fs.readdirSync('/dev/fd').length
    const unread = []
    for (let index = 0; index < 20; index++) {
      const resolved = await resolveFile(new FileBody(dir.sample), get())
      expect(resolved.body).toBeInstanceOf(Blob)
      expect((resolved.body as Blob).size).toBe(300)
      if (index % 2 === 0) unread.push(resolved)
      else await text(resolved)
    }
    expect(fs.readdirSync('/dev/fd').length).toBeLessThanOrEqual(before + 1)
    expect(unread).toHaveLength(10)
  })

  it('serves Blob and File objects (ranges, type, name, validators)', async () => {
    const file = new File(['hello world'], 'greeting.txt', { type: 'text/plain', lastModified: 1_700_000_000_000 })
    const resolved = await resolveFile(new FileBody(file, { disposition: 'attachment' }), get({ range: 'bytes=6-' }))
    expect(resolved.status).toBe(206)
    expect(resolved.headers['content-type']).toBe(file.type)
    expect(resolved.headers['content-disposition']).toBe('attachment; filename="greeting.txt"')
    expect(resolved.headers['last-modified']).toBe('Tue, 14 Nov 2023 22:13:20 GMT')
    expect(await text(resolved)).toBe('world')
    const blob = await resolveFile(new FileBody(new Blob([new Uint8Array([1, 2, 3])])), get())
    expect(blob.headers['content-type']).toBe('application/octet-stream')
    expect(blob.headers['etag']).toBeUndefined()
    expect(blob.headers['content-length']).toBe('3')
  })

  it('validates its arguments', async () => {
    expect(await caught(() => new FileBody(42 as never))).toBeInstanceOf(TypeError)
    expect(await caught(() => new FileBody(new URL('https://example.com/a.txt')))).toBeInstanceOf(TypeError)
    expect(await caught(() => new FileBody('a', { disposition: 'save' as never }))).toBeInstanceOf(TypeError)
    expect(await caught(() => new FileBody('a', { dotfiles: 'ignore' as never }))).toBeInstanceOf(TypeError)
    expect(isFileBody(HttpResponse.file('a').body)).toBe(true)
    expect(isFileBody({ source: 'a' })).toBe(false)
  })
})

describe('lazy files', () => {
  const CONTENT = '0123456789'.repeat(30)
  const BYTES = new TextEncoder().encode(CONTENT)
  const MODIFIED = Date.parse('2024-05-06T07:08:09Z')
  const LAST_MODIFIED = 'Mon, 06 May 2024 07:08:09 GMT'
  const get = (headers: Record<string, string> = {}): FileRequest => ({ method: 'GET', headers })
  const head = (headers: Record<string, string> = {}): FileRequest => ({ method: 'HEAD', headers })
  const text = async (resolved: ResolvedFile): Promise<string> =>
    resolved.body === null ? '' : DECODER.decode(new Uint8Array(await new Response(resolved.body).arrayBuffer()))

  /** A Web stream of `bytes` in chunks of `size` bytes, recording its reads and its cancellation. */
  function chunked(bytes: Uint8Array, size: number, state = { cancelled: false, pulled: 0 }) {
    let offset = 0
    return new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          state.pulled++
          if (offset >= bytes.byteLength) {
            controller.close()
            return
          }
          controller.enqueue(bytes.slice(offset, offset + size))
          offset += size
        },
        cancel() {
          state.cancelled = true
        },
      },
      { highWaterMark: 0 },
    )
  }

  /** A lazy file of the sample content counting its loads. */
  function lazy(content: () => LazyFileContent | Promise<LazyFileContent> = () => BYTES, extra: object = {}) {
    const calls = { loads: 0 }
    const file = {
      size: BYTES.byteLength,
      etag: '"v1"',
      lastModified: new Date(MODIFIED),
      type: 'text/plain; charset=utf-8',
      ...extra,
      load: () => {
        calls.loads++
        return content()
      },
    } as LazyFile
    return { body: new FileBody(file), calls }
  }

  it('answers 304 and 412 without loading the content', async () => {
    const notModified: FileRequest[] = [
      get({ 'if-none-match': '"v1"' }),
      get({ 'if-none-match': '"other", W/"v1"' }),
      get({ 'if-none-match': '*' }),
      get({ 'if-modified-since': LAST_MODIFIED }),
      head({ 'if-none-match': '"v1"' }),
      get({ 'if-none-match': '"v1"', range: 'bytes=0-4' }),
    ]
    for (const request of notModified) {
      const { body, calls } = lazy()
      const resolved = await resolveFile(body, request)
      expect(resolved.status).toBe(304)
      expect(resolved.body).toBeNull()
      expect({ ...resolved.headers }).toEqual({ etag: '"v1"', 'last-modified': LAST_MODIFIED })
      expect(calls.loads).toBe(0)
    }
    const failing: FileRequest[] = [
      get({ 'if-match': '"other"' }),
      get({ 'if-unmodified-since': 'Sun, 05 May 2024 00:00:00 GMT' }),
      { method: 'PUT', headers: { 'if-none-match': '*' } },
    ]
    for (const request of failing) {
      const { body, calls } = lazy()
      const error = await caught(() => resolveFile(body, request))
      expect((error as HttpException).status).toBe(412)
      expect(calls.loads).toBe(0)
    }
  })

  it('answers HEAD, unsatisfiable ranges and empty files without loading the content', async () => {
    const plain = lazy()
    const resolved = await resolveFile(plain.body, head())
    expect(resolved.status).toBe(200)
    expect(resolved.body).toBeNull()
    expect({ ...resolved.headers }).toEqual({
      'content-type': 'text/plain; charset=utf-8',
      'accept-ranges': 'bytes',
      etag: '"v1"',
      'last-modified': LAST_MODIFIED,
      'content-length': '300',
    })
    const unsatisfiable = lazy()
    const error = await caught(() => resolveFile(unsatisfiable.body, get({ range: 'bytes=300-' })))
    expect((error as HttpException).status).toBe(416)
    const empty = lazy(() => new Uint8Array(0), { size: 0 })
    const nothing = await resolveFile(empty.body, get())
    expect(nothing.status).toBe(200)
    expect(nothing.body).toBeNull()
    expect(nothing.headers['content-length']).toBe('0')
    expect(plain.calls.loads + unsatisfiable.calls.loads + empty.calls.loads).toBe(0)
  })

  it('loads the content once for 200 and 206 (bytes, Blob, streams, Node.js readables, async iterables)', async () => {
    const sources: Record<string, () => LazyFileContent> = {
      bytes: () => BYTES,
      buffer: () => BYTES.slice().buffer,
      blob: () => new Blob([BYTES]),
      'web stream': () => chunked(BYTES, 7),
      'node readable': () => Readable.from([BYTES.slice(0, 100), BYTES.slice(100)]),
      'async iterable': () =>
        (async function* () {
          for (let offset = 0; offset < BYTES.byteLength; offset += 11) {
            yield await Promise.resolve(BYTES.slice(offset, offset + 11))
          }
        })(),
    }
    for (const [kind, source] of Object.entries(sources)) {
      for (const [range, status, expected] of [
        [undefined, 200, CONTENT],
        ['bytes=10-14', 206, '01234'],
        ['bytes=5-23', 206, CONTENT.slice(5, 24)],
        ['bytes=-3', 206, '789'],
        ['bytes=290-', 206, '0123456789'],
      ] as const) {
        const { body, calls } = lazy(source)
        const resolved = await resolveFile(body, get(range === undefined ? {} : { range }))
        expect({ kind, range, status: resolved.status }).toEqual({ kind, range, status })
        expect({ kind, range, text: await text(resolved) }).toEqual({ kind, range, text: expected })
        expect({ kind, range, loads: calls.loads }).toEqual({ kind, range, loads: 1 })
      }
    }
    // an asynchronous load()
    const later = lazy(async () => new Blob([BYTES]))
    expect(await text(await resolveFile(later.body, get()))).toBe(CONTENT)
    expect(later.calls.loads).toBe(1)
  })

  it('uses the entity tag as given (weak tags never match strongly)', async () => {
    const weak = { etag: 'W/"v1"' }
    expect((await resolveFile(lazy(undefined, weak).body, get({ 'if-none-match': 'W/"v1"' }))).status).toBe(304)
    expect((await resolveFile(lazy(undefined, weak).body, get({ 'if-none-match': '"v1"' }))).status).toBe(304)
    const ifMatch = lazy(undefined, weak)
    const error = await caught(() => resolveFile(ifMatch.body, get({ 'if-match': 'W/"v1"' })))
    expect((error as HttpException).status).toBe(412)
    // If-Range needs a strong match: the whole content
    const ranged = await resolveFile(lazy(undefined, weak).body, get({ range: 'bytes=0-1', 'if-range': 'W/"v1"' }))
    expect(ranged.status).toBe(200)
    const strong = await resolveFile(lazy().body, get({ range: 'bytes=0-1', 'if-range': '"v1"' }))
    expect(strong.status).toBe(206)
    expect(await text(strong)).toBe('01')
    const stale = await resolveFile(lazy().body, get({ range: 'bytes=0-1', 'if-range': '"v0"' }))
    expect(stale.status).toBe(200)
  })

  it('matches entity tags containing commas in If-None-Match / If-Match lists', async () => {
    const comma = { etag: '"3,7"' }
    for (const header of ['"3,7"', '"other", "3,7"', '"3,7" , W/"x"', 'W/"3,7"']) {
      const { body, calls } = lazy(undefined, comma)
      expect((await resolveFile(body, get({ 'if-none-match': header }))).status).toBe(304)
      expect(calls.loads).toBe(0)
    }
    for (const header of ['"3"', '"7"', '"3", "7"']) {
      expect((await resolveFile(lazy(undefined, comma).body, get({ 'if-none-match': header }))).status).toBe(200)
    }
    const matched = lazy(undefined, comma)
    const resolved = await resolveFile(matched.body, get({ 'if-match': '"a", "3,7"' }))
    expect(resolved.status).toBe(200)
    expect(await text(resolved)).toBe(CONTENT)
    expect(matched.calls.loads).toBe(1)
    const error = await caught(() => resolveFile(lazy(undefined, comma).body, get({ 'if-match': '"3", "7"' })))
    expect((error as HttpException).status).toBe(412)
    const ranged = await resolveFile(lazy(undefined, comma).body, get({ range: 'bytes=0-1', 'if-range': '"3,7"' }))
    expect(ranged.status).toBe(206)
  })

  it('loads the content for a body sent to a method other than GET and HEAD (whole content, no range)', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const { body, calls } = lazy()
      const resolved = await resolveFile(body, { method, headers: { range: 'bytes=0-1' } })
      expect(resolved.status).toBe(200)
      expect(await text(resolved)).toBe(CONTENT)
      expect(calls.loads).toBe(1)
    }
  })

  it('derives the validators from the size and date when no entity tag is given', async () => {
    const dated = await resolveFile(lazy(undefined, { etag: undefined }).body, get())
    expect(dated.headers['etag']).toBe(`"${MODIFIED.toString(16)}-12c"`)
    expect(dated.headers['last-modified']).toBe(LAST_MODIFIED)
    const numeric = await resolveFile(lazy(undefined, { etag: undefined, lastModified: MODIFIED }).body, get())
    expect(numeric.headers['etag']).toBe(dated.headers['etag'] as string)
    // no validator at all: no conditional answer but `*`
    const bare = lazy(undefined, { etag: undefined, lastModified: undefined })
    const resolved = await resolveFile(bare.body, get({ 'if-none-match': '"x"', 'if-modified-since': LAST_MODIFIED }))
    expect(resolved.status).toBe(200)
    expect(resolved.headers['etag']).toBeUndefined()
    expect(resolved.headers['last-modified']).toBeUndefined()
    expect((await resolveFile(bare.body, get({ 'if-none-match': '*' }))).status).toBe(304)
  })

  it('takes the content type and file name from the metadata, under the options', async () => {
    const named = new FileBody(
      { size: 3, name: 'données.json', load: () => new Uint8Array([1, 2, 3]) },
      { disposition: 'inline' },
    )
    const resolved = await resolveFile(named, get())
    expect(resolved.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(resolved.headers['content-disposition']).toBe(
      `inline; filename="donn_es.json"; filename*=UTF-8''donn%C3%A9es.json`,
    )
    const typed = new FileBody(
      { size: 3, type: 'image/png', name: 'x.json', load: () => new Uint8Array(3) },
      { contentType: 'image/webp', filename: 'cover.webp' },
    )
    const overridden = await resolveFile(typed, get())
    expect(overridden.headers['content-type']).toBe('image/webp')
    expect(overridden.headers['content-disposition']).toBe('attachment; filename="cover.webp"')
    const bare = await resolveFile(new FileBody({ size: 1, load: () => new Uint8Array(1) }), get())
    expect(bare.headers['content-type']).toBe('application/octet-stream')
    expect(bare.headers['content-disposition']).toBeUndefined()
  })

  it('rejects content that does not match the declared size', async () => {
    const short = lazy(() => BYTES.slice(1))
    expect(String(await caught(() => resolveFile(short.body, get())))).toContain('299 bytes')
    const blob = lazy(() => new Blob([BYTES, 'x']))
    expect(String(await caught(() => resolveFile(blob.body, get())))).toContain('301 bytes')
    // a stream is checked while it is read
    const shortStream = await resolveFile(lazy(() => chunked(BYTES.slice(10), 50)).body, get())
    expect(String(await caught(() => text(shortStream)))).toContain('290 bytes')
    const longState = { cancelled: false, pulled: 0 }
    const longStream = await resolveFile(lazy(() => chunked(new Uint8Array(400), 50, longState)).body, get())
    expect(String(await caught(() => text(longStream)))).toContain('more than')
    expect(longState.cancelled).toBe(true)
  })

  it('stops reading the loaded stream after the range, and cancels it with the response', async () => {
    const ranged = { cancelled: false, pulled: 0 }
    const partial = await resolveFile(lazy(() => chunked(BYTES, 10, ranged)).body, get({ range: 'bytes=12-25' }))
    expect(await text(partial)).toBe(CONTENT.slice(12, 26))
    expect(ranged.pulled).toBe(3)
    expect(ranged.cancelled).toBe(true)
    // the client leaves: the response body is cancelled, and the loaded stream with it
    const state = { cancelled: false, pulled: 0 }
    const resolved = await resolveFile(lazy(() => chunked(BYTES, 10, state)).body, get())
    const reader = (resolved.body as ReadableStream<Uint8Array>).getReader()
    expect(DECODER.decode((await reader.read()).value)).toBe('0123456789')
    await reader.cancel()
    expect(state.cancelled).toBe(true)
    expect(state.pulled).toBe(1)
  })

  it('rejects with the error of load()', async () => {
    const failure = new Error('storage down')
    for (const load of [
      () => {
        throw failure
      },
      () => Promise.reject(failure),
    ]) {
      expect(await caught(() => resolveFile(new FileBody({ size: 3, load }), get()))).toBe(failure)
    }
    const invalid = new FileBody({ size: 3, load: () => 42 as never })
    expect(await caught(() => resolveFile(invalid, get()))).toBeInstanceOf(TypeError)
  })

  it('validates the metadata', async () => {
    const load = (): Uint8Array => new Uint8Array(0)
    for (const file of [
      { size: -1, load },
      { size: 1.5, load },
      { size: Number.NaN, load },
      { size: '3', load },
      { size: 3, etag: 'v1', load },
      { size: 3, etag: '"a"b"', load },
      { size: 3, etag: 'W/v1', load },
      { size: 3, lastModified: new Date('nope'), load },
      { size: 3, lastModified: 'yesterday', load },
      { size: 3, type: 42, load },
      { size: 3, name: 42, load },
      { size: 3, load: 'not a function' },
    ]) {
      expect({ file, error: await caught(() => HttpResponse.file(file as never)) }).toEqual({
        file,
        error: expect.any(TypeError),
      })
    }
    expect(isFileBody(HttpResponse.file({ size: 0, load }).body)).toBe(true)
  })
})

describe('HttpResponse.stream', () => {
  const read = async (response: HttpResponse<ReadableStream<Uint8Array>>): Promise<string> =>
    DECODER.decode(new Uint8Array(await new Response(response.body).arrayBuffer()))

  it('accepts Web streams, Node.js readables and async iterables of bytes or strings', async () => {
    expect(await read(HttpResponse.stream(Readable.from(['a', Buffer.from('b')])))).toBe('ab')
    expect(
      await read(
        HttpResponse.stream(
          new ReadableStream<string | Uint8Array>({
            start(controller) {
              controller.enqueue('c')
              controller.enqueue(new Uint8Array([100]))
              controller.close()
            },
          }),
        ),
      ),
    ).toBe('cd')
    async function* generate() {
      yield await Promise.resolve('e')
      yield ''
      yield new Uint8Array([102])
    }
    expect(await read(HttpResponse.stream(generate()))).toBe('ef')
  })

  it('sets the content type and disposition', () => {
    expect(HttpResponse.stream(Readable.from([])).headers).toEqual({ 'content-type': 'application/octet-stream' })
    expect(HttpResponse.stream(Readable.from([]), { filename: 'export.csv' }).headers).toEqual({
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="export.csv"',
    })
    expect(
      HttpResponse.stream(Readable.from([]), { contentType: 'application/x-ndjson', disposition: 'inline' }).headers,
    ).toEqual({ 'content-type': 'application/x-ndjson', 'content-disposition': 'inline' })
  })

  it('rejects other values and invalid chunks', async () => {
    expect(await caught(() => HttpResponse.stream('text' as never))).toBeInstanceOf(TypeError)
    expect(await caught(() => HttpResponse.stream([new Uint8Array(1)] as never))).toBeInstanceOf(TypeError)
    async function* invalid() {
      yield (await Promise.resolve(42)) as unknown as string
    }
    expect(await caught(() => read(HttpResponse.stream(invalid())))).toBeInstanceOf(TypeError)
  })

  it('reads the source on demand and cancels it', async () => {
    let produced = 0
    let finalized = false
    async function* endless() {
      try {
        for (;;) {
          produced++
          yield await Promise.resolve(new Uint8Array(1024))
        }
      } finally {
        finalized = true
      }
    }
    const reader = toByteStream(endless()).getReader()
    await reader.read()
    await reader.read()
    expect(produced).toBe(2)
    await reader.cancel()
    expect(finalized).toBe(true)
  })

  it('destroys a Node.js readable cancelled before being read (HEAD, invalid headers)', async () => {
    const readable = Readable.from(['never read'])
    await toByteStream(readable).cancel()
    expect(readable.destroyed).toBe(true)
  })

  it('converts string and ArrayBuffer chunks of returned Web streams to bytes', async () => {
    const chunks: unknown[] = ['a', new TextEncoder().encode('b').buffer, new DataView(new Uint8Array([99]).buffer)]
    const reply = serializeResult(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk)
          controller.close()
        },
      }),
      { method: 'GET', routeMethod: 'GET', status: undefined, headers: undefined },
    )
    const reader = (reply.body as ReadableStream<unknown>).getReader()
    const received: unknown[] = []
    for (let result = await reader.read(); !result.done; result = await reader.read()) received.push(result.value)
    expect(received.every(chunk => chunk instanceof Uint8Array)).toBe(true)
    expect(new TextDecoder().decode(new Uint8Array(received.flatMap(chunk => [...(chunk as Uint8Array)])))).toBe('abc')
    // a stream of HttpResponse.stream() is not wrapped again
    const stream = HttpResponse.stream(Readable.from(['x'])).body
    expect(
      serializeResult(stream, { method: 'GET', routeMethod: 'GET', status: undefined, headers: undefined }).body,
    ).toBe(stream)
  })
})

describe('stream helpers', () => {
  it('tracks the completion, cancellation and failure of a stream', async () => {
    const bytes = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]))
        controller.close()
      },
    })
    const done = trackStream(bytes, captureContext())
    expect([...new Uint8Array(await new Response(done.stream).arrayBuffer())]).toEqual([1, 2])
    expect(await done.done).toBeUndefined()

    let cancelled = false
    const cancelledStream = trackStream(
      new ReadableStream<Uint8Array>({
        pull: controller => controller.enqueue(new Uint8Array(1)),
        cancel: () => {
          cancelled = true
        },
      }),
      captureContext(),
    )
    await cancelledStream.stream.cancel('client gone')
    expect(await cancelledStream.done).toBeUndefined()
    expect(cancelled).toBe(true)

    const failure = new Error('broken')
    const failed = trackStream(failedStream(failure), captureContext())
    expect(await caught(() => new Response(failed.stream).arrayBuffer())).toBe(failure)
    expect(await failed.done).toBe(failure)
  })

  it('bounds the stop of a source that ignores its cancellation', async () => {
    // an async generator blocked in an await: return() waits behind the pending next()
    const source = (async function* () {
      yield 'a'
      await new Promise(() => undefined)
    })()
    const warnings: string[] = []
    const tracked = trackStream(toByteStream(source), captureContext(), undefined, {
      stopTimeoutMs: 30,
      warn: message => warnings.push(message),
    })
    const reader = tracked.stream.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('a')
    const pending = reader.read()
    await sleep(10) // the source is now blocked in its await
    const cancelling = reader.cancel('client gone')
    const outcome = await Promise.race([tracked.done.then(() => 'done'), sleep(1_000).then(() => 'stuck')])
    expect(outcome).toBe('done')
    expect(warnings).toEqual([
      'The response stream source did not stop within 30 ms after its signal was aborted: make it honour ctx.signal',
    ])
    expect((await pending).done).toBe(true)
    await cancelling
  })

  it('tracks a Blob, opened on the first read only', async () => {
    let opened = 0
    class CountingBlob extends Blob {
      override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
        opened++
        return super.stream()
      }
    }
    const sent = trackStream(new CountingBlob(['file']), captureContext())
    expect(opened).toBe(0)
    expect(await new Response(sent.stream).text()).toBe('file')
    expect(opened).toBe(1)
    expect(await sent.done).toBeUndefined()
    const abandoned = trackStream(new CountingBlob(['file']), captureContext())
    await abandoned.stream.cancel()
    expect(await abandoned.done).toBeUndefined()
    expect(opened).toBe(1)
  })

  it('discards unconsumed streams and ignores locked ones', async () => {
    let cancelled = 0
    const stream = () => new ReadableStream<Uint8Array>({ cancel: () => void cancelled++ })
    discardStream(stream())
    const locked = stream()
    locked.getReader()
    discardStream(locked)
    discardStream(null)
    await new Promise(resolve => setTimeout(resolve, 1))
    expect(cancelled).toBe(1)
  })
})
