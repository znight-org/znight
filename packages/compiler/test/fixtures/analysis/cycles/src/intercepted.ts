import { Injectable, Intercept, type MethodInterceptor, type MethodInvocation } from '@znight/core'

export class AuditInterceptor implements MethodInterceptor {
  constructor(readonly service: AuditedService) {}

  intercept(invocation: MethodInvocation): unknown {
    return invocation.proceed()
  }
}

@Injectable()
export class AuditedService {
  @Intercept(AuditInterceptor)
  run(): void {}
}
