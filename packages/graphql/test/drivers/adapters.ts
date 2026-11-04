/** The HTTP adapters the driver suites run on (Node.js and Bun alike). */
import type { HttpAdapter } from '@znight/http'

import { expressAdapter } from '@znight/http/express'
import { fastifyAdapter } from '@znight/http/fastify'
import { honoAdapter } from '@znight/http/hono'
import { nodeAdapter } from '@znight/http/node'

export const ADAPTERS: Readonly<Record<string, () => HttpAdapter>> = {
  node: () => nodeAdapter(),
  fastify: () => fastifyAdapter(),
  express: () => expressAdapter(),
  hono: () => honoAdapter(),
}
