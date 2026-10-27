import { Readable } from 'node:stream'

import { HttpResponse, isHttpResponse } from '../src/index.ts'
import { type SerializeOptions, serializeError, serializeResult } from '../src/serialize.ts'
import { describe, expect, it } from 'bun:test'

const GET: SerializeOptions = { method: 'GET', routeMethod: 'GET', status: undefined, headers: undefined }
const POST: SerializeOptions = { ...GET, method: 'POST', routeMethod: 'POST' }

function text(body: unknown): Promise<string> {
  if (body === null) return Promise.resolve('')
  return new Response(body as ConstructorParameters<typeof Response>[0]).text()
}

describe('serializeResult', () => {
  it('serialises objects, arrays, numbers, booleans and null as JSON', async () => {
    for (const value of [{ a: 1 }, [1, 2], 42, true, null, 'x'.length]) {
      const reply = serializeResult(value, GET)
      expect(reply.status).toBe(200)
      expect(reply.headers['content-type']).toBe('application/json; charset=utf-8')
      expect(await text(reply.body)).toBe(JSON.stringify(value))
      expect(reply.headers['content-length']).toBe(String(JSON.stringify(value).length))
    }
  })

  it('honours toJSON and rejects unserialisable values', () => {
    expect(new TextDecoder().decode(serializeResult(new Date(0), GET).body as Uint8Array)).toBe(
      '"1970-01-01T00:00:00.000Z"',
    )
    expect(() => serializeResult(() => 1, GET)).toThrow(TypeError)
    expect(() => serializeResult({ a: 1n }, GET)).toThrow()
  })

  it('serialises strings as text with a byte length', async () => {
    const reply = serializeResult('héllo', GET)
    expect(reply.headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(reply.headers['content-length']).toBe('6')
    expect(await text(reply.body)).toBe('héllo')
  })

  it('serialises bytes, buffers and views', () => {
    for (const value of [
      new Uint8Array([1, 2]),
      Buffer.from([1, 2]),
      new Uint8Array([1, 2]).buffer,
      new DataView(new Uint8Array([9, 1, 2]).buffer, 1),
    ]) {
      const reply = serializeResult(value, GET)
      expect(reply.headers['content-type']).toBe('application/octet-stream')
      expect(reply.headers['content-length']).toBe('2')
      expect([...(reply.body as Uint8Array)]).toEqual([1, 2])
    }
  })

  it('streams Web streams, Node streams and blobs', async () => {
    const web = serializeResult(new Response('web').body, GET)
    expect(web.headers['content-type']).toBe('application/octet-stream')
    expect(web.headers['content-length']).toBeUndefined()
    expect(await text(web.body)).toBe('web')
    const node = serializeResult(Readable.from(['no', 'de']), GET)
    expect(await text(node.body)).toBe('node')
    const blob = serializeResult(new Blob(['blob'], { type: 'image/x-test' }), GET)
    expect(blob.headers['content-type']).toBe('image/x-test')
    expect(blob.headers['content-length']).toBe('4')
    expect(await text(blob.body)).toBe('blob')
  })

  it('sends Web responses as is', async () => {
    const response = new Response('tea', { status: 418, headers: { 'x-a': '1' } })
    response.headers.append('set-cookie', 'a=1')
    response.headers.append('set-cookie', 'b=2')
    const reply = serializeResult(response, {
      ...GET,
      status: 200,
      headers: { 'x-static': '1' },
      context: { 'x-a': 'ctx', 'x-ctx': '1' },
    })
    expect(reply.status).toBe(418)
    expect(reply.headers['x-a']).toBe('1')
    expect(reply.headers['x-ctx']).toBe('1')
    expect(reply.headers['x-static']).toBeUndefined()
    expect(reply.headers['set-cookie']).toEqual(['a=1', 'b=2'])
    expect(await text(reply.body)).toBe('tea')
  })

  it('applies the status precedence', () => {
    expect(serializeResult(undefined, GET).status).toBe(204)
    expect(serializeResult(undefined, POST).status).toBe(201)
    expect(serializeResult({}, POST).status).toBe(201)
    expect(serializeResult(undefined, { ...GET, status: 202 }).status).toBe(202)
    expect(serializeResult(new HttpResponse({}, { status: 203 }), GET).status).toBe(203)
    expect(serializeResult(new HttpResponse({}, { status: 203 }), { ...GET, status: 200 }).status).toBe(200)
    expect(serializeResult(new HttpResponse(undefined), GET).status).toBe(204)
    expect(serializeResult({}, { ...GET, method: 'POST', routeMethod: 'ALL' }).status).toBe(200)
  })

  it('merges headers: content type < @Header < context < HttpResponse', () => {
    const reply = serializeResult(new HttpResponse('x', { headers: { 'X-Resp': 'r', 'x-all': 'resp' } }), {
      ...GET,
      headers: { 'x-static': 's', 'x-all': 'static', 'content-type': 'text/csv' },
      context: { 'x-ctx': 'c', 'x-all': 'ctx' },
    })
    expect(reply.headers).toMatchObject({
      'content-type': 'text/csv',
      'x-static': 's',
      'x-ctx': 'c',
      'x-resp': 'r',
      'x-all': 'resp',
    })
  })

  it('drops bodies of HEAD requests and bodyless statuses', () => {
    const head = serializeResult({ a: 1 }, { ...GET, method: 'HEAD' })
    expect(head.body).toBeNull()
    expect(head.headers['content-length']).toBe('7')
    const noContent = serializeResult({ a: 1 }, { ...GET, status: 204 })
    expect(noContent.body).toBeNull()
    expect(noContent.headers['content-type']).toBeUndefined()
    expect(noContent.headers['content-length']).toBeUndefined()
    let cancelled = false
    const stream = new ReadableStream({
      cancel: () => {
        cancelled = true
      },
    })
    expect(serializeResult(stream, { ...GET, method: 'HEAD' }).body).toBeNull()
    expect(cancelled).toBe(true)
  })

  it('serialises errors as JSON', async () => {
    const reply = serializeError(404, { statusCode: 404 }, 'GET')
    expect(reply.status).toBe(404)
    expect(await text(reply.body)).toBe('{"statusCode":404}')
    expect(serializeError(404, { statusCode: 404 }, 'HEAD').body).toBeNull()
  })
})

describe('HttpResponse', () => {
  it('builds responses with helpers', () => {
    expect(HttpResponse.ok({ a: 1 })).toMatchObject({ body: { a: 1 }, status: 200, headers: {} })
    expect(HttpResponse.ok(1, { 'x-a': '1' }).headers).toEqual({ 'x-a': '1' })
    expect(HttpResponse.created({ id: 1 }, '/users/1')).toMatchObject({
      status: 201,
      headers: { location: '/users/1' },
    })
    expect(HttpResponse.created()).toMatchObject({ status: 201, body: undefined })
    expect(HttpResponse.accepted()).toMatchObject({ status: 202 })
    expect(HttpResponse.noContent()).toMatchObject({ status: 204 })
    expect(HttpResponse.redirect('/x')).toMatchObject({ status: 302, headers: { location: '/x' } })
    expect(HttpResponse.redirect('/x', 301).status).toBe(301)
  })

  it('types created() and accepted() with their body (no `| undefined`)', () => {
    interface Book {
      readonly id: number
    }
    const created: HttpResponse<Book> = HttpResponse.created({ id: 1 }, '/books/1')
    const accepted: HttpResponse<Book> = HttpResponse.accepted({ id: 2 })
    const empty: HttpResponse<undefined> = HttpResponse.created()
    const nothing: HttpResponse<undefined> = HttpResponse.accepted()
    expect([created.body.id, accepted.body.id, empty.body, nothing.body]).toEqual([1, 2, undefined, undefined])
    expect([created.status, accepted.status]).toEqual([201, 202])
  })

  it('copies with headers and status', () => {
    const base = new HttpResponse('x', { headers: { a: '1' } })
    const copy = base.withHeader('B', '2').withStatus(201)
    expect(copy).toMatchObject({ body: 'x', status: 201, headers: { a: '1', b: '2' } })
    expect(base.headers).toEqual({ a: '1' })
    expect(base.status).toBeUndefined()
  })

  it('rejects invalid statuses', () => {
    expect(() => new HttpResponse(null, { status: 1000 })).toThrow(RangeError)
  })

  it('is detected across copies', () => {
    expect(isHttpResponse(HttpResponse.ok(1))).toBe(true)
    class HttpResponseLike {
      body = 1
      headers = {}
    }
    Object.defineProperty(HttpResponseLike, 'name', { value: 'HttpResponse' })
    expect(isHttpResponse(new HttpResponseLike())).toBe(true)
    expect(isHttpResponse({ body: 1, headers: {} })).toBe(false)
  })
})
