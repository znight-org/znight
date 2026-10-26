import { Injectable } from '@znight/core'

export interface Repo<T> {
  all(): T[]
}
export interface Order {
  readonly total: number
}
export interface Customer {
  readonly name: string
}

@Injectable()
export class OrderRepo implements Repo<Order> {
  all(): Order[] {
    return []
  }
}
