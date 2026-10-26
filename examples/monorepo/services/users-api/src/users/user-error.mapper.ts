import { Injectable } from '@znight/core'
import { ConflictException, type ExceptionMapper, type HttpException, NotFoundException } from '@znight/http'
import { EmailAlreadyUsedError, UserNotFoundError } from '@znight-examples/shared'

/**
 * Maps the domain errors of the shared library to HTTP responses. The library knows nothing about
 * HTTP (the worker uses it too); each service translates its errors at its own boundary.
 */
@Injectable()
export class UserErrorMapper implements ExceptionMapper {
  map(error: unknown): HttpException | undefined {
    if (error instanceof UserNotFoundError) return new NotFoundException(error.message, { id: error.userId })
    if (error instanceof EmailAlreadyUsedError) return new ConflictException(error.message, { email: error.email })
    return undefined // not ours: next mapper, then the default rendering (500)
  }
}
