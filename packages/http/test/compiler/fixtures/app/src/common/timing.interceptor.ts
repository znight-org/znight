// @ts-nocheck — fixture application, analysed by the compiler tests from a temporary copy
import type { CallHandler, HttpContext, HttpInterceptor } from '@znight/http'

import { Injectable } from '@znight/core'

@Injectable()
export class TimingInterceptor implements HttpInterceptor {
  async intercept(ctx: HttpContext, next: CallHandler): Promise<unknown> {
    const result = await next()
    ctx.setHeader('x-intercepted', 'timing')
    return result
  }
}
