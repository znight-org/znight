/**
 * The three GraphQL operations of the load tests, as the runner sends them (`POST /graphql`, a JSON
 * body `{ query, variables }`), and the check of every response body: no `errors` key, and the data
 * that the contract of the applications gives (see benchmarks/README.md).
 *
 * Import-free on purpose: `graphql-load.ts` runs it in the autocannon process (Node.js, type
 * stripping).
 */

export type GraphqlOperation = 'user' | 'books' | 'createUser'

export const GRAPHQL_OPERATIONS: readonly GraphqlOperation[] = ['user', 'books', 'createUser']

export interface OperationSpec {
  readonly query: string
  readonly variables?: Readonly<Record<string, unknown>>
  /** The request body, sent as is. */
  readonly body: string
  /** `true` when a response body is a successful result carrying the expected data. */
  readonly verify: (body: string) => boolean
}

/** Books returned by `books(limit: 20)`: ids 1 to 20, in order. */
export const BOOKS_LIMIT = 20

/** Author of the seeded book `id`: user `((id * 7) % 100) + 1`. */
export function authorOf(bookId: number): number {
  return ((bookId * 7) % 100) + 1
}

type Json = Readonly<Record<string, unknown>>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

/** An object whose keys are exactly `keys`, in that order (graphql-js keeps the selection order). */
function hasKeys(value: unknown, keys: string): value is Json {
  return isObject(value) && Object.keys(value).join(',') === keys
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/** `data[field]` of a result made of `data` only (no `errors`, no `extensions`), or `undefined`. */
function dataOf(body: string, field: string): unknown {
  let result: unknown
  try {
    result = JSON.parse(body)
  } catch {
    return undefined
  }
  if (!hasKeys(result, 'data')) return undefined
  const data = result['data']
  return hasKeys(data, field) ? data[field] : undefined
}

function spec(query: string, verify: (body: string) => boolean, variables?: Json): OperationSpec {
  const request = variables === undefined ? { query } : { query, variables }
  return { query, ...(variables === undefined ? {} : { variables }), body: JSON.stringify(request), verify }
}

export const OPERATION_SPECS: Readonly<Record<GraphqlOperation, OperationSpec>> = {
  user: spec(
    'query User($id: ID!) { user(id: $id) { id name email } }',
    body => {
      const user = dataOf(body, 'user')
      return hasKeys(user, 'id,name,email') && user['id'] === '1' && nonEmpty(user['name']) && nonEmpty(user['email'])
    },
    { id: '1' },
  ),
  books: spec('{ books(limit: 20) { id title year author { id name } } }', body => {
    const books = dataOf(body, 'books')
    if (!Array.isArray(books) || books.length !== BOOKS_LIMIT) return false
    return books.every((book: unknown, index) => {
      if (!hasKeys(book, 'id,title,year,author') || book['id'] !== String(index + 1)) return false
      const author = book['author']
      return (
        nonEmpty(book['title']) &&
        Number.isInteger(book['year']) &&
        hasKeys(author, 'id,name') &&
        author['id'] === String(authorOf(index + 1)) &&
        nonEmpty(author['name'])
      )
    })
  }),
  createUser: spec(
    'mutation Create($input: CreateUserInput!) { createUser(input: $input) { id name email } }',
    body => {
      const user = dataOf(body, 'createUser')
      return (
        hasKeys(user, 'id,name,email') &&
        nonEmpty(user['id']) &&
        user['name'] === 'Ada' &&
        user['email'] === 'ada@example.com'
      )
    },
    { input: { name: 'Ada', email: 'ada@example.com' } },
  ),
}

export function isGraphqlOperation(value: unknown): value is GraphqlOperation {
  return typeof value === 'string' && (GRAPHQL_OPERATIONS as readonly string[]).includes(value)
}
