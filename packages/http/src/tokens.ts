import type { TypedToken } from '@znight/core'
import type { HttpContext, RequestId } from './context.ts'
import type { HttpPlugin } from './plugin.ts'

/**
 * Tokens of the values `@znight/http` supplies to the container. `HttpContext` and `RequestId` are
 * request-scoped externals (declared in the package manifest): inject them in request-scoped
 * providers or through `Lazy<HttpContext>`.
 */
export const HttpTokens: {
  /** The {@link HttpContext} of the current request (request scope). */
  readonly Context: TypedToken<HttpContext>
  /** The id of the current request (request scope). */
  readonly RequestId: TypedToken<RequestId>
  /** The {@link HttpPlugin} instance (singleton). */
  readonly Plugin: TypedToken<HttpPlugin>
} = Object.freeze({
  Context: '@znight/http#HttpContext',
  RequestId: '@znight/http#RequestId',
  Plugin: '@znight/http#HttpPlugin',
})
