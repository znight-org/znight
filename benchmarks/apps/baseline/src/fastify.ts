import { fastify } from 'fastify'

import { CreateUser, createUserService, host, port } from './users.js'

const users = createUserService()
const app = fastify({ logger: false })

// Fastify's documented style: async handlers that return the payload
// biome-ignore lint/suspicious/useAwait: the handler returns a value, Fastify sends it
app.get<{ Params: { id: string } }>('/users/:id', async (request, reply) => {
  const id = Number(request.params.id)
  if (!Number.isInteger(id)) return reply.code(400).send({ message: 'id must be an integer' })
  const user = users.findById(id)
  if (user === undefined) return reply.code(404).send({ message: `User ${id} not found` })
  return user
})

// biome-ignore lint/suspicious/useAwait: the handler returns a value, Fastify sends it
app.post('/users', async (request, reply) => {
  const input = CreateUser.safeParse(request.body)
  if (!input.success) return reply.code(400).send({ message: 'Invalid body', issues: input.error.issues })
  return reply.code(201).send(users.create(input.data))
})

await app.listen({ host, port })
