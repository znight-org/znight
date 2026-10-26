/**
 * Upload plumbing: route body plans (limits and multipart rules), the `uploads` helpers of the
 * generated code and the multipart / streaming paths of `RequestContext`.
 */
import type { AdapterRequest, HttpContext, RequestId } from '../src/index.ts'
import type { BodyPlan } from '../src/uploads.ts'

import { RequestContext } from '../src/context.ts'
import { BadRequestException, PayloadTooLargeException, UnsupportedMediaTypeException, uploads } from '../src/index.ts'
import { bodyPlan, DEFAULT_UPLOAD_LIMITS } from '../src/uploads.ts'
import { caught } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

const ENCODER = new TextEncoder()
const LIMITS = { maxFileSize: 100, maxFiles: 3, maxParts: 50, maxFieldSize: 64 }

describe('bodyPlan', () => {
  it('uses the plugin limit and generic multipart rules for routes without uploads', () => {
    expect(bodyPlan({}, 1000, LIMITS)).toEqual({
      limit: 1000,
      upload: false,
      multipart: {
        rules: [{ field: undefined, multiple: true, maxSize: 100, maxFiles: 3, mimeTypes: undefined }],
        maxParts: 50,
        maxFieldSize: 64,
      },
    })
    expect(bodyPlan({ bodyLimit: 10 }, 1000, LIMITS).limit).toBe(10)
  })

  it('derives the limit of upload routes from their file limits (or @BodyLimit)', () => {
    const route = {
      uploads: [
        { field: 'avatar', maxSize: 50, mimeTypes: ['image/*'] },
        { field: 'docs', multiple: true, maxFiles: 2 },
        { field: 'any', multiple: true },
      ],
    }
    const plan = bodyPlan(route, 1000, LIMITS)
    expect(plan.upload).toBe(true)
    expect(plan.limit).toBe(1000 + 50 + 100 * 2 + 100 * 3)
    expect(plan.multipart.rules).toEqual([
      { field: 'avatar', multiple: false, maxSize: 50, maxFiles: 1, mimeTypes: ['image/*'] },
      { field: 'docs', multiple: true, maxSize: 100, maxFiles: 2, mimeTypes: undefined },
      { field: 'any', multiple: true, maxSize: 100, maxFiles: 3, mimeTypes: undefined },
    ])
    expect(bodyPlan({ ...route, bodyLimit: 5000 }, 1000, LIMITS).limit).toBe(5000)
    expect(bodyPlan({ uploads: [{ maxSize: Number.POSITIVE_INFINITY }] }, 1000, LIMITS).limit).toBe(
      Number.POSITIVE_INFINITY,
    )
  })

  it('has safe defaults', () => {
    expect(DEFAULT_UPLOAD_LIMITS).toEqual({
      maxFileSize: 10 * 1024 * 1024,
      maxFiles: 10,
      maxParts: 1000,
      maxFieldSize: 1024 * 1024,
    })
    expect(Object.isFrozen(DEFAULT_UPLOAD_LIMITS)).toBe(true)
  })
})

