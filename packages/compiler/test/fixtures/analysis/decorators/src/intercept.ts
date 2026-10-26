import { Injectable, Intercept, type MethodInvocation } from '@znight/core'

class PrivateInterceptor {
  intercept(invocation: MethodInvocation): unknown {
    return invocation.proceed()
  }
}

export class PublicInterceptor {
  intercept(invocation: MethodInvocation): unknown {
    return invocation.proceed()
  }
}

@Injectable()
export class Intercepted {
  @Intercept(PrivateInterceptor)
  unexported(): void {}

  @Intercept(PublicInterceptor, { format: (value: string) => value })
  inlineFunction(): void {}

  @Intercept(PublicInterceptor)
  static staticMethod(): void {}

  @Intercept(PublicInterceptor)
  #secret(): void {}

  @Intercept('PublicInterceptor')
  notAClass(): void {}
}

export class NotRegistered {
  @Intercept(PublicInterceptor)
  run(): void {}
}
