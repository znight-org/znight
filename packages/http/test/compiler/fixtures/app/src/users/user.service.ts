// @ts-nocheck — fixture application, analysed by the compiler tests from a temporary copy
import { Injectable } from '@znight/core'

export interface User {
  id: number
  name: string
  email: string
}

@Injectable()
export class UserService {
  readonly #users = new Map<number, User>([[1, { id: 1, name: 'Ada', email: 'ada@example.com' }]])
  #next = 2

  list(): User[] {
    return [...this.#users.values()]
  }

  find(id: number): User | undefined {
    return this.#users.get(id)
  }

  create(input: { name: string; email: string }): User {
    const user = { id: this.#next++, ...input }
    this.#users.set(user.id, user)
    return user
  }

  remove(id: number): boolean {
    return this.#users.delete(id)
  }
}
