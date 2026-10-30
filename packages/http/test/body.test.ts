import {
  BadRequestException,
  isJsonType,
  parseBody,
  parseMediaType,
  parseQuery,
  UnsupportedMediaTypeException,
} from '../src/index.ts'
import { splitUrl } from '../src/query.ts'
import { describe, expect, it } from 'bun:test'

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected a rejection')
}

describe('parseQuery / splitUrl', () => {
  it('parses query strings with repeated keys', () => {
    expect(parseQuery('')).toEqual({})
    expect(parseQuery('?')).toEqual({})
    expect(parseQuery('?a=1&b=2&a=3&a=4')).toEqual({ a: ['1', '3', '4'], b: '2' })
    expect(parseQuery('x=a+b&y=%C3%A9&z&bad=%zz&utf=%E0%A4%A')).toEqual({
      x: 'a b',
      y: 'é',
      z: '',
      bad: '%zz',
      utf: '\uFFFD%A',
    })
    expect(parseQuery('a[b]=1')).toEqual({ 'a[b]': '1' })
  })

  it('is safe against prototype keys', () => {
    const query = parseQuery('__proto__=x&constructor=y')
    expect(Object.getPrototypeOf(query)).toBeNull()
    expect(query['__proto__']).toBe('x')
    expect(query['constructor']).toBe('y')
  })

  it('splits urls', () => {
    expect(splitUrl('/a?b=1?c')).toEqual({ path: '/a', query: 'b=1?c' })
    expect(splitUrl('/a')).toEqual({ path: '/a', query: '' })
  })
})

describe('parseMediaType', () => {
  it('parses types and charsets', () => {
    expect(parseMediaType(undefined)).toBeUndefined()
    expect(parseMediaType(' ')).toBeUndefined()
    expect(parseMediaType('Application/JSON')).toEqual({ type: 'application/json', charset: undefined })
    expect(parseMediaType('text/plain; Charset="ISO-8859-1"; q=1')).toEqual({
      type: 'text/plain',
      charset: 'iso-8859-1',
    })
    expect(parseMediaType('text/plain; foo')).toEqual({ type: 'text/plain', charset: undefined })
  })

  it('returns the same parse for a value seen before (cached), as a fresh object', () => {
    const values = [
      'application/json',
      'application/json; charset=utf-8',
      'Application/JSON ;  CHARSET="UTF-8"',
      'text/plain; charset=iso-8859-1',
    ]
    for (const value of values) {
      const first = parseMediaType(value) as { type: string; charset: string | undefined }
      const again = parseMediaType(value)
      expect(again).toEqual(first)
      expect(again).not.toBe(first)
      // a caller changing its result changes nothing for the next ones
      first.type = 'changed/type'
      first.charset = 'changed'
      expect(parseMediaType(value)).toEqual(again as object)
    }
    expect(parseMediaType('Application/JSON ;  CHARSET="UTF-8"')).toEqual({
      type: 'application/json',
      charset: 'utf-8',
    })
    expect(parseMediaType('application/json')).toEqual({ type: 'application/json', charset: undefined })
  })

  it('parses any number of distinct values (the cache is bounded)', () => {
    for (let index = 0; index < 300; index++) {
      expect(parseMediaType(`application/x-${index}; charset=X-${index}`)).toEqual({
        type: `application/x-${index}`,
        charset: `x-${index}`,
      })
    }
    expect(parseMediaType('application/x-7; charset=X-7')).toEqual({ type: 'application/x-7', charset: 'x-7' })
    expect(parseMediaType(' ')).toBeUndefined()
    expect(parseMediaType(' ')).toBeUndefined()
  })

  it('recognises JSON types', () => {
    expect(isJsonType('application/json')).toBe(true)
    expect(isJsonType('application/problem+json')).toBe(true)
    expect(isJsonType('text/json')).toBe(false)
  })
})

describe('parseBody', () => {
  it('returns undefined for empty bodies', async () => {
    expect(await parseBody(new Uint8Array(0), 'application/json')).toBeUndefined()
  })

  it('parses JSON (with BOM and +json)', async () => {
    expect(await parseBody(bytes('{"a":1}'), 'application/json')).toEqual({ a: 1 })
    expect(await parseBody(bytes('﻿[1]'), 'application/vnd.api+json; charset=UTF-8')).toEqual([1])
    expect(await parseBody(bytes('null'), 'application/json')).toBeNull()
  })

  it('rejects malformed JSON, invalid UTF-8 and other charsets', async () => {
    const malformed = await rejection(parseBody(bytes('{"a":'), 'application/json'))
    expect(malformed).toBeInstanceOf(BadRequestException)
    expect((malformed as Error).message).toStartWith('Invalid JSON body')
    const utf8 = await rejection(parseBody(new Uint8Array([0x7b, 0xff, 0x7d]), 'application/json'))
    expect((utf8 as Error).message).toBe('Invalid JSON body: malformed utf-8 data')
    expect(await rejection(parseBody(bytes('{}'), 'application/json; charset=latin1'))).toBeInstanceOf(
      UnsupportedMediaTypeException,
    )
  })

  it('decodes text with its charset', async () => {
    expect(await parseBody(bytes('héllo'), 'text/plain')).toBe('héllo')
    expect(await parseBody(new Uint8Array([0x68, 0xe9]), 'text/plain; charset=iso-8859-1')).toBe('hé')
    expect(await rejection(parseBody(bytes('x'), 'text/plain; charset=klingon'))).toBeInstanceOf(
      UnsupportedMediaTypeException,
    )
  })

  it('parses url-encoded forms', async () => {
    expect(await parseBody(bytes('a=1&a=2&b=x+y'), 'application/x-www-form-urlencoded')).toEqual({
      a: ['1', '2'],
      b: 'x y',
    })
  })

  it('parses multipart forms and rejects malformed ones', async () => {
    const body = '--b\r\nContent-Disposition: form-data; name="f"\r\n\r\nv\r\n--b--\r\n'
    const form = (await parseBody(bytes(body), 'multipart/form-data; boundary=b')) as FormData
    expect(form.get('f')).toBe('v')
    expect(await rejection(parseBody(bytes('garbage'), 'multipart/form-data; boundary=b'))).toBeInstanceOf(
      BadRequestException,
    )
  })

  it('returns bytes for other or missing content types', async () => {
    const raw = bytes('raw')
    expect(await parseBody(raw, undefined)).toBe(raw)
    expect(await parseBody(raw, 'application/octet-stream')).toBe(raw)
    expect(await parseBody(raw, 'image/png')).toBe(raw)
  })

  it('rejects compressed bodies', async () => {
    const error = await rejection(parseBody(bytes('x'), 'text/plain', 'gzip'))
    expect(error).toBeInstanceOf(UnsupportedMediaTypeException)
    expect((error as Error).message).toBe('Unsupported content encoding "gzip"')
    expect(await parseBody(bytes('x'), 'text/plain', 'identity')).toBe('x')
  })
})
