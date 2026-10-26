/**
 * Names of the messaging topology. Decorator arguments must be statically evaluable: `const`s like
 * these work across files (the compiler evaluates them).
 */

/** Queue of the OrderCreated events. Its dead-letter queue is `orders.created.dlq` (driver naming). */
export const ORDERS_CREATED_QUEUE = 'orders.created'

/** Message type of the OrderCreated events: selects the `@OnMessage` handler. */
export const ORDER_CREATED = 'order.created'
