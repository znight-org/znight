import { Injectable, Intercept, type Lazy, type MethodInvocation } from '@znight/core'
import type { WebContext } from '@znight/fake-web'

@Injectable({ scope: 'request' })
export class CurrentUser {}

@Injectable({ scope: 'transient' })
export class Formatter {
  constructor(readonly user: CurrentUser) {}
}

@Injectable()
export class DirectSingleton {
  constructor(readonly user: CurrentUser) {}
}

@Injectable()
export class ThroughTransient {
  constructor(readonly formatter: Formatter) {}
}

@Injectable()
export class UsesExternal {
  constructor(readonly context: WebContext) {}
}

export abstract class Handler {}

@Injectable({ scope: 'request' })
export class RequestHandler extends Handler {}

@Injectable()
export class UsesMulti {
  constructor(readonly handlers: Handler[]) {}
}

@Injectable({ scope: 'request' })
export class RequestInterceptor {
  intercept(invocation: MethodInvocation): unknown {
    return invocation.proceed()
  }
}

@Injectable()
export class Intercepted {
  @Intercept(RequestInterceptor)
  run(): void {}
}

@Injectable()
export class LazySingleton {
  constructor(readonly user: Lazy<CurrentUser>, readonly context: Lazy<WebContext>) {}
}

@Injectable({ scope: 'request' })
export class RequestToRequest {
  constructor(readonly user: CurrentUser, readonly formatter: Formatter) {}
}

@Injectable({ scope: 'transient' })
export class TransientToRequest {
  constructor(readonly user: CurrentUser) {}
}
