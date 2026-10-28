import { OpenApiDocument, securityScheme } from '@znight/openapi'

import { Public } from './auth/auth.decorators.js'

/*
 * The OpenAPI document of the application: its title, description, security schemes and the
 * security rules of its operations. Everything else (paths, parameters, bodies, responses) comes
 * from the controllers.
 *
 * `securityScheme()` declares a scheme; the compiler reads it statically (like a decorator
 * argument), and it appears in `components.securitySchemes` as soon as something references it.
 * The values are passed to `@ApiSecurity()` and to the options below.
 */

/** A customer token: `Authorization: Bearer <token>` (role `customer`, checked by `AuthGuard`). */
export const Bearer = securityScheme('bearer', {
  type: 'http',
  scheme: 'bearer',
  description: 'Token of a customer. Carts and orders belong to the customer of the token.',
})

/** A back-office key: `x-api-key: <key>` (roles `catalog` and `admin`). */
export const ApiKey = securityScheme('apiKey', {
  type: 'apiKey',
  in: 'header',
  name: 'x-api-key',
  description: 'API key of the back office: `catalog` (products and images) or `admin` (everything).',
})

/**
 * Storefront API
 *
 * A small shop: a public catalogue of products with their images, carts and orders for the
 * customers (bearer token), and a back office (API key).
 *
 * Errors share one envelope, `{ statusCode, error, message, details? }`; validation errors list
 * every problem in `details`.
 */
@OpenApiDocument({
  // the title and the description are the JSDoc above; without `version`, `package.json` gives it
  info: { version: '1.0.0', license: { name: 'MIT', identifier: 'MIT' } },
  // the default of every operation: routes without `@ApiSecurity` need a customer token...
  security: [Bearer],
  // ...except the `@Public()` ones, which need nothing (`security: []`). The first matching entry
  // wins; `@ApiSecurity` on a route or a controller wins over every entry.
  decisions: [{ when: Public, security: [] }],
  // declared tags come first, in this order, with their descriptions
  tags: [
    { name: 'Catalog', description: 'Products and their images. Public, except the back-office operations.' },
    { name: 'Carts', description: 'Shopping carts of the customers.' },
    { name: 'Orders', description: 'Orders of the customers, and their export.' },
    { name: 'Admin', description: 'The back office.' },
  ],
})
export class StorefrontApi {}
