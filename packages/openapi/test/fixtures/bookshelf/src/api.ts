import { OpenApiDocument, securityScheme } from '@znight/openapi'

import { Public, Roles } from './auth/auth.decorators.ts'

/** The `x-api-key` header checked by the guard. */
export const ApiKey = securityScheme('apiKey', { type: 'apiKey', in: 'header', name: 'x-api-key' })

export const OAuth = securityScheme('oauth2', {
  type: 'oauth2',
  flows: {
    clientCredentials: {
      tokenUrl: 'https://id.example.com/oauth2/token',
      scopes: { reader: 'Read books', admin: 'Manage books' },
    },
  },
})

/**
 * Bookshelf API
 *
 * A shelf of books with a cover each.
 */
@OpenApiDocument({
  info: { contact: { email: 'api@example.com' } },
  security: [ApiKey],
  decisions: [
    { when: Public, security: [] },
    { when: Roles, security: [OAuth], scopes: 'value' },
  ],
  tags: [{ name: 'Books', description: 'The shelf' }],
  extensions: { 'x-audience': 'public' },
})
export class BookshelfApi {}
