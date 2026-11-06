/**
 * graphql-js 17 on node:http, wired by hand: the schema built with the graphql-js type classes, each
 * distinct query text parsed and validated once (an unbounded map: the benchmark sends three
 * documents), then `execute()` with a fresh context (its DataLoader) per request. On Bun too, through
 * Bun's node:http.
 */
import type { DocumentNode, ExecutionResult, GraphQLFormattedError } from 'graphql'

import { createServer, type ServerResponse } from 'node:http'
import {
  buildSchema,
  execute,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  lexicographicSortSchema,
  parse,
  printSchema,
  validate,
} from 'graphql'

import { createContext, createResolvers, createServices, host, port, typeDefs } from './catalog.js'

const services = createServices()
const resolvers = createResolvers(services)

const User = new GraphQLObjectType({
  name: 'User',
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    email: { type: new GraphQLNonNull(GraphQLString) },
  },
})

const Book = new GraphQLObjectType({
  name: 'Book',
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    title: { type: new GraphQLNonNull(GraphQLString) },
    year: { type: new GraphQLNonNull(GraphQLInt) },
    author: { type: new GraphQLNonNull(User), resolve: resolvers.Book.author },
  },
})

const CreateUserInput = new GraphQLInputObjectType({
  name: 'CreateUserInput',
  fields: {
    name: { type: new GraphQLNonNull(GraphQLString) },
    email: { type: new GraphQLNonNull(GraphQLString) },
  },
})

const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'Query',
    fields: {
      user: { type: User, args: { id: { type: new GraphQLNonNull(GraphQLID) } }, resolve: resolvers.Query.user },
      books: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(Book))),
        args: { limit: { type: new GraphQLNonNull(GraphQLInt) } },
        resolve: resolvers.Query.books,
      },
    },
  }),
  mutation: new GraphQLObjectType({
    name: 'Mutation',
    fields: {
      createUser: {
        type: new GraphQLNonNull(User),
        args: { input: { type: new GraphQLNonNull(CreateUserInput) } },
        resolve: resolvers.Mutation.createUser,
      },
    },
  }),
})

// The same schema as every other application: fail at boot otherwise
if (printSchema(lexicographicSortSchema(schema)) !== printSchema(lexicographicSortSchema(buildSchema(typeDefs)))) {
  throw new Error('The graphql-js schema differs from the benchmark SDL')
}

/** A parsed and validated document, or the errors to answer. */
type Prepared = { readonly document: DocumentNode } | { readonly errors: readonly GraphQLFormattedError[] }

const documents = new Map<string, Prepared>()

function prepare(query: string): Prepared {
  let prepared = documents.get(query)
  if (prepared === undefined) {
    try {
      const document = parse(query)
      const errors = validate(schema, document)
      prepared = errors.length > 0 ? { errors: errors.map(error => error.toJSON()) } : { document }
    } catch (error) {
      prepared = { errors: [{ message: error instanceof Error ? error.message : String(error) }] }
    }
    documents.set(query, prepared)
  }
  return prepared
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
  })
  response.end(json)
}

interface Body {
  readonly query?: unknown
  readonly variables?: unknown
  readonly operationName?: unknown
}

/** The result of one operation: synchronous when no resolver returns a promise. */
function run(
  body: Body,
): ExecutionResult | Promise<ExecutionResult> | { readonly errors: readonly GraphQLFormattedError[] } {
  const prepared = prepare(body.query as string)
  if ('errors' in prepared) return prepared
  return execute({
    schema,
    document: prepared.document,
    variableValues: (body.variables ?? undefined) as Record<string, unknown> | undefined,
    operationName: typeof body.operationName === 'string' ? body.operationName : undefined,
    contextValue: createContext(services),
  })
}

const server = createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/graphql') return send(response, 404, { message: 'Not found' })
  const chunks: Buffer[] = []
  request.on('data', (chunk: Buffer) => chunks.push(chunk))
  request.on('end', () => {
    let body: Body
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body
    } catch {
      return send(response, 400, { errors: [{ message: 'Invalid JSON' }] })
    }
    if (typeof body !== 'object' || body === null || typeof body.query !== 'string') {
      return send(response, 400, { errors: [{ message: 'A query is required' }] })
    }
    Promise.resolve(run(body)).then(
      result => send(response, 200, result),
      (error: unknown) => send(response, 500, { errors: [{ message: String(error) }] }),
    )
  })
})

server.listen(port, host)
