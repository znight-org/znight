import type { ErrorReportEvent, ZnightMetadata } from '@znight/core'
import type { HttpContext } from '../src/index.ts'

import {
  BadRequestException,
  ConflictException,
  HttpResponse,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '../src/index.ts'
import { controller, createApp, metadata, provider, route, sleep, t } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

class DatabaseDown extends Error {}
class Overloaded extends Error {}

/** A 4xx exception whose body cannot be rendered. */
class BrokenBadRequest extends BadRequestException {
  override toBody(): never {
    throw new Error('toBody failure')
  }
}

/** A 5xx exception whose body cannot be rendered. */
class BrokenUnavailable extends ServiceUnavailableException {
  override toBody(): never {
    throw new Error('toBody failure')
  }
}

async function* failingEvents(): AsyncGenerator<{ data: string }> {
  yield { data: 'first' }
  await sleep(1)
  throw new Error('sse failure')
}

class ItemsController {
  get(ctx: HttpContext): unknown {
    switch (ctx.params['id']) {
      case 'sync':
        throw new Error('sync failure')
      case 'async':
        return Promise.reject(new Error('async failure'))
      case 'conflict':
        throw new ConflictException('already exists')
      case 'invalid':
        throw new BadRequestException('bad id')
      case 'unavailable':
        throw new ServiceUnavailableException('maintenance')
      case 'mapped':
        throw new DatabaseDown('db down')
      case 'answered':
        throw new Overloaded('overloaded')
      case 'broken-4xx':
        throw new BrokenBadRequest('bad id')
      case 'broken-5xx':
        throw new BrokenUnavailable('maintenance')
      case 'sse':
        return HttpResponse.sse(failingEvents())
      case 'sse-invalid':
        return HttpResponse.sse([{ data: 'first' }, { event: 'bad\nname', data: 'x' }])
      case 'stream':
        return new ReadableStream({
          pull(controller) {
            controller.error(new Error('stream failure'))
          },
        })
      default:
        return { id: ctx.params['id'] }
    }
  }
}

function itemsMetadata(): ZnightMetadata {
  return metadata({ [t('ItemsController')]: provider(ItemsController) }, [
    controller(t('ItemsController'), '/items', [route('get', '/:id', (c: ItemsController, ctx) => c.get(ctx))]),
  ])
}

async function reportingApp() {
  const app = await createApp(
    itemsMetadata(),
    {
      exceptionMappers: [
        {
          map: (error: unknown) => {
            if (error instanceof DatabaseDown) return new InternalServerErrorException('try again later')
            // a mapper answering itself takes responsibility for the error: not reported
            if (error instanceof Overloaded) return new HttpResponse({ busy: true }, { status: 503 })
            return undefined
          },
        },
      ],
    },
    { start: false },
  )
  const reports: ErrorReportEvent[] = []
  app.app.hooks.on('error:report', report => {
    reports.push(report)
  })
  return { ...app, reports }
}

describe('error:report hook (HTTP)', () => {
  it.each(['sync', 'async'])('reports a %s handler failure once, with the request context', async id => {
    const app = await reportingApp()
    const res = await app.http.inject({ method: 'GET', url: `/items/${id}` })
    expect(res.status).toBe(500)
    expect(app.reports).toHaveLength(1)
    const report = app.reports[0] as ErrorReportEvent
    expect((report.error as Error).message).toBe(`${id} failure`)
    expect(report.source).toBe('http')
    expect(report.operation).toBe('GET /items/:id')
    expect(report.requestId).toBe(res.headers['x-request-id'] as string)
    expect(report.tags).toEqual({
      method: 'GET',
      path: `/items/${id}`,
      route: '/items/:id',
      handler: 'ItemsController.get',
      status: 500,
    })
    expect(String((report.context as HttpContext).requestId)).toBe(String(report.requestId))
    await app.stop()
  })

  it('reports a 5xx HttpException and the original error of a mapper answering a 5xx exception', async () => {
    const app = await reportingApp()
    expect((await app.http.inject({ method: 'GET', url: '/items/unavailable' })).status).toBe(503)
    expect((await app.http.inject({ method: 'GET', url: '/items/mapped' })).status).toBe(500)
    expect(app.reports.map(report => [(report.error as Error).message, report.tags['status']])).toEqual([
      ['maintenance', 503],
      ['db down', 500],
    ])
    expect(app.reports[1]?.error).toBeInstanceOf(DatabaseDown)
    await app.stop()
  })

  it('does not report client errors, unmatched routes nor replies of exception mappers', async () => {
    const app = await reportingApp()
    expect((await app.http.inject({ method: 'GET', url: '/items/conflict' })).status).toBe(409)
    expect((await app.http.inject({ method: 'GET', url: '/items/invalid' })).status).toBe(400)
    expect((await app.http.inject({ method: 'GET', url: '/missing' })).status).toBe(404)
    expect((await app.http.inject({ method: 'DELETE', url: '/items/1' })).status).toBe(405)
    expect((await app.http.inject({ method: 'GET', url: '/items/answered' })).status).toBe(503)
    expect((await app.http.inject({ method: 'GET', url: '/items/1' })).status).toBe(200)
    expect(app.reports).toEqual([])
    await app.stop()
  })

  it('reports a response stream that fails after the reply started', async () => {
    const app = await reportingApp()
    try {
      await app.http.inject({ method: 'GET', url: '/items/stream' })
    } catch {
      // the body fails mid-way: the client may reject
    }
    await sleep(20)
    expect(app.reports).toHaveLength(1)
    const report = app.reports[0] as ErrorReportEvent
    expect((report.error as Error).message).toBe('stream failure')
    expect(report.operation).toBe('GET /items/:id')
    expect(report.tags['status']).toBe(200)
    await app.stop()
  })

  it('reports an event stream whose source fails mid-stream, once', async () => {
    const app = await reportingApp()
    const res = await app.http.injectStream({ method: 'GET', url: '/items/sse' })
    expect(res.status).toBe(200)
    expect(await new Response(res.body).text()).toContain('data: first')
    await sleep(20)
    expect(app.reports).toHaveLength(1)
    const report = app.reports[0] as ErrorReportEvent
    expect((report.error as Error).message).toBe('sse failure')
    expect(report.source).toBe('http')
    expect(report.operation).toBe('GET /items/:id')
    expect(report.requestId).toBe(res.headers['x-request-id'] as string)
    expect(report.tags['status']).toBe(200)
    await app.stop()
  })

  it('reports an event stream whose source yields an invalid event', async () => {
    const app = await reportingApp()
    const res = await app.http.injectStream({ method: 'GET', url: '/items/sse-invalid' })
    expect(res.status).toBe(200)
    await new Response(res.body).text()
    await sleep(20)
    expect(app.reports).toHaveLength(1)
    expect(app.reports[0]?.error).toBeInstanceOf(TypeError)
    await app.stop()
  })

  it('reports the failure of toBody() once, and the exception itself only when it is a 5xx', async () => {
    const app = await reportingApp()
    expect((await app.http.inject({ method: 'GET', url: '/items/broken-4xx' })).status).toBe(500)
    expect(app.reports.map(report => (report.error as Error).message)).toEqual(['toBody failure'])
    expect(app.reports[0]?.tags['status']).toBe(500)
    app.reports.length = 0
    expect((await app.http.inject({ method: 'GET', url: '/items/broken-5xx' })).status).toBe(500)
    expect(app.reports.map(report => [(report.error as Error).message, report.tags['status']])).toEqual([
      ['toBody failure', 500],
      ['maintenance', 503],
    ])
    await app.stop()
  })
})
