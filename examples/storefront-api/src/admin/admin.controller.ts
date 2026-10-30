import type { CatalogService } from '../catalog/catalog.service.js'
import type { OrderStatus } from '../orders/order.js'
import type { OrderService } from '../orders/order.service.js'

import { Controller, Get } from '@znight/http'
import { ApiResponse, ApiSecurity, ApiTags } from '@znight/openapi'

import { ApiKey } from '../api.js'
import { Roles } from '../auth/auth.decorators.js'
import { FORBIDDEN, UNAUTHORIZED } from '../shared/responses.js'

/** Figures of the shop. */
export interface ShopStats {
  /**
   * Products of the catalogue.
   * @format int32
   */
  readonly products: number
  /**
   * Products that cannot be ordered.
   * @format int32
   */
  readonly outOfStock: number
  /** @format int32 */
  readonly orders: number
  /** Orders by status. */
  readonly ordersByStatus: Readonly<Record<OrderStatus, number>>
  /**
   * Total of the paid orders, in cents.
   * @format int64
   */
  readonly revenueCents: number
  readonly generatedAt: Date
}

/**
 * The back office.
 *
 * `@ApiSecurity(ApiKey)` on the class documents every route with the API key, overriding the
 * document default (the customers' bearer token). It only documents: `@Roles(['admin'])` is the
 * access decision that `AuthGuard` enforces.
 */
@Controller('/admin')
@Roles(['admin'])
@ApiSecurity(ApiKey)
@ApiTags('Admin')
export class AdminController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly orders: OrderService,
  ) {}

  /** Statistics of the shop */
  @Get('/stats')
  @ApiResponse(401, UNAUTHORIZED)
  @ApiResponse(403, FORBIDDEN)
  stats(): ShopStats {
    const { orders, revenueCents, byStatus } = this.orders.stats()
    return { ...this.catalog.stats(), orders, ordersByStatus: byStatus, revenueCents, generatedAt: new Date() }
  }
}
