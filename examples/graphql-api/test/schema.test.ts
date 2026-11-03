import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildSchema, printSchema } from 'graphql'

import { createTestApp, graphqlOf } from './support/app.js'
import { expect, test as it } from 'bun:test'

const SDL = fileURLToPath(new URL('../schema.graphql', import.meta.url))

/**
 * `schema.graphql` is written by the compiler (`graphql.configure({ sdl })` in znight.config.ts) and
 * committed, so that pull requests show their schema diff and client generators read it without a
 * server. The schema the application serves is the one in the file, byte for byte.
 */
it('serves the schema of the committed schema.graphql', async () => {
  await using app = await createTestApp()
  const file = readFileSync(SDL, 'utf8')

  expect(`${graphqlOf(app).printSchema()}\n`).toBe(file)
  expect(`${printSchema(buildSchema(file))}\n`).toBe(file) // graphql-js prints the file as is
})