describe('uploads helpers', () => {
  const file = (name: string): File => new File([name], name)
  const ctx = (files: Record<string, File[]>, body: unknown = {}): HttpContext =>
    ({ files, body }) as unknown as HttpContext

  it('reads one file of a field (any field without name)', () => {
    const avatar = file('a.png')
    expect(uploads.file(ctx({ avatar: [avatar] }), 'avatar')).toBe(avatar)
    expect(uploads.file(ctx({ other: [avatar] }), undefined)).toBe(avatar)
    expect(uploads.optionalFile(ctx({}), 'avatar')).toBeUndefined()
    expect(uploads.optionalFile(ctx({ avatar: [avatar] }), 'avatar')).toBe(avatar)
  })

  it('reads the files of a field, or of every field', () => {
    const [a, b, c] = [file('a'), file('b'), file('c')]
    const files = { docs: [a, b], other: [c] }
    expect(uploads.files(ctx(files), 'docs')).toEqual([a, b])
    expect(uploads.files(ctx(files), undefined)).toEqual([a, b, c])
    expect(uploads.optionalFiles(ctx({}), 'docs')).toEqual([])
    const copy = uploads.files(ctx(files), 'docs')
    copy.pop()
    expect(files.docs).toHaveLength(2)
  })

  it('answers 400 for missing required files with clear messages', async () => {
    const missing = async (fn: () => unknown): Promise<[string, unknown]> => {
      const error = (await caught(fn)) as BadRequestException
      expect(error).toBeInstanceOf(BadRequestException)
      return [error.message, error.details]
    }
    expect(await missing(() => uploads.file(ctx({}), 'avatar'))).toEqual(['Missing file "avatar"', { field: 'avatar' }])
    expect(await missing(() => uploads.files(ctx({}), 'docs'))).toEqual(['Missing files "docs"', { field: 'docs' }])
    expect(await missing(() => uploads.file(ctx({}), undefined))).toEqual(['Missing file', undefined])
    expect(await missing(() => uploads.files(ctx({}, undefined), undefined))).toEqual(['Missing files', undefined])
    expect(await missing(() => uploads.file(ctx({}, { avatar: 'text' }), 'avatar'))).toEqual([
      'Expected a file in field "avatar", received a text value',
      { field: 'avatar' },
    ])
    // inherited keys are not fields
    expect(await missing(() => uploads.file(ctx({}), 'constructor'))).toEqual([
      'Missing file "constructor"',
      { field: 'constructor' },
    ])
  })
})

// -------------------------------------------------------------------------------------------------
// RequestContext
// -------------------------------------------------------------------------------------------------

const BOUNDARY = 'zz'
const MULTIPART = `multipart/form-data; boundary=${BOUNDARY}`

function multipart(...parts: string[]): Uint8Array {
  return ENCODER.encode(`${parts.map(part => `--${BOUNDARY}\r\n${part}\r\n`).join('')}--${BOUNDARY}--\r\n`)
}

const FIELD = 'Content-Disposition: form-data; name="title"\r\n\r\nHello'
const AVATAR = 'Content-Disposition: form-data; name="avatar"; filename="me.png"\r\nContent-Type: image/png\r\n\r\nPNG'

interface FakeRequest extends AdapterRequest {
  readonly calls: string[]
}

function request(
  body: Uint8Array,
  headers: Record<string, string>,
  options: { readonly streaming?: boolean; readonly chunk?: number } = {},
): FakeRequest {
  const calls: string[] = []
  const result: FakeRequest = {
    calls,
    method: 'POST',
    url: '/upload',
    headers: { 'content-length': String(body.byteLength), ...headers },
    ip: undefined,
    raw: undefined,
    rawResponse: undefined,
    readBody(limit) {
      calls.push(`readBody ${limit}`)
      if (body.byteLength > limit) return Promise.reject(new PayloadTooLargeException('too large'))
      return Promise.resolve(body)
    },
    ...(options.streaming === false
      ? {}
      : {
          streamBody(limit: number) {
            calls.push(`streamBody ${limit}`)
            let offset = 0
            const size = options.chunk ?? 3
            return new ReadableStream<Uint8Array>({
              pull(controller) {
                if (offset >= body.byteLength) {
                  controller.close()
                  return
                }
                if (offset + size > limit) {
                  controller.error(new PayloadTooLargeException('too large'))
                  return
                }
                controller.enqueue(body.subarray(offset, offset + size))
                offset += size
              },
            })
          },
        }),
  }
  return result
}

function context(source: AdapterRequest, plan: BodyPlan = bodyPlan({}, 1000, LIMITS)): RequestContext {
  return new RequestContext(source, {
    requestId: 'id' as RequestId,
    adapter: 'test',
    route: undefined,
    params: {},
    body: plan,
  })
}

