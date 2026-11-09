import type { HttpContext } from '../src/index.ts'

import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GatewayTimeoutException,
  GoneException,
  HttpException,
  HttpResponse,
  InternalServerErrorException,
  isHttpException,
  MethodNotAllowedException,
  NotFoundException,
  NotImplementedException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  statusText,
  TooManyRequestsException,
  UnauthorizedException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
  ValidationException,
} from '../src/index.ts'
import { isBodylessStatus, isValidStatus } from '../src/status.ts'
import { ADAPTERS, controller, createApp, metadata, provider, route, t, viaFetch } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

describe('HttpException', () => {
  it('renders { statusCode, error, message, details? }', () => {
    const error = new HttpException(409, 'Email already used', { field: 'email' })
    expect(error).toBeInstanceOf(Error)
    expect(error.status).toBe(409)
    expect(error.statusCode).toBe(409)
    expect(error.name).toBe('HttpException')
    expect(error.toBody()).toEqual({
      statusCode: 409,
      error: 'Conflict',
      message: 'Email already used',
      details: { field: 'email' },
    })
    expect(new HttpException(404).toBody()).toEqual({ statusCode: 404, error: 'Not Found', message: 'Not Found' })
  })

  it('keeps headers and cause', () => {
    const cause = new Error('root')
    const error = new HttpException(401, 'no', undefined, { cause, headers: { 'www-authenticate': 'Bearer' } })
    expect(error.cause).toBe(cause)
    expect(error.headers).toEqual({ 'www-authenticate': 'Bearer' })
    expect(new HttpException(400).headers).toEqual({})
  })

  it('turns invalid statuses into 500', () => {
    expect(new HttpException(42).status).toBe(500)
    expect(new HttpException(600).status).toBe(500)
    expect(new HttpException(404.5).status).toBe(500)
  })

  it.each([
    [BadRequestException, 400, 'Bad Request'],
    [UnauthorizedException, 401, 'Unauthorized'],
    [ForbiddenException, 403, 'Forbidden'],
    [NotFoundException, 404, 'Not Found'],
    [MethodNotAllowedException, 405, 'Method Not Allowed'],
    [ConflictException, 409, 'Conflict'],
    [GoneException, 410, 'Gone'],
    [PayloadTooLargeException, 413, 'Payload Too Large'],
    [UnsupportedMediaTypeException, 415, 'Unsupported Media Type'],
    [UnprocessableEntityException, 422, 'Unprocessable Entity'],
    [TooManyRequestsException, 429, 'Too Many Requests'],
    [InternalServerErrorException, 500, 'Internal Server Error'],
    [NotImplementedException, 501, 'Not Implemented'],
    [BadGatewayException, 502, 'Bad Gateway'],
    [ServiceUnavailableException, 503, 'Service Unavailable'],
    [GatewayTimeoutException, 504, 'Gateway Timeout'],
  ] as const)('%p has status %p', (Exception, status, reason) => {
    const error = new Exception('custom', ['detail'], { headers: { 'x-a': 'b' } })
    expect(error).toBeInstanceOf(HttpException)
    expect(error.status).toBe(status)
    expect(error.name).toBe(Exception.name)
    expect(error.headers).toEqual({ 'x-a': 'b' })
    expect(error.toBody()).toEqual({ statusCode: status, error: reason, message: 'custom', details: ['detail'] })
    expect(new Exception().message).toBe(reason)
  })

  it('lets subclasses change the body', () => {
    class ProblemException extends HttpException {
      override toBody() {
        return { ...super.toBody(), type: 'about:blank' }
      }
    }
    expect(new ProblemException(400).toBody()).toMatchObject({ type: 'about:blank', statusCode: 400 })
  })

  it('creates validation exceptions from issues', () => {
    const error = new ValidationException('query "page"', [{ message: 'Too big', path: ['page'] }])
    expect(error).toBeInstanceOf(BadRequestException)
    expect(error.message).toBe('Invalid query "page"')
    expect(error.details).toEqual([{ path: 'page', message: 'Too big' }])
  })

  it('detects HttpExceptions, also from other copies of the package', () => {
    expect(isHttpException(new NotFoundException())).toBe(true)
    const foreign = Object.assign(new Error('x'), { status: 404, toBody: () => ({}) })
    expect(isHttpException(foreign)).toBe(true)
    expect(isHttpException(new Error('x'))).toBe(false)
    expect(isHttpException({ status: 404, toBody: () => ({}) })).toBe(false)
  })
})

describe('status helpers', () => {
  it('statusText', () => {
    expect(statusText(200)).toBe('OK')
    expect(statusText(418)).toBe("I'm a Teapot")
    expect(statusText(499)).toBe('Client Error')
    expect(statusText(599)).toBe('Server Error')
    expect(statusText(299)).toBe('Unknown Status')
  })

  it('isValidStatus / isBodylessStatus', () => {
    expect(isValidStatus(200)).toBe(true)
    expect(isValidStatus(99)).toBe(false)
    expect(isValidStatus('200')).toBe(false)
    expect(isBodylessStatus(204)).toBe(true)
    expect(isBodylessStatus(304)).toBe(true)
    expect(isBodylessStatus(101)).toBe(true)
    expect(isBodylessStatus(200)).toBe(false)
  })
})

describe('context headers on error replies', () => {
  class Download {
    csv(ctx: HttpContext, mapped: boolean): never {
      ctx.setHeader('content-type', 'text/csv')
      ctx.setHeader('content-length', '5000')
      ctx.setHeader('content-disposition', 'attachment; filename="a.csv"')
      ctx.setHeader('www-authenticate', 'Bearer')
      throw mapped ? new ConflictException('Mapped') : new NotFoundException('The file is gone')
    }
  }
  const meta = metadata({ [t('Download')]: provider(Download) }, [
    controller(t('Download'), '/', [
      route('csv', '/csv', (c: Download, ctx) => c.csv(ctx, false), { params: [{ index: 0, source: 'context' }] }),
      route('mapped', '/mapped', (c: Download, ctx) => c.csv(ctx, true), {
        params: [{ index: 0, source: 'context' }],
      }),
    ]),
  ])
  const mapper = {
    map: (error: unknown) =>
      error instanceof ConflictException ? new HttpResponse({ mapped: true }, { status: 409 }) : undefined,
  }

  for (const { name, create } of ADAPTERS) {
    it(`never carry the representation headers of the failed body (${name})`, async () => {
      const app = await createApp(meta, { adapter: create(), exceptionMappers: [mapper] })
      try {
        const send = viaFetch(app.http)
        for (const [url, status, body] of [
          ['/csv', 404, { statusCode: 404, error: 'Not Found', message: 'The file is gone' }],
          ['/mapped', 409, { mapped: true }],
        ] as const) {
          const response = await send({ method: 'GET', url })
          expect(response.status).toBe(status)
          expect(response.headers['content-type']).toBe('application/json; charset=utf-8')
          expect(response.headers['content-length']).toBe(String(Buffer.byteLength(response.body)))
          expect(response.headers['content-disposition']).toBeUndefined()
          // other headers set on the context are kept (a guard sets www-authenticate and throws)
          expect(response.headers['www-authenticate']).toBe('Bearer')
          expect(JSON.parse(response.body)).toEqual(body)
        }
      } finally {
        await app.stop()
      }
    })
  }
})
