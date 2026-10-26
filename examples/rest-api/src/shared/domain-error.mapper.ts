import { Injectable } from '@znight/core'
import {
  ConflictException,
  type ExceptionMapper,
  type ExceptionMapperResult,
  NotFoundException,
  UnsupportedMediaTypeException,
} from '@znight/http'

import { BookNotFoundError, CoverNotFoundError, DuplicateIsbnError, UnsupportedCoverError } from '../books/book.js'

/**
 * Turns the domain errors into HTTP errors, so that services throw meaningful errors without
 * knowing about HTTP. Registered in `main.ts` (`exceptionMappers`); mappers are tried in order for
 * every error and the first one returning something wins. `undefined` lets the default rendering
 * apply (`HttpException`s keep their status, anything else is a 500).
 */
@Injectable()
export class DomainErrorMapper implements ExceptionMapper {
  map(error: unknown): ExceptionMapperResult {
    if (error instanceof BookNotFoundError || error instanceof CoverNotFoundError) {
      return new NotFoundException(error.message)
    }
    if (error instanceof DuplicateIsbnError) return new ConflictException(error.message, { isbn: error.isbn })
    if (error instanceof UnsupportedCoverError) return new UnsupportedMediaTypeException(error.message)
    return undefined
  }
}
