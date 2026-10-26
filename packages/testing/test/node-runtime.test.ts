/**
 * The sources run unchanged on Node.js >= 24 (type stripping): without a test framework in scope,
 * mocks use the built-in spy.
 */

import { fileURLToPath } from 'node:url'

import { expect, test as it } from 'bun:test'

const node = Bun.which('node')
const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url))

const script = `
const { createMock, defineTestMetadata, detectMockFn, TestApp, TestBed } = await import(${JSON.stringify(entry)})
class Repository { find(id) { return id } }
class Service {
  constructor(repository) { this.repository = repository }
  get(id) { return this.repository.find(id) }
}
const metadata = defineTestMetadata({ providers: [Repository, { class: Service, deps: [Repository] }] })
const { instance, mocks } = await TestBed.create(Service, { metadata })
mocks.get(Repository).find.mockReturnValue('mocked')
const mock = createMock()
const app = await TestApp.create({ metadata })
const result = {
  source: detectMockFn().source,
  value: instance.get('1'),
  calls: mocks.get(Repository).find.mock.calls,
  awaited: (await mock) === mock,
  real: app.get(Service).get('2'),
  state: app.app.state,
}
await app.close()
console.log(JSON.stringify(result))
`

it.skipIf(node === null)('runs on Node.js with the built-in spy', () => {
  const run = Bun.spawnSync([node as string, '--conditions=@znight/source', '--input-type=module', '-e', script], {
    stderr: 'pipe',
  })
  expect(run.stderr.toString()).toBe('')
  expect(run.exitCode).toBe(0)
  expect(JSON.parse(run.stdout.toString())).toEqual({
    source: 'builtin',
    value: 'mocked',
    calls: [['1']],
    awaited: true,
    real: '2',
    state: 'ready',
  })
})

const http = fileURLToPath(new URL('../../http/src/index.ts', import.meta.url))

const httpScript = `
const { createMetadata, TestApp } = await import(${JSON.stringify(entry)})
const { HttpPlugin, HttpResponse, uploads } = await import(${JSON.stringify(http)})
class Files {
  upload(file, form) { return { name: file.name, size: file.size, title: form.title } }
  download() { return HttpResponse.file(new File([new Uint8Array([0, 255, 128])], 'x.bin')) }
}
const token = 'src/files.ts#Files'
const route = { guards: [], interceptors: [], meta: {} }
const metadata = createMetadata(
  { [token]: { scope: 'singleton', class: Files, deps: [], factory: () => new Files() } },
  {
    extensions: {
      http: {
        controllers: [{ token, basePath: '/', guards: [], interceptors: [], meta: {}, routes: [
          { ...route, method: 'POST', path: '/upload', fullPath: '/upload', handler: 'upload',
            params: [{ index: 0, source: 'file', name: 'file' }, { index: 1, source: 'body' }],
            uploads: [{ field: 'file', required: true }],
            invoke: (c, ctx) => c.upload(uploads.file(ctx, 'file'), ctx.body) },
          { ...route, method: 'GET', path: '/download', fullPath: '/download', handler: 'download', params: [],
            invoke: c => c.download() },
        ] }],
      },
    },
  },
)
const app = await TestApp.create({ metadata, plugins: [HttpPlugin.configure({ port: 0 })] })
const form = new FormData()
form.append('title', 'Me')
form.append('file', new File(['hello'], 'a.txt', { type: 'text/plain' }))
const uploaded = await app.inject({ method: 'POST', url: '/upload', body: form })
const downloaded = await app.inject({ url: '/download' })
await app.close()
console.log(JSON.stringify({ status: uploaded.status, upload: uploaded.json(), bytes: [...downloaded.bytes] }))
`

it.skipIf(node === null)('TestApp.inject sends FormData uploads and reads bytes on Node.js', () => {
  const run = Bun.spawnSync([node as string, '--conditions=@znight/source', '--input-type=module', '-e', httpScript], {
    stderr: 'pipe',
  })
  expect(run.stderr.toString()).toBe('')
  expect(run.exitCode).toBe(0)
  expect(JSON.parse(run.stdout.toString())).toEqual({
    status: 201,
    upload: { name: 'a.txt', size: 5, title: 'Me' },
    bytes: [0, 255, 128],
  })
})
