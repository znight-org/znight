/**
 * The users and books of the hand-wired GraphQL baselines: the same repositories, services, schema
 * and input rules as the framework applications, created with `new` by each server.
 */
import DataLoader from 'dataloader'
import { GraphQLError } from 'graphql'
import { z } from 'zod'

export interface User {
  readonly id: string
  readonly name: string
  readonly email: string
}

export interface Book {
  readonly id: string
  readonly title: string
  readonly year: number
  readonly authorId: string
}

/** Check-only mode of the runner (`BENCH_COUNT_FIND_MANY=1`): one stderr line per `findMany` call, to check batching. */
const COUNT_FIND_MANY = process.env['BENCH_COUNT_FIND_MANY'] === '1'

/** Input of `Mutation.createUser`: the rules of the HTTP benchmark's `POST /users` body. */
export const CreateUserInput = z.object({ name: z.string().min(1).max(100), email: z.email() })
export type CreateUserInput = z.infer<typeof CreateUserInput>

/** The schema every application serves. */
export const typeDefs = /* GraphQL */ `
  type Query {
    user(id: ID!): User
    books(limit: Int!): [Book!]!
  }

  type Mutation {
    createUser(input: CreateUserInput!): User!
  }

  type User {
    id: ID!
    name: String!
    email: String!
  }

  type Book {
    id: ID!
    title: String!
    year: Int!
    author: User!
  }

  input CreateUserInput {
    name: String!
    email: String!
  }
`

/** Users 1 to 100 are seeded; created users take the ids 101 to 10000 in turn (bounded memory). */
export class UserRepository {
  readonly #users = new Map<string, User>()
  #created = 0

  constructor() {
    for (let id = 1; id <= 100; id++) {
      this.#users.set(String(id), { id: String(id), name: `User ${id}`, email: `user${id}@example.com` })
    }
  }

  findById(id: string): User | undefined {
    return this.#users.get(id)
  }

  /** The users of `ids` that exist, in no particular order. */
  findMany(ids: readonly string[]): User[] {
    if (COUNT_FIND_MANY) process.stderr.write('findMany\n')
    const users: User[] = []
    for (const id of ids) {
      const user = this.#users.get(id)
      if (user !== undefined) users.push(user)
    }
    return users
  }

  insert(input: CreateUserInput): User {
    const id = String(101 + (this.#created++ % 9900))
    const user = { id, name: input.name, email: input.email }
    this.#users.set(id, user)
    return user
  }
}

export class UserService {
  constructor(private readonly users: UserRepository) {}

  findById(id: string): User | undefined {
    return this.users.findById(id)
  }

  findMany(ids: readonly string[]): User[] {
    return this.users.findMany(ids)
  }

  create(input: CreateUserInput): User {
    return this.users.insert(input)
  }
}

/** Books 1 to 100; book `i` is written by user `((i * 7) % 100) + 1`. */
export class BookRepository {
  readonly #books: readonly Book[]

  constructor() {
    const books: Book[] = []
    for (let id = 1; id <= 100; id++) {
      books.push({ id: String(id), title: `Book ${id}`, year: 1900 + id, authorId: String(((id * 7) % 100) + 1) })
    }
    this.#books = books
  }

  /** The first `limit` books, by id. */
  list(limit: number): Book[] {
    return this.#books.slice(0, Math.max(0, limit))
  }
}

export class BookService {
  constructor(private readonly books: BookRepository) {}

  list(limit: number): Book[] {
    return this.books.list(limit)
  }
}

/** The context of one request: a fresh DataLoader, so `Book.author` calls `findMany` once per request. */
export interface Context {
  readonly users: DataLoader<string, User>
}

/** The services with their repositories, wired by hand. */
export interface Services {
  readonly users: UserService
  readonly books: BookService
}

export function createServices(): Services {
  return { users: new UserService(new UserRepository()), books: new BookService(new BookRepository()) }
}

/** The context of a new request. */
export function createContext(services: Services): Context {
  return {
    users: new DataLoader<string, User>(ids => {
      const users = new Map(services.users.findMany(ids).map(user => [user.id, user]))
      return Promise.resolve(ids.map(id => users.get(id) ?? new GraphQLError(`User ${id} not found`)))
    }),
  }
}

/** The resolvers of `typeDefs` (graphql-tools shape, used by Yoga; graphql-js maps them onto its types). */
export function createResolvers(services: Services) {
  return {
    Query: {
      user: (_: unknown, args: { id: string }): User | null => services.users.findById(args.id) ?? null,
      books: (_: unknown, args: { limit: number }): Book[] => services.books.list(args.limit),
    },
    Mutation: {
      createUser: (_: unknown, args: { input: unknown }): User => {
        const input = CreateUserInput.safeParse(args.input)
        if (!input.success) {
          throw new GraphQLError('Invalid input', {
            extensions: { code: 'BAD_USER_INPUT', issues: input.error.issues },
          })
        }
        return services.users.create(input.data)
      },
    },
    Book: {
      author: (book: Book, _: unknown, context: Context): Promise<User> => context.users.load(book.authorId),
    },
  }
}

/** `PORT`, `3000` by default. */
export const port: number = Number(process.env['PORT'] ?? 3000)

/** Every server listens on the loopback interface. */
export const host = '127.0.0.1'
