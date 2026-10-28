/*
 * Domain errors: services throw them without knowing about HTTP, and `DomainErrorMapper` turns them
 * into HTTP errors. The statuses they map to are documented on the routes with `@ApiResponse`.
 */

/** Something that does not exist (or that the caller may not see): `404 Not Found`. */
export class NotFoundError extends Error {
  constructor(
    readonly resource: 'product' | 'image' | 'cart' | 'order',
    readonly id: string,
  ) {
    super(`No ${resource} ${id}`)
    this.name = 'NotFoundError'
  }
}

/** A request that contradicts the current state (duplicate SKU, empty cart, stock): `409 Conflict`. */
export class ConflictError extends Error {
  constructor(
    message: string,
    readonly details?: Readonly<Record<string, string | number>>,
  ) {
    super(message)
    this.name = 'ConflictError'
  }
}

/** An uploaded image whose content is not one of the accepted types: `415 Unsupported Media Type`. */
export class UnsupportedImageError extends Error {
  constructor() {
    super('The image must be a PNG, JPEG or WebP file')
    this.name = 'UnsupportedImageError'
  }
}
