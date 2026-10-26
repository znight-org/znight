/**
 * Streaming over real sockets, on every adapter: backpressure of streamed responses, cancellation
 * of the source when the client disconnects, request-scope disposal after the stream, graceful
 * drain of streamed responses, and early rejection of oversized uploads.
 */
import type { FilesDir } from './files-app.ts'

import http from 'node:http'
import net from 'node:net'

import {
  createFilesDir,
  ENDLESS_CHUNK,
  endless,
  filesMetadata,
  filesOptions,
  filesState,
  streamLog,
} from './files-app.ts'
import { ADAPTERS, createApp, sleep, type TestApp } from './helpers.ts'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'

let dir: FilesDir

beforeAll(() => {
  dir = createFilesDir()
  filesState.dir = dir
})

afterAll(() => {
  dir.cleanup()
})

/** Polls `condition` every 10 ms (fails after `timeout` ms). */
async function until(condition: () => boolean, timeout = 3000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeout) throw new Error('condition not met in time')
    await sleep(10)
  }
}

/** Sends raw bytes and resolves with what the server answered (up to `bytes` bytes, or the end). */
function rawExchange(port: number, chunks: readonly (string | Uint8Array)[], bytes = 4096): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    let received = ''
    const done = (): void => {
      socket.destroy()
      resolve(received)
    }
    socket.on('connect', () => {
      for (const chunk of chunks) socket.write(chunk)
    })
    socket.on('data', data => {
      received += data.toString('latin1')
      if (received.length >= bytes || /\r\n\r\n[\s\S]*\}$/.test(received)) done()
    })
    socket.on('end', done)
    socket.on('error', error => (received === '' ? reject(error) : done()))
    setTimeout(done, 3000)
  })
}

for (const adapter of ADAPTERS) {
  describe(`${adapter.name} adapter (real sockets)`, () => {
    let app: TestApp

    afterEach(async () => {
      await app?.stop()
    })

    async function start(options: Parameters<typeof createApp>[1] = {}): Promise<number> {
      app = await createApp(filesMetadata(), { ...filesOptions(), adapter: adapter.create(), ...options })
      return app.http.address?.port as number
    }

    it('respects backpressure, cancels the source when the client disconnects, then disposes the scope', async () => {
      const port = await start()
      endless.pulled = 0
      endless.cancelled = false
      endless.disposedAt = undefined
      const before = streamLog.length
      let received = 0
      const request = http.get({ host: '127.0.0.1', port, path: '/scoped/endless' }, response => {
        response.once('data', chunk => {
          received += chunk.length
          response.pause() // a slow client: stop reading
        })
      })
      request.on('error', () => undefined)
      await until(() => received > 0)
      await sleep(300)
      const pulled = endless.pulled
      // bounded by socket buffers and stream high-water marks, not by the (endless) source
      expect(pulled).toBeLessThan(200)
      await sleep(100)
      expect(endless.pulled - pulled).toBeLessThanOrEqual(2)
      expect(app.http.inflight).toBe(1)
      const events = streamLog.slice(before)
      expect(events.some(event => event.startsWith('dispose'))).toBe(false)

      request.destroy()
      await until(() => endless.cancelled && app.http.inflight === 0)
      await until(() => streamLog.slice(before).some(event => event.startsWith('dispose')))
      const order = streamLog.slice(before).map(event => event.split(' ')[0])
      expect(order).toEqual(['endless', 'cancel', 'dispose'])
      expect(endless.pulled * ENDLESS_CHUNK).toBeGreaterThan(0)
    })

    it('keeps a streamed response in flight during the graceful drain', async () => {
      await start()
      const pending = fetch(`${String(app.http.address)}/scoped/chunks`).then(response => response.text())
      await until(() => app.http.inflight === 1)
      const stopping = app.stop()
      expect(await pending).toBe('0:alive;1:alive;2:alive;')
      await stopping
      expect(app.http.inflight).toBe(0)
    })

    it('force-closes streams still running after drainTimeoutMs and cancels their source', async () => {
      const port = await start({ drainTimeoutMs: 150 })
      endless.cancelled = false
      const request = http.get({ host: '127.0.0.1', port, path: '/scoped/endless' }, response => {
        response.pause()
      })
      request.on('error', () => undefined)
      await until(() => app.http.inflight === 1)
      const started = Date.now()
      await app.stop()
      expect(Date.now() - started).toBeGreaterThanOrEqual(100)
      await until(() => endless.cancelled)
      expect(app.logger.entries.some(entry => entry.message.includes('in-flight request'))).toBe(true)
    })

    it('rejects an oversized upload from its declared length without reading it', async () => {
      const port = await start()
      const response = await rawExchange(port, [
        'POST /upload/avatar HTTP/1.1\r\nHost: x\r\nContent-Type: multipart/form-data; boundary=b\r\n' +
          'Content-Length: 10485760\r\n\r\n',
        '--b\r\nContent-Disposition: form-data; name="avatar"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n',
        new Uint8Array(1024),
      ])
      expect(response).toStartWith('HTTP/1.1 413')
      expect(response.toLowerCase()).toContain('connection: close')
      expect(response).toContain('Request body exceeds the limit of 2112 bytes')
    })

    it('rejects a file above maxSize while the body is still being sent (chunked upload)', async () => {
      const port = await start()
      const head =
        '--b\r\nContent-Disposition: form-data; name="title"\r\n\r\nMe\r\n' +
        '--b\r\nContent-Disposition: form-data; name="avatar"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n'
      const chunk = (data: string | Uint8Array): Uint8Array => {
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
        const size = new TextEncoder().encode(`${bytes.byteLength.toString(16)}\r\n`)
        const result = new Uint8Array(size.byteLength + bytes.byteLength + 2)
        result.set(size)
        result.set(bytes, size.byteLength)
        result.set([13, 10], size.byteLength + bytes.byteLength)
        return result
      }
      // the body never ends: the server answers as soon as the file exceeds 64 bytes
      const response = await rawExchange(port, [
        'POST /upload/avatar HTTP/1.1\r\nHost: x\r\nContent-Type: multipart/form-data; boundary=b\r\n' +
          'Transfer-Encoding: chunked\r\n\r\n',
        chunk(head),
        chunk(new Uint8Array(100).fill(1)),
      ])
      expect(response).toStartWith('HTTP/1.1 413')
      expect(response).toContain('File in field \\"avatar\\" exceeds the maximum size of 64 bytes')
    })

    it('reads a streamed raw body (ctx.bodyStream) as it arrives', async () => {
      const port = await start()
      const response = await new Promise<string>((resolve, reject) => {
        const request = http.request(
          { host: '127.0.0.1', port, path: '/upload/raw', method: 'PUT', headers: { 'transfer-encoding': 'chunked' } },
          res => {
            let text = ''
            res.on('data', chunk => {
              text += chunk
            })
            res.on('end', () => resolve(text))
          },
        )
        request.on('error', reject)
        let sent = 0
        const write = (): void => {
          if (sent === 10) {
            request.end()
            return
          }
          sent++
          request.write(new Uint8Array(1000).fill(1))
          setTimeout(write, 5)
        }
        write()
      })
      expect(JSON.parse(response)).toEqual({ size: 10_000, sum: 10_000 })
    })
  })
}
