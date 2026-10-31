/**
 * Request body check executed by `test/body-abort-runtime.test.ts` with Node.js
 * (`node --conditions=@znight/source`) and Bun: on every adapter, a client that leaves in the middle
 * of a body releases the request (no handler call, nothing left in flight), and the server then
 * serves the next requests, whose bodies arrive in one or several chunks. Prints the results as JSON.
 */
import net from 'node:net'

import { ADAPTERS, controller, createApp, metadata, provider, route, sleep, t } from '../helpers.ts'

let calls = 0

class EchoController {
  echo(body: unknown) {
    calls++
    return { body }
  }
}

const meta = metadata({ [t('EchoController')]: provider(EchoController) }, [
  controller(t('EchoController'), '/echo', [
    route('echo', '/', (c: EchoController, ctx) => c.echo(ctx.body), {
      method: 'POST',
      params: [{ index: 0, source: 'body' }],
    }),
  ]),
])

async function until(condition: () => boolean, timeout = 3000): Promise<boolean> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeout) return false
    await sleep(10)
  }
  return true
}

/** Writes `parts` with a pause between them and resolves with the raw response. */
function exchange(port: number, parts: readonly string[]): Promise<string> {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1')
    let received = ''
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(`${received} [timeout]`)
    }, 4000)
    socket.on('connect', async () => {
      for (const part of parts) {
        socket.write(part)
        await sleep(20)
      }
    })
    socket.on('data', data => {
      received += data.toString('latin1')
    })
    socket.on('close', () => {
      clearTimeout(timer)
      resolve(received)
    })
    socket.on('error', () => undefined)
  })
}

/** Status and body of a raw response. */
function summary(response: string): string {
  const status = /^HTTP\/1\.1 (\d{3})/.exec(response)?.[1] ?? response
  return `${status} ${response.slice(response.indexOf('\r\n\r\n') + 4)}`
}

const results: Record<string, unknown> = {}

for (const adapter of ADAPTERS) {
  calls = 0
  const app = await createApp(meta, { adapter: adapter.create() })
  const port = app.http.address?.port as number
  // the client leaves after 10 of 100 bytes
  const socket = net.connect(port, '127.0.0.1')
  socket.on('error', () => undefined)
  socket.write('POST /echo HTTP/1.1\r\nHost: x\r\ncontent-type: text/plain\r\ncontent-length: 100\r\n\r\n0123456789')
  const reading = await until(() => app.http.inflight === 1)
  socket.destroy()
  const released = await until(() => app.http.inflight === 0)
  const head = 'POST /echo HTTP/1.1\r\nHost: x\r\ncontent-type: text/plain\r\nConnection: close\r\n'
  const whole = await exchange(port, [`${head}content-length: 5\r\n\r\nhello`])
  const chunked = await exchange(port, [`${head}content-length: 9\r\n\r\nhello`, ' you'])
  const encoded = await exchange(port, [
    `${head}transfer-encoding: chunked\r\n\r\n3\r\nabc\r\n`,
    '2\r\nde\r\n0\r\n\r\n',
  ])
  results[adapter.name] = {
    reading,
    released,
    calls,
    next: [summary(whole), summary(chunked), summary(encoded)],
  }
  await app.stop()
}

process.stdout.write(JSON.stringify(results))
process.exit(0)
