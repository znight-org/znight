import { createServer, type ServerResponse } from 'node:http'

import { CreateUser, createUserService, host, port } from './users.js'

const users = createUserService()

function send(response: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
  })
  response.end(json)
}

const server = createServer((request, response) => {
  const url = request.url ?? '/'
  if (request.method === 'GET' && url.startsWith('/users/')) {
    const id = Number(url.slice('/users/'.length))
    if (!Number.isInteger(id)) return send(response, 400, { message: 'id must be an integer' })
    const user = users.findById(id)
    if (user === undefined) return send(response, 404, { message: `User ${id} not found` })
    return send(response, 200, user)
  }
  if (request.method === 'POST' && url === '/users') {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      let body: unknown
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        return send(response, 400, { message: 'Invalid JSON' })
      }
      const input = CreateUser.safeParse(body)
      if (!input.success) return send(response, 400, { message: 'Invalid body', issues: input.error.issues })
      return send(response, 201, users.create(input.data))
    })
    return
  }
  send(response, 404, { message: 'Not found' })
})

server.listen(port, host)
