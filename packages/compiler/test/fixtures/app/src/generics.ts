import type { User } from './users/user.model.ts'

export interface Repository<T, ID = string> {
  find(id: ID): T
}

export interface Store<K = string, V = K[]> {
  get(key: K): V
}

export type UserRepo = Repository<User>
export type Maybe<T> = T | undefined
export type Pair<A, B = A> = [A, B]
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
export type Handler = (input: string) => void
export type Loop = Loop2
export type Loop2 = Loop
export type Names = Array<string>

export class Base<T> {
  constructor(readonly value: T) {}
}

export class Derived extends Base<User> {}

export class Box<T = number> extends Base<T[]> implements Repository<T> {
  find(id: string): T {
    throw new Error(id)
  }
}
