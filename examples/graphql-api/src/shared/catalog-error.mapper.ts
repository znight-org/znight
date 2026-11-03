import { Injectable } from '@znight/core'
import { type GraphQLErrorMapper, GraphQLException } from '@znight/graphql'

import { AuthorNotFoundError, BookNotFoundError, DuplicateIsbnError } from '../catalog/errors.js'

/**
 * Turns the domain errors of the catalog into GraphQL errors, in one place (`errorMappers` of
 * `GraphQLPlugin`). Anything it does not map is masked as `Unexpected error.` and logged once with
 * the request id, the field and the cause.
 */
@Injectable()
export class CatalogErrorMapper implements GraphQLErrorMapper {
  map(error: unknown): GraphQLException | undefined {
    if (error instanceof BookNotFoundError) {
      return new GraphQLException(error.message, { code: 'NOT_FOUND', extensions: { bookId: error.bookId } })
    }
    if (error instanceof AuthorNotFoundError) {
      return new GraphQLException(error.message, { code: 'NOT_FOUND', extensions: { authorId: error.authorId } })
    }
    if (error instanceof DuplicateIsbnError) {
      return new GraphQLException(error.message, { code: 'CONFLICT', extensions: { isbn: error.isbn } })
    }
    return undefined
  }
}
