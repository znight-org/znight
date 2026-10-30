import { Hono } from 'hono'

import { CreateUser, createUserService, host, port } from './users.js'

const users = createUserService()
const app = new Hono()

app.get('/users/:id', c => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ message: 'id must be an integer' }, 400)
  const user = users.findById(id)
  if (user === undefined) return c.json({ message: `User ${id} not found` }, 404)
  return c.json(user)
})

app.post('/users', async c => {
  const input = CreateUser.safeParse(await c.req.json().catch(() => undefined))
  if (!input.success) return c.json({ message: 'Invalid body', issues: input.error.issues }, 400)
  return c.json(users.create(input.data), 201)
})

/** `Bun.serve()` on Bun, `@hono/node-server` on Node.js: like the Znight Hono adapter. */
interface BunRuntime {
  serve(options: { fetch: typeof app.fetch; hostname: string; port: number }): unknown
}
const bun = (globalThis as { Bun?: BunRuntime }).Bun
if (bun === undefined) {
  const { serve } = await import('@hono/node-server')
  serve({ fetch: app.fetch, hostname: host, port })
} else {
  bun.serve({ fetch: app.fetch, hostname: host, port })
}
