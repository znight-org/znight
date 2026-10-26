/**
 * Files runtime check executed by `test/files-runtime.test.ts` with Node.js
 * (`node --conditions=@znight/source`) and Bun: serves the files application on every adapter and
 * prints, as JSON, what uploads, downloads and streams answer over the network and in memory, plus
 * what happens when a client disconnects from a stream and when an oversized upload is announced.
 */
import type { InjectRequest, InjectResponse } from '../../src/index.ts'

import http from 'node:http'
import net from 'node:net'

import { createFilesDir, endless, filesMetadata, filesOptions, filesState, streamLog } from '../files-app.ts'
import { ADAPTERS, createApp, sleep, viaFetch, viaInject } from '../helpers.ts'

const ETAG = `"${Date.parse('2024-05-06T07:08:09Z').toString(16)}-12c"`

function form(entries: readonly [string, string | File][]): FormData {
  const data = new FormData()
  for (const [name, value] of entries) data.append(name, value)
  return data
}

const png = (size = 4): File => new File([new Uint8Array(size).fill(80)], 'me.png', { type: 'image/png' })

function requests(): InjectRequest[] {
  return [
    {
      method: 'POST',
      url: '/upload/avatar',
      body: form([
        ['title', 'Me'],
        ['tags', 'a'],
        ['tags', 'b'],
        ['avatar', png()],
      ]),
    },
    { method: 'POST', url: '/upload/avatar', body: form([['avatar', png(65)]]) },
    {
      method: 'POST',
      url: '/upload/avatar',
      body: form([['avatar', new File(['x'], 'x.txt', { type: 'text/plain' })]]),
    },
    { method: 'POST', url: '/upload/avatar', body: { title: 'Me' } },
    { method: 'POST', url: '/upload/avatar', body: form([['title', 'Me']]) },
    {
      method: 'POST',
      url: '/upload/many',
      body: form([
        ['documents', new File(['1'], '1.txt')],
        ['documents', new File(['2'], '2.txt')],
        ['documents', new File(['3'], '3.txt')],
      ]),
    },
    {
      method: 'PUT',
      url: '/upload/any',
      body: form([
        ['a', new File(['1'], 'é 1.txt', { type: 'application/x-one' })],
        ['b', new File(['2'], '2.txt', { type: 'application/x-two' })],
      ]),
    },
    {
      method: 'POST',
      url: '/upload/avatar',
      body: '--x\r\nContent-Disposition: form-data; name="title"\r\n\r\nMe\r\n',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
    },
    { method: 'PUT', url: '/upload/raw', body: new Uint8Array(50_000).fill(3) },
    { method: 'GET', url: '/download/public/sample.txt' },
    { method: 'HEAD', url: '/download/public/sample.txt' },
    { method: 'GET', url: '/download/public/sample.txt', headers: { 'if-none-match': ETAG } },
    { method: 'GET', url: '/download/public/sample.txt', headers: { range: 'bytes=10-14' } },
    { method: 'GET', url: '/download/public/sample.txt', headers: { range: 'bytes=1000-' } },
    { method: 'GET', url: '/download/public/..%2Fsecret.txt' },
    { method: 'GET', url: '/download/attachment' },
    { method: 'GET', url: '/download/blob', headers: { range: 'bytes=1-4' } },
    { method: 'GET', url: '/download/stream/iterable' },
    { method: 'GET', url: '/download/stream/readable' },
    { method: 'GET', url: '/scoped/chunks' },
  ]
}

const HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'content-disposition',
  'etag',
  'last-modified',
  'accept-ranges',
] as const

interface Observed {
  readonly status: number
  readonly body: string
  readonly headers: Record<string, string>
}

function observe(request: InjectRequest, response: InjectResponse): Observed {
  const headers: Record<string, string> = {}
  for (const name of HEADERS) {
    const value = response.headers[name]
    // Bun adds `;charset=utf-8` to the type of `application/json` File objects
    if (value !== undefined) headers[name] = value.replace(/;charset=utf-8$/, '')
  }
  // streams have no declared length: servers send them chunked, or with the length when they could
  // buffer the whole (short) stream at once. Compare the bytes received instead.
  if (request.url.startsWith('/download/stream/') || request.url.startsWith('/scoped/')) {
    delete headers['content-length']
    headers['received'] = String(response.bytes.byteLength)
  }
  return { status: response.status, body: response.body, headers }
}

/** A client that reads one chunk of an endless stream, stalls, then disconnects. */
async function abort(port: number): Promise<{ bounded: boolean; order: string[] }> {
  endless.pulled = 0
  endless.cancelled = false
  const before = streamLog.length
  let received = false
  const request = http.get({ host: '127.0.0.1', port, path: '/scoped/endless' }, response => {
    response.once('data', () => {
      received = true
      response.pause()
    })
  })
  request.on('error', () => undefined)
  while (!received) await sleep(10)
  await sleep(200)
  const bounded = endless.pulled < 200
  request.destroy()
  for (let index = 0; index < 300 && !streamLog.slice(before).some(event => event.startsWith('dispose')); index++) {
    await sleep(10)
  }
  return { bounded, order: streamLog.slice(before).map(event => event.split(' ')[0] as string) }
}

/** Announces a 10 MiB upload and returns the status line received after sending 1 KiB of it. */
function announceLargeUpload(port: number): Promise<string> {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        'POST /upload/avatar HTTP/1.1\r\nHost: x\r\nContent-Type: multipart/form-data; boundary=b\r\n' +
          'Content-Length: 10485760\r\n\r\n',
      )
      socket.write(new Uint8Array(1024))
    })
    let received = ''
    const done = (): void => {
      socket.destroy()
      resolve(received.split('\r\n')[0] ?? '')
    }
    socket.on('data', data => {
      received += data.toString('latin1')
      if (received.includes('\r\n')) done()
    })
    socket.on('error', done)
    socket.on('end', done)
    setTimeout(done, 3000)
  })
}

const dir = createFilesDir()
filesState.dir = dir
const results: Record<string, unknown> = {}
for (const adapter of ADAPTERS) {
  const app = await createApp(filesMetadata(), { ...filesOptions(), adapter: adapter.create() })
  const network: Observed[] = []
  const inject: Observed[] = []
  for (const request of requests()) network.push(observe(request, await viaFetch(app.http)(request)))
  for (const request of requests()) inject.push(observe(request, await viaInject(app.http)(request)))
  const port = app.http.address?.port as number
  results[adapter.name] = { network, inject, abort: await abort(port), early: await announceLargeUpload(port) }
  await app.stop()
}
dir.cleanup()
process.stdout.write(JSON.stringify(results))
