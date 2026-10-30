/**
 * Validation schemas of the carts, with **Valibot**: any Standard Schema library works the same
 * way for validation (`@Body(AddCartItem)` validates the body and injects the schema output).
 *
 * For the OpenAPI document, Valibot schemas do not describe their JSON Schema themselves (Zod does,
 * through Standard JSON Schema): the built-in fallback converter of `@znight/openapi` uses
 * `toStandardJsonSchema()` of `@valibot/to-json-schema`, an optional peer dependency installed by
 * this example. `v.metadata()` and `v.description()` become JSON Schema keywords.
 */
import * as v from 'valibot'

/** Body of `POST /carts/{id}/items`. */
export const AddCartItem = v.object({
  productId: v.pipe(v.string(), v.uuid(), v.description('Id of the product (`GET /products`)')),
  quantity: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(99), v.description('Units to add to the cart')),
    1,
  ),
})
export type AddCartItem = v.InferOutput<typeof AddCartItem>
