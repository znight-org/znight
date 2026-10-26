/**
 * `TestApp.inject()` with the real `HttpPlugin` (from the sources of `@znight/http`, built-in node
 * adapter): uploads sent as `FormData`, binary downloads read from `response.bytes`. The metadata is
 * what the compiler generates for the controller below (hand-written: `@znight/testing` does not
 * depend on the compiler).
 */
import type { HttpControllerDefinition, HttpRouteDefinition } from '../../http/src/index.ts'

import { silentLogger } from '@znight/core'

import { HttpPlugin, HttpResponse, uploads } from '../../http/src/index.ts'
import { createMetadata, TestApp } from '../src/index.ts'
import { afterEach, beforeEach, describe, expect, test as it } from 'bun:test'

/** 256 bytes: 0x00..0xff (not valid UTF-8). */
const BINARY = Uint8Array.from({ length: 256 }, (_, index) => index)

class FileController {
  readonly stored: File[] = []

  /** `@Post('/avatar') avatar(@UploadedFile('avatar', { maxSize: 64, mimeTypes: ['image/png'] }) avatar: File, @Body() form)` */
  avatar(
    avatar: File,
    form: Record<string, string | string[]>,
  ): { name: string; type: string; size: number; title: unknown } {
    this.stored.push(avatar)
    return { name: avatar.name, type: avatar.type, size: avatar.size, title: form['title'] }
  }

  /** `@Post('/documents') documents(@UploadedFiles('documents') documents: File[])` */
  documents(documents: File[]): Promise<string[]> {
    return Promise.all(documents.map(document => document.text()))
  }

  /** `@Get('/download') download()` */
  download(): HttpResponse {
    return HttpResponse.file(new File([BINARY], 'data.bin', { type: 'application/octet-stream' }), {
      filename: 'data.bin',
    })
  }
}

const TOKEN = 'src/files/file.controller.ts#FileController'

function route(definition: Omit<HttpRouteDefinition, 'guards' | 'interceptors' | 'meta'>): HttpRouteDefinition {
  return { guards: [], interceptors: [], meta: {}, ...definition }
}

const controller: HttpControllerDefinition = {
  token: TOKEN,
  basePath: '/files',
  guards: [],
  interceptors: [],
  meta: {},
  routes: [
    route({
      method: 'POST',
      path: '/avatar',
      fullPath: '/files/avatar',
      handler: 'avatar',
      params: [
        { index: 0, source: 'file', name: 'avatar' },
        { index: 1, source: 'body' },
      ],
      uploads: [{ field: 'avatar', required: true, maxSize: 64, mimeTypes: ['image/png'] }],
      invoke: (c: FileController, ctx) => c.avatar(uploads.file(ctx, 'avatar'), ctx.body as never),
    }),
    route({
      method: 'POST',
      path: '/documents',
      fullPath: '/files/documents',
      handler: 'documents',
      params: [{ index: 0, source: 'files', name: 'documents' }],
      uploads: [{ field: 'documents', multiple: true, required: true }],
      invoke: (c: FileController, ctx) => c.documents(uploads.files(ctx, 'documents')),
    }),
    route({
      method: 'GET',
      path: '/download',
      fullPath: '/files/download',
      handler: 'download',
      params: [],
      invoke: (c: FileController) => c.download(),
    }),
  ],
}

const metadata = createMetadata(
  { [TOKEN]: { scope: 'singleton', class: FileController, deps: [], factory: () => new FileController() } },
  { extensions: { http: { controllers: [controller] } } },
)

function png(size: number, name = 'me.png'): File {
  return new File([new Uint8Array(size)], name, { type: 'image/png' })
}

describe('TestApp.inject with HttpPlugin', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await TestApp.create({ metadata, plugins: [HttpPlugin.configure({ port: 0 })], logger: silentLogger })
  })

  afterEach(() => app.close())

  it('uploads a file with text fields (FormData body)', async () => {
    const form = new FormData()
    form.append('title', 'Me')
    form.append('avatar', png(16))
    const response = await app.inject({ method: 'POST', url: '/files/avatar', body: form })
    expect(response.status).toBe(201)
    expect(response.json()).toEqual({ name: 'me.png', type: 'image/png', size: 16, title: 'Me' })
    expect(app.get(FileController).stored).toHaveLength(1)
  })

  it('enforces the upload rules of the route', async () => {
    const tooLarge = new FormData()
    tooLarge.append('avatar', png(65))
    expect((await app.inject({ method: 'POST', url: '/files/avatar', body: tooLarge })).status).toBe(413)

    const wrongType = new FormData()
    wrongType.append('avatar', new File(['text'], 'me.txt', { type: 'text/plain' }))
    expect((await app.inject({ method: 'POST', url: '/files/avatar', body: wrongType })).status).toBe(415)

    const missing = new FormData()
    missing.append('title', 'Me')
    const response = await app.inject({ method: 'POST', url: '/files/avatar', body: missing })
    expect(response.status).toBe(400)
    expect(response.json()).toMatchObject({ message: 'Missing file "avatar"' })

    const json = await app.inject({ method: 'POST', url: '/files/avatar', body: { avatar: 'nope' } })
    expect(json.status).toBe(415)
  })

  it('uploads several files of one field', async () => {
    const form = new FormData()
    form.append('documents', new File(['a'], 'a.txt', { type: 'text/plain' }))
    form.append('documents', new File(['b'], 'b.txt', { type: 'text/plain' }))
    const response = await app.inject({ method: 'POST', url: '/files/documents', body: form })
    expect(response.status).toBe(201)
    expect(response.json()).toEqual(['a', 'b'])
  })

  it('reads binary downloads from bytes', async () => {
    const response = await app.inject({ url: '/files/download' })
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe('application/octet-stream')
    expect(response.headers['content-disposition']).toBe('attachment; filename="data.bin"')
    expect(response.bytes).toEqual(BINARY)

    const partial = await app.inject({ url: '/files/download', headers: { range: 'bytes=0-15' } })
    expect(partial.status).toBe(206)
    expect(partial.headers['content-range']).toBe('bytes 0-15/256')
    expect(partial.bytes).toEqual(BINARY.slice(0, 16))
  })
})
