import type { Lazy } from '@znight/core'
import type { CurrentCustomer } from '../auth/current-customer.js'
import type { Order } from './order.js'
import type { OrderService } from './order.service.js'

import { Body, Controller, Get, HttpResponse, Param, Post, Query } from '@znight/http'
import { ApiResponse, ApiSecurity, ApiTags } from '@znight/openapi'

import { ApiKey } from '../api.js'
import { Roles } from '../auth/auth.decorators.js'
import { Id } from '../shared/id.js'
import { FORBIDDEN, UNAUTHORIZED } from '../shared/responses.js'
import { PlaceOrder } from './order.schemas.js'

/** Media type of the export: newline-delimited JSON, one document per line. */
export const NDJSON = 'application/x-ndjson'

/**
 * Orders of the customers, and their export for the back office.
 *
 * `@Roles(['customer'])` on the class; `GET /orders/export` replaces it with `@Roles(['admin'])`
 * (the nearest decision wins: a customer token gets `403` there) and documents the API key.
 */
@Controller('/orders')
@Roles(['customer'])
@ApiTags('Orders')
export class OrderController {
  constructor(
    private readonly orders: OrderService,
    private readonly customer: Lazy<CurrentCustomer>,
  ) {}

  /**
   * Place an order
   *
   * Orders every line of a cart, which is then closed. A card payment is captured at once (status
   * `paid`); a transfer gives the reference and the IBAN to use (status `awaiting-transfer`).
   * @param order The cart and the payment. `payment.method` selects the payment option.
   * @returns The order. Its URL is in the `location` header.
   */
  @Post()
  @ApiResponse(201, { headers: { location: { description: 'URL of the new order', required: true } } })
  @ApiResponse(401, UNAUTHORIZED)
  @ApiResponse(403, FORBIDDEN)
  @ApiResponse(404, { description: 'No cart with this id for this customer' })
  @ApiResponse(409, { description: 'The cart is empty, or a product ran out of stock since it was added' })
  place(@Body(PlaceOrder) order: PlaceOrder): HttpResponse<Order> {
    const placed = this.orders.place(this.customer.get().id, order)
    return HttpResponse.created(placed, `/orders/${placed.id}`)
  }

  /**
   * Export the orders
   *
   * Back office: an API key with the `admin` role. Every order as newline-delimited JSON (one `Order`
   * document per line), streamed as it is read: the export never holds every order in memory, and a
   * client that disconnects stops it.
   * @param since Only the orders placed at or after this date (ISO 8601).
   */
  @Get('/export')
  @Roles(['admin'])
  @ApiSecurity(ApiKey)
  // `HttpResponse.stream()` is documented as bytes: this declares the media type and the schema of
  // each line (OpenAPI 3.1 has no schema for a sequence of documents; 3.2 adds `itemSchema`)
  @ApiResponse<Order>(200, { contentType: NDJSON, description: 'One `Order` per line' })
  @ApiResponse(401, UNAUTHORIZED)
  @ApiResponse(403, FORBIDDEN)
  export(@Query('since') since?: Date): HttpResponse<ReadableStream<Uint8Array>> {
    const orders = this.orders.export(since)
    async function* lines(): AsyncGenerator<string> {
      for await (const order of orders) yield `${JSON.stringify(order)}\n`
    }
    return HttpResponse.stream(lines(), { contentType: NDJSON, filename: 'orders.ndjson' })
  }

  /** Get an order */
  @Get('/:id')
  @ApiResponse(401, UNAUTHORIZED)
  @ApiResponse(403, FORBIDDEN)
  @ApiResponse(404, { description: 'No order with this id for this customer' })
  get(@Param('id', Id) id: string): Order {
    return this.orders.get(this.customer.get().id, id)
  }
}
