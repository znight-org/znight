/**
 * Files behaviour matrix: uploads, downloads and streamed responses answer the same on every adapter,
 * in memory (`inject`) and over the network (`fetch`).
 */
import type { FilesDir } from './files-app.ts'

import { createFilesDir, filesMetadata, filesOptions, filesState, streamLog } from './files-app.ts'
import { ADAPTERS, createApp, type Send, type TestApp, TRANSPORTS } from './helpers.ts'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

function form(entries: Record<string, string | File | readonly (string | File)[]>): FormData {
  const data = new FormData()
  for (const [name, value] of Object.entries(entries)) {
    for (const item of Array.isArray(value) ? value : [value]) data.append(name, item as string | Blob)
  }
  return data
}

function png(name = 'me.png', size = 4): File {
  return new File([new Uint8Array(size).fill(80)], name, { type: 'image/png' })
}

/** A raw multipart body (for cases `FormData` cannot express). */
function rawMultipart(boundary: string, parts: readonly string[]): string {
  return `${parts.map(part => `--${boundary}\r\n${part}\r\n`).join('')}--${boundary}--\r\n`
}

let dir: FilesDir

beforeAll(() => {
  dir = createFilesDir()
  filesState.dir = dir
})

afterAll(() => {
  dir.cleanup()
})

