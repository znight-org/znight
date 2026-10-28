import { Injectable } from '@znight/core'
import {
  ConflictException,
  type ExceptionMapper,
  type ExceptionMapperResult,
  NotFoundException,
  UnsupportedMediaTypeException,
} from '@znight/http'

import { ConflictError, NotFoundError, UnsupportedImageError } from './errors.js'

/**
 * Turns the domain errors into HTTP errors. Registered in src/http.ts (`exceptionMappers`); mappers
 * are tried in order for every error and the first one returning something wins. `undefined` lets
 * the default rendering apply (`HttpException`s keep their status, anything else is a 500).
 *
 * The bodies follow the standard error envelope (`{ statusCode, error, message, details? }`), which
 * the OpenAPI document describes as `HttpErrorBody`: the contract tests check it.
 */
@Injectable()
export class DomainErrorMapper implements ExceptionMapper {
  map(error: unknown): ExceptionMapperResult {
    if (error instanceof NotFoundError) return new NotFoundException(error.message)
    if (error instanceof ConflictError) return new ConflictException(error.message, error.details)
    if (error instanceof UnsupportedImageError) return new UnsupportedMediaTypeException(error.message)
    return undefined
  }
}
