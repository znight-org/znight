/**
 * End-to-end test (opt-in, `ZNIGHT_E2E=1`, `bun run test:e2e`): builds the application with
 * `znight build`, starts the bundle with Node.js (the npm `ws` transport) and with Bun (its
 * built-in `ws`) as a separate process, chats over real WebSockets, then sends SIGTERM: the clients
 * receive `1001` and the process exits with code 0.
 *
 * In this repository the build imports the @znight/* packages from their `dist`: run
 * `bun run build` at the repository root first.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectWebSocket } from '@znight/testing'

import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

const ENABLED = process.env.ZNIGHT_E2E === '1'
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TIMEOUT = 60_000

function run(command: string, args: readonly string[]): Promise<{ code: number | null; output: string }> {
  return new Promise(resolve => {
    const child = spawn(command, [...args], { cwd: ROOT, env: { ...process.env, NO_COLOR: '1' } })
    let output = ''
    child.stdout.on('data', chunk => {
      output += chunk
    })
    child.stderr.on('data', chunk => {
      output += chunk
    })
    child.once('exit', code => resolve({ code, output }))
  })
}

/** A free TCP port of the loopback interface. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0))
    })
  })
}

describe.skipIf(!ENABLED)('end to end (production build)', () => {
  const running: ChildProcess[] = []

  beforeAll(async () => {
    const cli = join(ROOT, 'node_modules/@znight/cli/dist/cli.mjs')
    if (!existsSync(cli))
      throw new Error('The @znight/* packages are not built: run `bun run build` at the repository root')
    const build = await run('node', [cli, 'build'])
    if (build.code !== 0) throw new Error(`znight build failed:\n${build.output}`)
  }, TIMEOUT)

  afterAll(() => {
    for (const child of running) if (child.exitCode === null) child.kill('SIGKILL')
  })

  it.each(['node', 'bun'] as const)(
    'chats over real WebSockets on %s and closes with 1001 on SIGTERM',
    async runtime => {
      const port = await freePort()
      const child = spawn(runtime, ['dist/main.js'], {
        cwd: ROOT,
        env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      running.push(child)
      let output = ''
      child.stdout?.on('data', chunk => {
        output += chunk
      })
      child.stderr?.on('data', chunk => {
        output += chunk
      })
      const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)))
      const url = `127.0.0.1:${port}`
      const deadline = Date.now() + TIMEOUT
      while (
        !(await fetch(`http://${url}/health`).then(
          r => r.ok,
          () => false,
        ))
      ) {
        if (Date.now() > deadline || child.exitCode !== null)
          throw new Error(`The application did not start:\n${output}`)
        await Bun.sleep(100)
      }
      const alice = await connectWebSocket(`ws://${url}/chat`, {
        headers: { 'x-api-key': 'alice-key' },
        protocols: ['chat.v1'],
      })
      const bob = await connectWebSocket(`ws://${url}/chat`, {
        headers: { 'x-api-key': 'bob-key' },
        protocols: ['chat.v1'],
      })
      expect(await alice.request('room.join', { room: 'general' })).toEqual({ members: 1 })
      expect(await bob.request('room.join', { room: 'general' })).toEqual({ members: 2 })
      const sent = await alice.request('message.send', { room: 'general', text: 'hello' })
      expect(await bob.next('message.new')).toEqual(sent)
      child.kill('SIGTERM')
      expect(await alice.closed).toEqual({ code: 1001, reason: 'Server shutting down' })
      expect((await bob.closed).code).toBe(1001)
      expect(await exited).toBe(0)
    },
    TIMEOUT,
  )
})
