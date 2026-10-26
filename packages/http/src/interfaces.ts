import type { HttpContext } from './context.ts'
import type { HttpException } from './exceptions.ts'
import type { HttpResponse } from './response.ts'

/**
 * A guard decides whether a request may reach the handler. Guards run in order: global (plugin
 * options) → controller (`@UseGuard` on the class) → route. Returning `false` responds
 * `403 Forbidden`; throw an `HttpException` (e.g. `UnauthorizedException`) for another response.
 *
 * ```ts
 * @Injectable()
 * export class RolesGuard implements CanActivate {
 *   canActivate(ctx: HttpContext): boolean {
 *     const roles = Roles.get(ctx) // route metadata from createRouteDecorator
 *     return roles === undefined || roles.some(role => currentUser(ctx).roles.includes(role))
 *   }
 * }
 * ```
 */
export interface CanActivate {
  canActivate(ctx: HttpContext): boolean | Promise<boolean>
}

/** Runs the rest of the interceptor chain and the handler; resolves with the handler result. */
export type CallHandler = () => Promise<unknown>

/**
 * Wraps the handler (after the guards). Interceptors run global → controller → route, the first one
 * being the outermost. `next()` resolves with the handler result (before serialisation): return it,
 * transform it, or return something else without calling `next()` (cache hit...).
 *
 * ```ts
 * @Injectable()
 * export class TimingInterceptor implements HttpInterceptor {
 *   async intercept(ctx: HttpContext, next: CallHandler) {
 *     const started = performance.now()
 *     try {
 *       return await next()
 *     } finally {
 *       ctx.setHeader('server-timing', `handler;dur=${performance.now() - started}`)
 *     }
 *   }
 * }
 * ```
 */
export interface HttpInterceptor {
  intercept(ctx: HttpContext, next: CallHandler): unknown
}

/** What an {@link ExceptionMapper} may return: `undefined` lets the next mapper (or the default) handle the error. */
export type ExceptionMapperResult = HttpException | HttpResponse | Response | undefined

/**
 * Converts errors to responses. Mappers (plugin option `exceptionMappers`) are tried in order for
 * every error of the pipeline, including `404`/`405`; the first one returning something wins. Return
 * an `HttpException` to reuse the default error body, an `HttpResponse` or a Web `Response` for full
 * control, `undefined` to pass.
 *
 * ```ts
 * @Injectable()
 * export class DomainErrorMapper implements ExceptionMapper {
 *   map(error: unknown) {
 *     if (error instanceof UserNotFoundError) return new NotFoundException(error.message)
 *     return undefined
 *   }
 * }
 * ```
 */
export interface ExceptionMapper {
  map(error: unknown, ctx: HttpContext): ExceptionMapperResult | Promise<ExceptionMapperResult>
}

/** A class producing {@link CanActivate} instances (for `@UseGuard` and plugin options). */
export type GuardClass = abstract new (...args: never[]) => CanActivate

/** A class producing {@link HttpInterceptor} instances. */
export type HttpInterceptorClass = abstract new (...args: never[]) => HttpInterceptor

/** A class producing {@link ExceptionMapper} instances. */
export type ExceptionMapperClass = abstract new (...args: never[]) => ExceptionMapper
