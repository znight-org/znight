import type { CallHandler, HttpContext, HttpInterceptor } from '@znight/http'

import { Injectable } from '@znight/core'

/**
 * Adds a `server-timing` header with the time spent in the handler (shown by the browsers'
 * developer tools). HTTP interceptors wrap the handler after the guards: `next()` runs the rest of
 * the chain and resolves with the handler result, before serialisation.
 *
 * Headers set with `ctx.setHeader()` are also sent with error responses.
 */
@Injectable()
export class ServerTimingInterceptor implements HttpInterceptor {
  async intercept(ctx: HttpContext, next: CallHandler): Promise<unknown> {
    const started = performance.now()
    try {
      return await next()
    } finally {
      ctx.setHeader('server-timing', `handler;dur=${(performance.now() - started).toFixed(1)}`)
    }
  }
}
