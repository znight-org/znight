import type { HttpAdapter } from '@znight/http'

import { HttpPlugin, nodeAdapter } from '@znight/http'

import { createApplication } from './.znight/container.generated.js'

/** The adapter named by `ADAPTER`: the same controllers are served by each of them. */
async function adapter(name = 'node'): Promise<HttpAdapter> {
  switch (name) {
    case 'node':
      return nodeAdapter()
    case 'fastify':
      return (await import('@znight/http/fastify')).fastifyAdapter()
    case 'express':
      return (await import('@znight/http/express')).expressAdapter()
    case 'hono':
      return (await import('@znight/http/hono')).honoAdapter()
    default:
      throw new Error(`Unknown adapter '${name}'`)
  }
}

const app = await createApplication({
  plugins: [
    HttpPlugin.configure({
      adapter: await adapter(process.env['ADAPTER']),
      host: '127.0.0.1',
      port: Number(process.env['PORT'] ?? 3000),
    }),
  ],
})

await app.start()
