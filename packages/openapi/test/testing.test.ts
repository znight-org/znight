/** `validateResponse` of `@znight/openapi/testing`: statuses, media types, headers, bodies, readable paths. */
import type { ZnightMetadata } from '@znight/core'
import type { OpenApiObject } from '../src/index.ts'

import { silentLogger } from '@znight/core'
import { HttpPlugin } from '@znight/http'
import { TestApp } from '@znight/testing'

import { OpenApi, OpenApiPlugin } from '../src/index.ts'
import { validateResponse } from '../src/testing.ts'
import { bookshelfMetadata, cleanupApps } from './support/apps.ts'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

let metadata: ZnightMetadata
let app: TestApp
let document: OpenApiObject

beforeAll(async () => {
  metadata = await bookshelfMetadata()
  app = await TestApp.create({
    metadata,
    plugins: [HttpPlugin.configure({ port: 0 }), OpenApiPlugin.configure({ ui: false })],
    logger: silentLogger,
  })
  document = await app.get(OpenApi).document()
})

afterAll(async () => {
  await app?.close()
  cleanupApps()
})

describe('validateResponse', () => {
  it('accepts a documented error response of the running application (400 through components.responses)', async () => {
    const response = await app.inject({ method: 'GET', url: '/books/abc' })
    expect(response.status).toBe(400)
    expect(validateResponse(document, { method: 'GET', path: '/books/{id}', response })).toEqual([])
  })

  it('reports body mismatches with readable paths and the failing keyword', async () => {
    const response = await app.inject({ method: 'GET', url: '/books/7' })
    expect(response.json()).toEqual({ id: 7 })
    expect(validateResponse(document, { method: 'GET', path: '/books/{id}', response })).toContainEqual({
      path: 'body',
      keyword: 'required',
      message: 'Instance does not have required property "createdAt".',
    })
    const nested = {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ id: 'x' }], total: 1, limit: 1, offset: 0 }),
    }
    const issues = validateResponse(document, { method: 'GET', path: '/books', response: nested })
    expect(issues).toContainEqual({
      path: 'body.items[0].id',
      keyword: 'type',
      message: 'Instance type "string" is invalid. Expected "integer".',
    })
  })

  it('matches statuses: exact code, then NXX, then default; reports undocumented ones', () => {
    const ok = { status: 418, headers: {}, body: '' }
    expect(validateResponse(document, { method: 'GET', path: '/books/{id}', response: ok })).toEqual([
      { path: 'status', keyword: 'status', message: 'The status 418 is not documented (documented: 200, 400, 404)' },
    ])
    const ranged: OpenApiObject = {
      openapi: '3.1.1',
      info: { title: 't', version: '1' },
      paths: { '/x': { get: { responses: { '4XX': { description: 'Client' }, default: { description: 'Other' } } } } },
    }
    expect(
      validateResponse(ranged, { method: 'get', path: '/x', response: { status: 404, headers: {}, body: '' } }),
    ).toEqual([])
    expect(
      validateResponse(ranged, { method: 'get', path: '/x', response: { status: 500, headers: {}, body: '' } }),
    ).toEqual([])
    expect(validateResponse(ranged, { method: 'get', path: '/y', response: ok })).toEqual([
      { path: 'operation', keyword: 'operation', message: 'GET /y is not documented' },
    ])
  })

  it('checks media types (ranges included), bodies of bodiless responses, required headers and JSON syntax', () => {
    const cover = { status: 200, headers: { 'content-type': 'image/png' }, body: 'png' }
    expect(validateResponse(document, { method: 'GET', path: '/books/{id}/cover', response: cover })).toEqual([])
    const text = { status: 200, headers: { 'content-type': 'text/plain' }, body: 'x' }
    expect(validateResponse(document, { method: 'GET', path: '/books/{id}/cover', response: text })).toEqual([
      {
        path: 'headers.content-type',
        keyword: 'media-type',
        message: 'The media type text/plain is not documented (documented: image/png, image/jpeg)',
      },
    ])
    expect(
      validateResponse(document, {
        method: 'DELETE',
        path: '/books/{id}',
        response: { status: 204, headers: {}, body: 'x' },
      }),
    ).toEqual([
      { path: 'body', keyword: 'content', message: 'The 204 response is documented without body, but it has one' },
    ])
    const broken = { status: 200, headers: { 'content-type': 'application/json' }, body: '{' }
    expect(validateResponse(document, { method: 'GET', path: '/books/{id}', response: broken })).toEqual([
      { path: 'body', keyword: 'json', message: 'The body is not valid JSON' },
    ])
    const headers: OpenApiObject = {
      openapi: '3.1.1',
      info: { title: 't', version: '1' },
      paths: {
        '/x': {
          post: {
            responses: {
              '201': { description: 'Created', headers: { Location: { required: true, schema: { type: 'string' } } } },
            },
          },
        },
      },
    }
    expect(
      validateResponse(headers, { method: 'POST', path: '/x', response: { status: 201, headers: {}, body: '' } }),
    ).toEqual([{ path: 'headers.location', keyword: 'header', message: 'The documented header "Location" is missing' }])
  })
})
