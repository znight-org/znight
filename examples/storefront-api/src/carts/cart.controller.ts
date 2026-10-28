import type { Lazy } from '@znight/core'
import type { CurrentCustomer } from '../auth/current-customer.js'
import type { CartResponse } from './cart.js'
import type { CartService } from './cart.service.js'

import { Body, Controller, Get, HttpCode, HttpResponse, Param, Post } from '@znight/http'
import { ApiResponse, ApiTags } from '@znight/openapi'

import { Roles } from '../auth/auth.decorators.js'
import { Id } from '../shared/id.js'
import { FORBIDDEN, UNAUTHORIZED } from '../shared/responses.js'
import { AddCartItem } from './cart.schemas.js'

/**
 * Shopping carts of the customers.
 *
 * `@Roles(['customer'])`: a bearer token is required. The routes declare no `@ApiSecurity`: they
 * inherit the document default (`security: [Bearer]`, src/api.ts), so their operations carry no
 * `security` field of their own.
 *
 * `CurrentCustomer` is request-scoped, the controller a singleton: it injects `Lazy<CurrentCustomer>`
 * and calls `get()` while handling a request (a direct injection would be ZNIGHT003).
 */
@Controller('/carts')
@Roles(['customer'])
@ApiTags('Carts')
export class CartController {
  constructor(
    private readonly carts: CartService,
    private readonly customer: Lazy<CurrentCustomer>,
  ) {}

  /**
   * Create a cart
   * @returns The new, empty cart. Its URL is in the `location` header.
   */
  @Post()
  @ApiResponse(201, { headers: { location: { description: 'URL of the new cart', required: true } } })
  @ApiResponse(401, UNAUTHORIZED)
  @ApiResponse(403, FORBIDDEN)
  create(): HttpResponse<CartResponse> {
    const cart = this.carts.create(this.customer.get().id)
    return HttpResponse.created(this.carts.view(cart), `/carts/${cart.id}`)
  }

  /** Get a cart */
  @Get('/:id')
  @ApiResponse(401, UNAUTHORIZED)
  @ApiResponse(403, FORBIDDEN)
  @ApiResponse(404, { description: 'No cart with this id for this customer' })
  get(@Param('id', Id) id: string): CartResponse {
    return this.carts.view(this.carts.get(this.customer.get().id, id))
  }

  /**
   * Add a product to a cart
   *
   * Adds units to the line of the product (a cart has one line per product). The body is validated
   * by a Valibot schema.
   * @param item The product and the units to add.
   * @returns The cart, with its new totals.
   */
  @Post('/:id/items')
  @HttpCode(200) // a POST answers 201 by default; this one changes an existing resource
  @ApiResponse(401, UNAUTHORIZED)
  @ApiResponse(403, FORBIDDEN)
  @ApiResponse(404, { description: 'No cart with this id for this customer, or no such product' })
  @ApiResponse(409, { description: 'Not enough units in stock' })
  addItem(@Param('id', Id) id: string, @Body(AddCartItem) item: AddCartItem): CartResponse {
    return this.carts.view(this.carts.addItem(this.customer.get().id, id, item))
  }
}
