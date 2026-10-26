import type { Order } from './order.model.js'
import type { OrderService } from './order.service.js'

import { Body, Controller, Get, HttpResponse, NotFoundException, Param, Post } from '@znight/http'

import { CreateOrder, OrderId } from './order.schemas.js'

/**
 * The compiler generates one `invoke` function per route: it extracts the parameters, validates
 * them with their schema (400 with every issue otherwise) and calls the handler. No reflection at
 * runtime, and a handler signature that no longer matches its decorators is a `tsc` error.
 */
@Controller('/orders')
export class OrderController {
  constructor(private readonly orders: OrderService) {}

  /**
   * `POST /orders`: stores the order (`pending`) and answers `201 Created` with its `location`. The
   * payment is processed asynchronously: poll `GET /orders/:id` until the status changes.
   */
  @Post()
  async create(@Body(CreateOrder) input: CreateOrder): Promise<HttpResponse<Order | undefined>> {
    const order = await this.orders.create(input)
    return HttpResponse.created(order, `/orders/${order.id}`)
  }

  /** `GET /orders/:id`: the order and its processing status. */
  @Get('/:id')
  async find(@Param('id', OrderId) id: string): Promise<Order> {
    const order = await this.orders.findById(id)
    if (order === undefined) throw new NotFoundException(`Order ${id} not found`)
    return order
  }
}