const UPLOAD_PLAN = bodyPlan({ uploads: [{ field: 'avatar', maxSize: 10, mimeTypes: ['image/*'] }] }, 1000, LIMITS)

describe('RequestContext: multipart bodies', () => {
  it('streams multipart bodies: text fields as the body, files in ctx.files', async () => {
    const source = request(multipart(FIELD, AVATAR), { 'content-type': MULTIPART })
    const ctx = context(source, UPLOAD_PLAN)
    expect(ctx.files).toEqual({})
    expect(Object.isFrozen(ctx.files)).toBe(true)
    const body = await ctx.parseBody()
    expect({ ...(body as object) }).toEqual({ title: 'Hello' })
    expect(ctx.body).toBe(body)
    const [avatar] = ctx.files['avatar'] ?? []
    expect(avatar?.name).toBe('me.png')
    expect(avatar?.type).toBe('image/png')
    expect(await avatar?.text()).toBe('PNG')
    expect(source.calls).toEqual([`streamBody ${UPLOAD_PLAN.limit}`])
    expect(ctx.bodyLimit).toBe(1010)
  })

  it('enforces the upload rules of the route', async () => {
    const other = 'Content-Disposition: form-data; name="other"; filename="x.png"\r\nContent-Type: image/png\r\n\r\nx'
    const text = 'Content-Disposition: form-data; name="avatar"; filename="x.txt"\r\nContent-Type: text/plain\r\n\r\nx'
    const big =
      'Content-Disposition: form-data; name="avatar"; filename="x.png"\r\nContent-Type: image/png\r\n\r\n01234567890'
    const parse = (part: string) =>
      caught(() => context(request(multipart(part), { 'content-type': MULTIPART }), UPLOAD_PLAN).parseBody())
    expect(await parse(other)).toBeInstanceOf(BadRequestException)
    expect(await parse(text)).toBeInstanceOf(UnsupportedMediaTypeException)
    expect(await parse(big)).toBeInstanceOf(PayloadTooLargeException)
  })

  it('accepts files in any field on other routes (generic limits)', async () => {
    const ctx = context(request(multipart(AVATAR), { 'content-type': MULTIPART }))
    expect(await ctx.parseBody()).toEqual({})
    expect(ctx.files['avatar']).toHaveLength(1)
  })

  it('answers 415 for non-multipart bodies on upload routes, and accepts an empty body', async () => {
    const json = context(request(ENCODER.encode('{}'), { 'content-type': 'application/json' }), UPLOAD_PLAN)
    const error = await caught(() => json.parseBody())
    expect(error).toBeInstanceOf(UnsupportedMediaTypeException)
    expect((error as Error).message).toBe('Expected a multipart/form-data body (received "application/json")')
    const untyped = await caught(() => context(request(ENCODER.encode('x'), {}), UPLOAD_PLAN).parseBody())
    expect((untyped as Error).message).toBe('Expected a multipart/form-data body')
    const chunked = context(
      request(new Uint8Array(0), { 'transfer-encoding': 'chunked', 'content-length': '' }),
      UPLOAD_PLAN,
    )
    expect(await caught(() => chunked.parseBody())).toBeInstanceOf(UnsupportedMediaTypeException)
    const empty = context(request(new Uint8Array(0), {}), UPLOAD_PLAN)
    expect(await empty.parseBody()).toBeUndefined()
    expect(empty.files).toEqual({})
  })

  it('rejects compressed multipart bodies (415) and malformed ones (400)', async () => {
    const gzip = context(request(multipart(FIELD), { 'content-type': MULTIPART, 'content-encoding': 'gzip' }))
    expect(await caught(() => gzip.parseBody())).toBeInstanceOf(UnsupportedMediaTypeException)
    const malformed = context(request(ENCODER.encode('nope'), { 'content-type': MULTIPART }))
    expect(await caught(() => malformed.parseBody())).toBeInstanceOf(BadRequestException)
    const noBoundary = context(request(multipart(FIELD), { 'content-type': 'multipart/form-data' }))
    expect(((await caught(() => noBoundary.parseBody())) as Error).message).toBe(
      'Invalid multipart body: missing boundary in the content type',
    )
  })

  it('parses the buffered body when rawBody() was read first (webhook signatures)', async () => {
    const source = request(multipart(FIELD, AVATAR), { 'content-type': MULTIPART })
    const ctx = context(source, UPLOAD_PLAN)
    const raw = await ctx.rawBody()
    expect(raw.byteLength).toBeGreaterThan(0)
    expect(await ctx.parseBody()).toEqual(expect.objectContaining({ title: 'Hello' }))
    expect(ctx.files['avatar']).toHaveLength(1)
    expect(source.calls).toEqual([`readBody ${UPLOAD_PLAN.limit}`])
  })

  it('falls back to readBody() for adapters without streamBody()', async () => {
    const source = request(multipart(FIELD, AVATAR), { 'content-type': MULTIPART }, { streaming: false })
    const ctx = context(source, UPLOAD_PLAN)
    await ctx.parseBody()
    expect(ctx.files['avatar']).toHaveLength(1)
    expect(source.calls).toEqual([`readBody ${UPLOAD_PLAN.limit}`])
  })

  it('applies the body limit of the route', async () => {
    const plan = bodyPlan({ bodyLimit: 20 }, 1000, LIMITS)
    const ctx = context(request(multipart(FIELD, AVATAR), { 'content-type': MULTIPART }), plan)
    expect(await caught(() => ctx.parseBody())).toBeInstanceOf(PayloadTooLargeException)
  })
})

