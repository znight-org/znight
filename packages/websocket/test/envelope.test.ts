import {
  codeOfStatus,
  decodeFrame,
  EVENT_NAME,
  encodeErrorEvent,
  encodeErrorReply,
  encodeEvent,
  encodeReply,
  Gateway,
  OnMessage,
  WsException,
  WsValidationException,
} from '../src/index.ts'
import { describe, expect, it } from 'bun:test'

describe('decodeFrame', () => {
  it('decodes an event, its data and its id', () => {
    expect(decodeFrame('{"event":"message.send","data":{"text":"hi"},"id":7,"extra":1}')).toEqual({
      event: 'message.send',
      data: { text: 'hi' },
      id: 7,
    })
    expect(decodeFrame('{"event":"a","id":"req-1"}')).toEqual({ event: 'a', data: undefined, id: 'req-1' })
  })

  it.each([
    ['not JSON', '{', 'BAD_FRAME'],
    ['an array', '[1]', 'BAD_FRAME'],
    ['null', 'null', 'BAD_FRAME'],
    ['no event', '{"data":1}', 'BAD_FRAME'],
    ['an invalid id', '{"event":"a","id":1.5}', 'BAD_FRAME'],
    ['a long id', `{"event":"a","id":"${'x'.repeat(65)}"}`, 'BAD_FRAME'],
    ['a long event name', `{"event":"${'a'.repeat(129)}"}`, 'BAD_FRAME'],
    ['an event name with control characters', '{"event":"a\\r\\nb"}', 'BAD_FRAME'],
    ['a reserved event name', '{"event":"$other"}', 'BAD_FRAME'],
  ])('refuses %s', (_label, frame, code) => {
    expect(decodeFrame(frame)).toMatchObject({ error: code })
  })

  it('accepts the longest event name and $ping', () => {
    expect(decodeFrame(`{"event":"${'a'.repeat(128)}"}`)).toMatchObject({ event: 'a'.repeat(128) })
    expect(decodeFrame('{"event":"$ping","id":1}')).toEqual({ event: '$ping', data: undefined, id: 1 })
    expect(decodeFrame('{"event":" x","id":2}')).toEqual({ error: 'BAD_FRAME', message: 'Invalid event name', id: 2 })
  })

  it('refuses binary frames and keeps a readable id', () => {
    expect(decodeFrame(new Uint8Array([1]))).toMatchObject({ error: 'UNSUPPORTED_FRAME' })
    expect(decodeFrame('{"id":3}')).toMatchObject({ error: 'BAD_FRAME', id: 3 })
  })
})

describe('encoders', () => {
  it('encodes replies, events and errors', () => {
    expect(encodeReply(7, undefined)).toBe('{"id":7}')
    expect(encodeReply(7, { ok: true })).toBe('{"id":7,"data":{"ok":true}}')
    expect(encodeErrorReply(7, { code: 'FORBIDDEN', message: 'No' })).toBe(
      '{"id":7,"error":{"code":"FORBIDDEN","message":"No"}}',
    )
    expect(encodeEvent('message.new', { text: 'hi' })).toBe('{"event":"message.new","data":{"text":"hi"}}')
    expect(encodeErrorEvent('message.send', { code: 'BAD_REQUEST', message: 'Invalid', details: [] })).toBe(
      '{"event":"$error","data":{"event":"message.send","code":"BAD_REQUEST","message":"Invalid","details":[]}}',
    )
  })

  it('checks event names', () => {
    expect(EVENT_NAME.test('message.send')).toBe(true)
    expect(EVENT_NAME.test('$ping')).toBe(false)
    expect(EVENT_NAME.test('1abc')).toBe(false)
  })
})

describe('exceptions and markers', () => {
  it('maps HTTP statuses to wire codes', () => {
    expect([400, 401, 403, 404, 409, 422, 429, 418, 500].map(codeOfStatus)).toEqual([
      'BAD_REQUEST',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'NOT_FOUND',
      'CONFLICT',
      'UNPROCESSABLE',
      'RATE_LIMITED',
      'BAD_REQUEST',
      'INTERNAL',
    ])
  })

  it('carries codes, details and close codes', () => {
    const error = new WsException('FORBIDDEN', 'Join first', undefined, { close: 4403 })
    expect(error).toMatchObject({ code: 'FORBIDDEN', message: 'Join first', close: 4403 })
    const validation = new WsValidationException([{ path: 'room', message: 'Required' }])
    expect(validation).toMatchObject({ code: 'BAD_REQUEST', details: [{ path: 'room', message: 'Required' }] })
  })

  it('applies the decorators as no-ops', () => {
    @Gateway('/chat')
    class ChatGateway {
      @OnMessage('ping')
      ping(): string {
        return 'pong'
      }
    }
    expect(new ChatGateway().ping()).toBe('pong')
  })
})
