import { Injectable } from '@znight/core'
import type { HttpContext } from '@znight/fake-http'

@Injectable({ scope: 'request' })
export class RequestContext {
  constructor(readonly http: HttpContext) {}
}

@Injectable({ scope: 'transient' })
export class RequestLogger {
  constructor(readonly context: RequestContext) {}
}