describe('RequestContext: bodyStream()', () => {
  it('streams the raw body with the route limit', async () => {
    const data = ENCODER.encode('0123456789')
    const source = request(data, { 'content-type': 'application/octet-stream' })
    const ctx = context(source, bodyPlan({ bodyLimit: 50 }, 1000, LIMITS))
    const text = await new Response(ctx.bodyStream()).text()
    expect(text).toBe('0123456789')
    expect(source.calls).toEqual(['streamBody 50'])
  })

  it('errors past the limit', async () => {
    const ctx = context(request(new Uint8Array(100), {}), bodyPlan({ bodyLimit: 10 }, 1000, LIMITS))
    expect(await caught(() => new Response(ctx.bodyStream()).arrayBuffer())).toBeInstanceOf(PayloadTooLargeException)
  })

  it('streams the buffered body for adapters without streamBody()', async () => {
    const source = request(ENCODER.encode('abc'), {}, { streaming: false })
    expect(await new Response(context(source).bodyStream()).text()).toBe('abc')
    const empty = request(new Uint8Array(0), {}, { streaming: false })
    expect(await new Response(context(empty).bodyStream()).text()).toBe('')
  })

  it('is exclusive with rawBody() and parseBody()', async () => {
    const message = /The request body was already read/
    const streamed = context(request(ENCODER.encode('{}'), { 'content-type': 'application/json' }))
    streamed.bodyStream()
    expect(() => streamed.bodyStream()).toThrow(message)
    expect(((await caught(() => streamed.rawBody())) as Error).message).toMatch(message)
    expect(((await caught(() => streamed.parseBody())) as Error).message).toMatch(message)
    const parsed = context(request(ENCODER.encode('{}'), { 'content-type': 'application/json' }))
    await parsed.parseBody()
    expect(() => parsed.bodyStream()).toThrow(message)
    const multipartStreamed = context(request(multipart(FIELD), { 'content-type': MULTIPART }))
    multipartStreamed.bodyStream()
    expect(((await caught(() => multipartStreamed.parseBody())) as Error).message).toMatch(message)
    const multipartParsed = context(request(multipart(FIELD), { 'content-type': MULTIPART }))
    await multipartParsed.parseBody()
    expect(((await caught(() => multipartParsed.rawBody())) as Error).message).toMatch(message)
  })
})