for (const adapter of ADAPTERS) {
  describe(`${adapter.name} adapter`, () => {
    let app: TestApp

    beforeAll(async () => {
      app = await createApp(filesMetadata(), { ...filesOptions(), adapter: adapter.create() })
    })

    afterAll(async () => {
      await app.stop()
    })

    for (const transport of TRANSPORTS) {
      describe(`via ${transport.name}`, () => {
        let send: Send
        beforeAll(() => {
          send = transport.create(app.http)
        })

        describe('uploads', () => {
          it('injects the file and the validated text fields', async () => {
            const res = await send({
              method: 'POST',
              url: '/upload/avatar',
              body: form({ title: 'Me', tags: ['a', 'b'], avatar: png('résumé été.png') }),
            })
            expect(res.status).toBe(201)
            expect(res.json()).toEqual({
              avatar: { name: 'résumé été.png', type: 'image/png', size: 4, text: 'PPPP' },
              meta: { title: 'Me', tags: ['a', 'b'] },
            })
          })

          it('validates the text fields with the schema', async () => {
            const res = await send({ method: 'POST', url: '/upload/avatar', body: form({ avatar: png() }) })
            expect(res.status).toBe(400)
            expect(res.json<{ message: string; details: { path: string }[] }>()).toMatchObject({
              message: 'Invalid body',
              details: [{ path: 'title' }],
            })
          })

          it('answers 400 for a missing required file, or a text value instead of a file', async () => {
            const missing = await send({ method: 'POST', url: '/upload/avatar', body: form({ title: 'Me' }) })
            expect(missing.status).toBe(400)
            expect(missing.json()).toEqual({
              statusCode: 400,
              error: 'Bad Request',
              message: 'Missing file "avatar"',
              details: { field: 'avatar' },
            })
            const text = await send({ method: 'POST', url: '/upload/avatar', body: form({ title: 'Me', avatar: 'x' }) })
            expect(text.status).toBe(400)
            expect(text.json<{ message: string }>().message).toBe(
              'Expected a file in field "avatar", received a text value',
            )
          })

          it('answers 413 for a file above maxSize', async () => {
            const res = await send({
              method: 'POST',
              url: '/upload/avatar',
              body: form({ title: 'Me', avatar: png('big.png', 65) }),
            })
            expect(res.status).toBe(413)
            expect(res.json()).toEqual({
              statusCode: 413,
              error: 'Payload Too Large',
              message: 'File in field "avatar" exceeds the maximum size of 64 bytes',
              details: { field: 'avatar', maxSize: 64 },
            })
            expect(res.headers['connection']).toBe('close')
          })

          it('answers 415 for a refused media type', async () => {
            const res = await send({
              method: 'POST',
              url: '/upload/avatar',
              body: form({ title: 'Me', avatar: new File(['x'], 'x.txt', { type: 'text/plain' }) }),
            })
            expect(res.status).toBe(415)
            expect(res.json<{ message: string }>().message).toBe(
              'Unsupported file type "text/plain" in field "avatar" (accepted: image/png, image/*)',
            )
          })

          it('answers 400 for a second file in a single-file field and for an undeclared file field', async () => {
            const twice = await send({
              method: 'POST',
              url: '/upload/avatar',
              body: form({ title: 'Me', avatar: [png('1.png'), png('2.png')] }),
            })
            expect(twice.status).toBe(400)
            expect(twice.json<{ message: string }>().message).toBe('Expected a single file in field "avatar"')
            const unexpected = await send({
              method: 'POST',
              url: '/upload/avatar',
              body: form({ title: 'Me', avatar: png(), other: png('other.png') }),
            })
            expect(unexpected.status).toBe(400)
            expect(unexpected.json()).toEqual({
              statusCode: 400,
              error: 'Bad Request',
              message: 'Unexpected file field "other"',
              details: { field: 'other', expected: ['avatar'] },
            })
          })

          it('answers 415 for a non-multipart body and 400 for an empty one', async () => {
            const json = await send({ method: 'POST', url: '/upload/avatar', body: { title: 'Me' } })
            expect(json.status).toBe(415)
            expect(json.json<{ message: string }>().message).toBe(
              'Expected a multipart/form-data body (received "application/json")',
            )
            const empty = await send({ method: 'POST', url: '/upload/avatar' })
            expect(empty.status).toBe(400)
            expect(empty.json<{ message: string }>().message).toBe('Missing file "avatar"')
          })

          it('answers 400 for a malformed multipart body', async () => {
            const res = await send({
              method: 'POST',
              url: '/upload/avatar',
              body: '--x\r\nContent-Disposition: form-data; name="title"\r\n\r\nMe\r\n',
              headers: { 'content-type': 'multipart/form-data; boundary=x' },
            })
            expect(res.status).toBe(400)
            expect(res.json<{ message: string }>().message).toBe(
              'Invalid multipart body: unexpected end of the body (missing closing boundary)',
            )
          })

          it('injects undefined for an optional file', async () => {
            const without = await send({ method: 'POST', url: '/upload/optional', body: form({ note: 'n' }) })
            expect(without.status).toBe(201)
            expect(without.json()).toEqual({ file: null, fields: { note: 'n' } })
            const empty = await send({ method: 'POST', url: '/upload/optional' })
            expect(empty.json()).toEqual({ file: null })
            const withFile = await send({
              method: 'POST',
              url: '/upload/optional',
              body: form({ file: new File(['hi'], 'hi.bin', { type: 'application/x-custom' }) }),
            })
            expect(withFile.json()).toEqual({
              file: { name: 'hi.bin', type: 'application/x-custom', size: 2, text: 'hi' },
              fields: {},
            })
          })

          it('injects several files, up to maxFiles (413 above), at least one when required', async () => {
            const two = await send({
              method: 'POST',
              url: '/upload/many',
              body: form({ documents: [new File(['1'], 'a.txt'), new File(['22'], 'b.txt')] }),
            })
            expect(two.status).toBe(201)
            expect(
              two.json<{ documents: { name: string; size: number }[] }>().documents.map(file => file.name),
            ).toEqual(['a.txt', 'b.txt'])
            const three = await send({
              method: 'POST',
              url: '/upload/many',
              body: form({ documents: ['1', '2', '3'].map(name => new File([name], `${name}.txt`)) }),
            })
            expect(three.status).toBe(413)
            expect(three.json<{ message: string }>().message).toBe('Too many files in field "documents" (at most 2)')
            const none = await send({ method: 'POST', url: '/upload/many', body: form({ x: '1' }) })
            expect(none.status).toBe(400)
            expect(none.json<{ message: string }>().message).toBe('Missing files "documents"')
          })

          it('injects the files of every field', async () => {
            const res = await send({
              method: 'PUT',
              url: '/upload/any',
              body: form({ a: new File(['1'], '1.txt'), b: new File(['2'], '2.txt'), text: 'ignored' }),
            })
            expect(res.status).toBe(200)
            expect(res.json<{ files: { name: string }[] }>().files.map(file => file.name)).toEqual(['1.txt', '2.txt'])
            expect((await send({ method: 'PUT', url: '/upload/any', body: form({ text: 'x' }) })).json()).toEqual({
              files: [],
            })
          })

          it('injects the single file of any field', async () => {
            const res = await send({ method: 'PATCH', url: '/upload/single', body: form({ whatever: png() }) })
            expect(res.json<{ name: string }>().name).toBe('me.png')
            const two = await send({
              method: 'PATCH',
              url: '/upload/single',
              body: form({ a: png('a.png'), b: png('b.png') }),
            })
            expect(two.status).toBe(400)
            expect(two.json<{ message: string }>().message).toBe('Expected a single file')
          })

          it('applies the plugin limits on parts and text fields', async () => {
            const fields: Record<string, string> = {}
            for (let index = 0; index < 21; index++) fields[`f${index}`] = 'v'
            const parts = await send({ method: 'POST', url: '/upload/optional', body: form(fields) })
            expect(parts.status).toBe(413)
            expect(parts.json<{ message: string }>().message).toBe('Too many parts in the multipart body (at most 20)')
            const long = await send({ method: 'POST', url: '/upload/optional', body: form({ note: 'x'.repeat(257) }) })
            expect(long.status).toBe(413)
            expect(long.json<{ message: string }>().message).toBe('Field "note" exceeds the maximum size of 256 bytes')
          })

          it('reads files with exotic names and types written by any client', async () => {
            const res = await send({
              method: 'POST',
              url: '/upload/optional',
              body: rawMultipart('q', [
                `Content-Disposition: form-data; name="file"; filename="plain.txt"; filename*=UTF-8''%E6%97%A5%E6%9C%AC.txt\r\nContent-Type: TEXT/Plain\r\n\r\ncontent`,
              ]),
              headers: { 'content-type': 'multipart/form-data; boundary=q' },
            })
            expect(res.json()).toEqual({
              file: { name: '日本.txt', type: 'text/plain', size: 7, text: 'content' },
              fields: {},
            })
          })

          it('streams raw bodies with ctx.bodyStream() within @BodyLimit', async () => {
            const data = new Uint8Array(50_000).map((_, index) => index % 251)
            let sum = 0
            for (const byte of data) sum = (sum + byte) % 65_521
            const res = await send({ method: 'PUT', url: '/upload/raw', body: data })
            expect(res.status).toBe(200)
            expect(res.json()).toEqual({ size: 50_000, sum })
            const tooLarge = await send({ method: 'PUT', url: '/upload/raw', body: new Uint8Array(100_001) })
            expect(tooLarge.status).toBe(413)
          })
        })

        describe('downloads', () => {
          it('sends a file with its metadata', async () => {
            const res = await send({ method: 'GET', url: '/download/public/sample.txt' })
            expect(res.status).toBe(200)
            expect(res.body).toBe('0123456789'.repeat(30))
            expect(res.headers).toMatchObject({
              'content-type': 'text/plain; charset=utf-8',
              'content-length': '300',
              'accept-ranges': 'bytes',
              'last-modified': 'Mon, 06 May 2024 07:08:09 GMT',
            })
            expect(res.headers['etag']).toMatch(/^"[0-9a-f]+-12c"$/)
            expect(res.headers['content-disposition']).toBeUndefined()
            const image = await send({ method: 'GET', url: '/download/public/image.png' })
            expect(image.headers['content-type']).toBe('image/png')
            expect([...image.bytes]).toEqual([0x89, 0x50, 0x4e, 0x47])
            const nested = await send({ method: 'GET', url: '/download/public/docs/readme.md' })
            expect(nested.body).toBe('# readme\n')
          })

          it('answers HEAD with the headers only', async () => {
            const res = await send({ method: 'HEAD', url: '/download/public/sample.txt' })
            expect(res.status).toBe(200)
            expect(res.body).toBe('')
            expect(res.headers['content-length']).toBe('300')
            expect(res.headers['content-type']).toBe('text/plain; charset=utf-8')
          })

          it('answers conditional requests with 304 (and 412)', async () => {
            const first = await send({ method: 'GET', url: '/download/public/sample.txt' })
            const etag = first.headers['etag'] as string
            const cached = await send({
              method: 'GET',
              url: '/download/public/sample.txt',
              headers: { 'if-none-match': etag },
            })
            expect(cached.status).toBe(304)
            expect(cached.body).toBe('')
            expect(cached.headers['etag']).toBe(etag)
            expect(cached.headers['content-type']).toBeUndefined()
            const since = await send({
              method: 'GET',
              url: '/download/public/sample.txt',
              headers: { 'if-modified-since': 'Mon, 06 May 2024 07:08:09 GMT' },
            })
            expect(since.status).toBe(304)
            const failed = await send({
              method: 'GET',
              url: '/download/public/sample.txt',
              headers: { 'if-match': '"other"' },
            })
            expect(failed.status).toBe(412)
            expect(failed.json()).toEqual({
              statusCode: 412,
              error: 'Precondition Failed',
              message: 'Precondition Failed',
            })
          })

          it('answers byte ranges with 206 and unsatisfiable ranges with 416', async () => {
            const partial = await send({
              method: 'GET',
              url: '/download/public/sample.txt',
              headers: { range: 'bytes=10-14' },
            })
            expect(partial.status).toBe(206)
            expect(partial.body).toBe('01234')
            expect(partial.headers['content-range']).toBe('bytes 10-14/300')
            expect(partial.headers['content-length']).toBe('5')
            const suffix = await send({
              method: 'GET',
              url: '/download/public/sample.txt',
              headers: { range: 'bytes=-2' },
            })
            expect(suffix.body).toBe('89')
            const unsatisfiable = await send({
              method: 'GET',
              url: '/download/public/sample.txt',
              headers: { range: 'bytes=1000-' },
            })
            expect(unsatisfiable.status).toBe(416)
            expect(unsatisfiable.headers['content-range']).toBe('bytes */300')
            expect(unsatisfiable.json<{ error: string }>().error).toBe('Range Not Satisfiable')
          })

          it('answers 404 for missing files and paths escaping the root', async () => {
            for (const url of [
              '/download/public/missing.txt',
              '/download/public/..%2Fsecret.txt',
              '/download/public/docs/..%2F..%2Fsecret.txt',
              '/download/public/escape.txt',
              '/download/public/docs',
            ]) {
              const res = await send({ method: 'GET', url })
              expect({ url, status: res.status }).toEqual({ url, status: 404 })
              expect(res.json()).toEqual({ statusCode: 404, error: 'Not Found', message: 'File not found' })
            }
            // without `root`, the path is used as given: never build it from the request like this
            const unsafe = await send({ method: 'GET', url: '/download/unsafe/..%2Fsecret.txt' })
            expect(unsafe.body).toBe('secret')
          })

          it('sends attachments with RFC 6266 / 5987 file names', async () => {
            const res = await send({ method: 'GET', url: '/download/attachment' })
            expect(res.headers['content-disposition']).toBe(
              `attachment; filename="rapport _t_ \\"final\\".txt"; filename*=UTF-8''rapport%20%C3%A9t%C3%A9%20%22final%22.txt`,
            )
            expect(res.headers['content-type']).toBe('text/plain; charset=utf-8')
            const inline = await send({ method: 'GET', url: '/download/inline' })
            expect(inline.headers['content-disposition']).toBe('inline; filename="sample.txt"')
            const typed = await send({ method: 'GET', url: '/download/typed' })
            expect(typed.headers['content-type']).toBe('text/x-custom')
            expect(typed.headers['content-disposition']).toBe('attachment; filename="sample.txt"')
            expect(typed.headers['cache-control']).toBe('max-age=60')
          })

          it('sends Blob / File objects (with ranges)', async () => {
            const res = await send({ method: 'GET', url: '/download/blob' })
            expect(res.status).toBe(200)
            expect(res.json()).toEqual({ ok: true })
            // the type of the File (Bun adds `;charset=utf-8` to `application/json` Files)
            expect(res.headers['content-type']).toStartWith('application/json')
            expect(res.headers['content-disposition']).toBe(
              `attachment; filename="donn_es.json"; filename*=UTF-8''donn%C3%A9es.json`,
            )
            expect(res.headers['last-modified']).toBe('Thu, 01 Jan 1970 00:00:00 GMT')
            const range = await send({ method: 'GET', url: '/download/blob', headers: { range: 'bytes=1-4' } })
            expect(range.status).toBe(206)
            expect(range.body).toBe('"ok"')
            const direct = await send({ method: 'GET', url: '/download/direct' })
            expect(direct.body).toBe('direct file')
            expect(direct.headers['content-type']).toStartWith('text/plain')
            expect(direct.headers['content-length']).toBe('11')
          })
        })

        describe('streams', () => {
          it('streams Node.js readables, Web streams and async iterables', async () => {
            const readable = await send({ method: 'GET', url: '/download/stream/readable' })
            expect(readable.body).toBe('node readable')
            expect(readable.headers['content-type']).toBe('text/plain; charset=utf-8')
            const web = await send({ method: 'GET', url: '/download/stream/web' })
            expect(web.body).toBe('web stream')
            expect(web.headers['content-type']).toBe('application/octet-stream')
            const csv = await send({ method: 'GET', url: '/download/stream/iterable' })
            expect(csv.body).toBe('id,name\n1,item 1\n2,item 2\n3,item 3\n')
            expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8')
            expect(csv.headers['content-disposition']).toBe('attachment; filename="export.csv"')
            const head = await send({ method: 'HEAD', url: '/download/stream/iterable' })
            expect(head.status).toBe(200)
            expect(head.body).toBe('')
          })

          it('keeps request-scoped instances alive until the stream has been sent', async () => {
            const before = streamLog.length
            const res = await send({ method: 'GET', url: '/scoped/chunks' })
            expect(res.body).toBe('0:alive;1:alive;2:alive;')
            await new Promise(resolve => setTimeout(resolve, 10))
            // without the instance number: `chunk 0 7 alive` → `chunk 0 alive`
            const events = streamLog
              .slice(before)
              .map(event => event.replace(/^chunk (\d+) \d+/, 'chunk $1').replace(/^(end|dispose) \d+$/, '$1'))
            expect(events).toEqual(['chunk 0 alive', 'chunk 1 alive', 'chunk 2 alive', 'end', 'dispose'])
          })

          it('logs a failing stream and keeps serving', async () => {
            try {
              await send({ method: 'GET', url: '/download/stream/failing' })
            } catch {
              // the connection is reset mid-body: some clients reject
            }
            await new Promise(resolve => setTimeout(resolve, 20))
            expect(app.logger.entries.some(entry => entry.message === 'The response stream failed')).toBe(true)
            expect((await send({ method: 'GET', url: '/download/stream/web' })).body).toBe('web stream')
          })
        })
      })
    }
  })
}
