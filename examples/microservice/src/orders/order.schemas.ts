import { z } from 'zod'

/**
 * Schemas of the orders API and of the OrderCreated event. They are referenced by the decorators
 * (`@Body(CreateOrder)`, `@Message(OrderCreatedEvent)`): the compiler imports them in the generated
 * code, which validates every request body and every message before the handler runs. Handlers
 * receive the schema **output** (defaults applied, unknown keys stripped).
 */

export const Currency = z.enum(['EUR', 'USD', 'GBP'])
export type Currency = z.output<typeof Currency>

/** Identifier of an order (`GET /orders/:id`): anything else answers 400 before reaching the handler. */
export const OrderId = z.uuid()

export const OrderLine = z.object({
  sku: z.string().regex(/^[A-Z0-9-]{3,32}$/, 'Expected an upper-case SKU such as "BOOK-42"'),
  quantity: z.int().min(1).max(100),
  /** Unit price in minor units (cents): money is never a floating-point number. */
  unitPrice: z.int().min(0),
})
export type OrderLine = z.output<typeof OrderLine>

/** Body of `POST /orders`. */
export const CreateOrder = z.object({
  customerId: z.string().trim().min(1).max(64),
  currency: Currency.default('EUR'),
  /**
   * Payment method token (`pm_...`), charged asynchronously once the order is stored. The simulated
   * gateway (`src/payments/payment.gateway.ts`) has test tokens to try every processing outcome.
   */
  paymentMethod: z.string().regex(/^pm_[a-z0-9_]+$/, 'Expected a payment method token such as "pm_card_visa"'),
  lines: z.array(OrderLine).min(1).max(50),
})
export type CreateOrder = z.output<typeof CreateOrder>

/**
 * Payload of the `order.created` messages (queue `orders.created`): the contract between this service
 * and every consumer of the event. Consumers validate it: a message that does not match is
 * dead-lettered immediately (never retried).
 */
export const OrderCreatedEvent = z.object({
  orderId: z.uuid(),
  customerId: z.string().min(1),
  /** Total in minor units. */
  amount: z.int().min(0),
  currency: Currency,
  paymentMethod: z.string().min(1),
  createdAt: z.iso.datetime(),
})
export type OrderCreatedEvent = z.output<typeof OrderCreatedEvent>
