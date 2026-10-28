import { z } from 'zod'

/**
 * The id of a product, a cart or an order: a UUID.
 *
 * `@Param('id', Id)` validates the path parameter before the handler runs (`GET /products/42` is a
 * `400` listing the problem, not a `404`), and documents it: the parameter of every such route
 * references the `Id` component of the OpenAPI document.
 */
export const Id = z.uuid().meta({ description: 'A UUID', examples: ['0d6f2c4e-5b1a-4c3e-9f8a-2b7d1e6a9c01'] })
