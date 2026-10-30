/**
 * The users of the hand-wired baselines: the same repository, service and schema as the framework
 * applications, created with `new` by each server.
 */
import { z } from 'zod'

export interface User {
  readonly id: number
  readonly name: string
  readonly email: string
}

/** Body of `POST /users`. */
export const CreateUser = z.object({ name: z.string().min(1).max(100), email: z.email() })
export type CreateUser = z.infer<typeof CreateUser>

/** Users 1 to 1000 are seeded; created users take the ids 1001 to 10000 in turn (bounded memory). */
export class UserRepository {
  readonly #users = new Map<number, User>()
  #created = 0

  constructor() {
    for (let id = 1; id <= 1000; id++) this.#users.set(id, { id, name: `User ${id}`, email: `user${id}@example.com` })
  }

  findById(id: number): User | undefined {
    return this.#users.get(id)
  }

  insert(input: CreateUser): User {
    const user = { id: 1001 + (this.#created++ % 9000), name: input.name, email: input.email }
    this.#users.set(user.id, user)
    return user
  }
}

export class UserService {
  constructor(private readonly users: UserRepository) {}

  findById(id: number): User | undefined {
    return this.users.findById(id)
  }

  create(input: CreateUser): User {
    return this.users.insert(input)
  }
}

/** The service with its repository, wired by hand. */
export function createUserService(): UserService {
  return new UserService(new UserRepository())
}

/** `PORT`, `3000` by default. */
export const port: number = Number(process.env['PORT'] ?? 3000)

/** Every server listens on the loopback interface. */
export const host = '127.0.0.1'
