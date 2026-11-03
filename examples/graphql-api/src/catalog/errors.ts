/*
 * Domain errors: the services know nothing of GraphQL. `CatalogErrorMapper` turns them into GraphQL
 * errors with a code clients can switch on.
 */

/** No book with this id. */
export class BookNotFoundError extends Error {
  constructor(readonly bookId: string) {
    super(`No book ${bookId}`)
    this.name = 'BookNotFoundError'
  }
}

/** No author with this id. */
export class AuthorNotFoundError extends Error {
  constructor(readonly authorId: string) {
    super(`No author ${authorId}`)
    this.name = 'AuthorNotFoundError'
  }
}

/** A book of the catalog already has this ISBN. */
export class DuplicateIsbnError extends Error {
  constructor(readonly isbn: string) {
    super(`A book with the ISBN ${isbn} is already in the catalog`)
    this.name = 'DuplicateIsbnError'
  }
}
