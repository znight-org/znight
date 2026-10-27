import type { Payment } from '../books/book.ts'

import { Body, Controller, Get, Post } from '@znight/http'
import { ApiSecurity } from '@znight/openapi'

import { ApiKey } from '../api.ts'
import { NewOrder } from '../books/book.schemas.ts'

export interface Order {
  readonly id: string
  readonly bookId: number
  readonly payment: Payment
}

/** Orders of books. */
@Controller('/orders')
@ApiSecurity(ApiKey)
export class OrderController {
  /** Place an order */
  @Post()
  place(@Body(NewOrder) order: NewOrder): Order {
    return { id: 'o1', bookId: order.bookId, payment: { method: 'card', last4: '4242' } }
  }

  /** Orders of the day */
  @Get()
  @ApiSecurity()
  today(): Order[] {
    return []
  }
}
