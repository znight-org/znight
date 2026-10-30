/**
 * Validation schemas of the orders, with Valibot (see src/carts/cart.schemas.ts).
 *
 * `v.variant('method', [...])` is a discriminated union: Valibot picks the option from the `method`
 * key, so an unknown method gets one clear error instead of the errors of every option.
 *
 * In the OpenAPI document it is a `oneOf` with a `discriminator` on `method`, like the response type
 * `Payment` (src/orders/order.ts). `@valibot/to-json-schema` writes a plain `oneOf` of inline
 * objects; the converter of src/openapi.converters.ts turns each option named with `v.title()` into
 * a component (`CardPaymentInput`, `TransferPaymentInput`) and adds the discriminator and its mapping.
 */
import * as v from 'valibot'

/** Pay now, with a card token of the payment provider: the API never sees card numbers. */
export const CardPaymentInput = v.pipe(
  v.object({
    method: v.literal('card'),
    token: v.pipe(
      v.string(),
      v.regex(/^tok_[a-z]+_[0-9]{4}$/, 'Expected a card token such as tok_visa_4242'),
      v.description('Card token of the payment provider; test tokens end with the last four digits of the card'),
      v.examples(['tok_visa_4242']),
    ),
  }),
  // the name of its OpenAPI component: see src/openapi.converters.ts
  v.title('CardPaymentInput'),
  v.description('Pay now, by card: the payment is captured when the order is placed.'),
)

/** Pay later, by bank transfer: the order waits for it. */
export const TransferPaymentInput = v.pipe(
  v.object({ method: v.literal('transfer') }),
  v.title('TransferPaymentInput'),
  v.description('Pay by bank transfer: the order answers the reference and the IBAN to use.'),
)

/** Body of `POST /orders`: the cart to order, and how to pay. */
export const PlaceOrder = v.object({
  cartId: v.pipe(v.string(), v.uuid(), v.description('The cart to order (`POST /carts`)')),
  payment: v.variant('method', [CardPaymentInput, TransferPaymentInput]),
})
export type PlaceOrder = v.InferOutput<typeof PlaceOrder>
