import express from 'express'

import { CreateUser, createUserService, host, port } from './users.js'

const users = createUserService()
const app = express()
app.use(express.json())

app.get('/users/:id', (request, response) => {
  const id = Number(request.params.id)
  if (!Number.isInteger(id)) {
    response.status(400).json({ message: 'id must be an integer' })
    return
  }
  const user = users.findById(id)
  if (user === undefined) response.status(404).json({ message: `User ${id} not found` })
  else response.json(user)
})

app.post('/users', (request, response) => {
  const input = CreateUser.safeParse(request.body)
  if (input.success) response.status(201).json(users.create(input.data))
  else response.status(400).json({ message: 'Invalid body', issues: input.error.issues })
})

app.listen(port, host)
