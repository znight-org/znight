import type { MethodInterceptor, MethodInvocation } from '@znight/core'
import type { Clock } from '../core/clock.ts'

export class TimingInterceptor implements MethodInterceptor<{ label?: string } | undefined> {
  constructor(readonly clock: Clock) {}

  intercept(invocation: MethodInvocation): unknown {
    return invocation.proceed()
  }
}
