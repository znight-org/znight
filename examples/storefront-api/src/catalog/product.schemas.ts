/**
 * Validation schemas of the catalogue, with Zod. `@Body(CreateProduct)` validates the body and
 * injects the schema **output**; a failure answers `400` with one entry per issue.
 *
 * The OpenAPI document gets their JSON Schema from Zod itself (Standard JSON Schema), when the
 * document is assembled: the **input** schema describes requests (what clients send), the
 * **output** schema responses. They differ here (transforms, defaults), so the document has two
 * components: `CreateProductInput` (the request body) and `CreateProduct` (what
 * `POST /products/validate` answers). `.meta()` adds descriptions and examples.
 *
 * Schemas are referenced by decorators, so they must be exported: the generated code imports them.
 */
import { z } from 'zod'

/** Prices travel as decimal strings (`"19.90"`): no binary floating point on the wire. */
const Price = z
  .string()
  .regex(/^\d{1,6}(\.\d{1,2})?$/, 'Expected a price in euros, such as 19.90')
  .transform(euros => Math.round(Number(euros) * 100))
  // what the transform produces: the output JSON Schema is the schema of the pipe
  .pipe(z.number().int().min(1))
  .meta({ description: 'Unit price: euros as a decimal string in requests ("14.90"), cents once parsed (1490)' })

/** Body of `POST /products` (and of `POST /products/validate`). */
export const CreateProduct = z
  .object({
    sku: z
      .string()
      .trim()
      // checked before the transform: the JSON Schema `pattern` describes what clients may send
      .regex(/^[A-Za-z0-9][A-Za-z0-9-]{2,31}$/, 'Expected 3 to 32 letters, digits or hyphens')
      .toUpperCase()
      .meta({
        description: 'Stock keeping unit, unique in the catalogue (stored in upper case)',
        examples: ['MUG-ZNIGHT'],
      }),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).nullable().default(null),
    category: z.enum(['apparel', 'books', 'home', 'toys']),
    price: Price,
    stock: z.number().int().min(0).default(0).meta({ description: 'Units available' }),
    tags: z
      .array(z.string().trim().toLowerCase().min(1).max(30))
      .max(10)
      .default([])
      .meta({ description: 'Labels, stored in lower case' }),
  })
  .meta({ description: 'A new product of the catalogue' })
export type CreateProduct = z.output<typeof CreateProduct>
