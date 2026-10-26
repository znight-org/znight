// @ts-nocheck — fixture application, analysed by the compiler tests from a temporary copy
import type { HttpContext, RequestId } from '@znight/http'

import { Controller, Get, Headers } from '@znight/http'

/** One instance per request: it can inject the request-scoped HttpContext. */
@Controller({ path: '/health', scope: 'request' })
export class HealthController {
  constructor(private readonly ctx: HttpContext) {}

  @Get()
  check(@Headers('x-request-id') requestId?: RequestId) {
    return { status: 'ok', path: this.ctx.path, requestId: requestId ?? null }
  }
}
