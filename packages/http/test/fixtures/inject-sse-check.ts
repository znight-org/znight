/**
 * `injectSse()` on event streams that send nothing when they open, executed by
 * `test/inject-sse.test.ts` with Node.js (`node --conditions=@znight/source`) and Bun: boots the
 * quiet application on every adapter (concurrently) and prints what a test observes as JSON.
 */
import type { HttpAdapter } from '../../src/index.ts'

import { Application, silentLogger } from '@znight/core'

import { expressAdapter } from '../../src/adapters/express.ts'
import { fastifyAdapter } from '../../src/adapters/fastify.ts'
import { honoAdapter } from '../../src/adapters/hono.ts'
import { nodeAdapter } from '../../src/adapters/node.ts'
import { HttpPlugin } from '../../src/index.ts'
import { checkQuietStreams, quietSseApp } from '../quiet-sse-app.ts'

async function check(adapter: HttpAdapter): Promise<unknown> {
  const quiet = quietSseApp()
  const http = HttpPlugin.configure({ port: 0, host: '127.0.0.1', adapter })
  const app = await Application.create({
    metadata: quiet.metadata,
    plugins: [http],
    logger: silentLogger,
    shutdown: { signals: false },
  })
  await app.start()
  try {
    return await checkQuietStreams(http, quiet)
  } finally {
    await app.stop()
  }
}

const adapters = [
  ['node', () => nodeAdapter()],
  ['fastify', () => fastifyAdapter()],
  ['express', () => expressAdapter()],
  ['hono', () => honoAdapter()],
] as const
const outcomes = await Promise.all(adapters.map(([, create]) => check(create())))
process.stdout.write(JSON.stringify(Object.fromEntries(adapters.map(([name], index) => [name, outcomes[index]]))))
