import type { MethodInterceptor, MethodInvocation } from '@znight/core'
import type { Clock } from '../clock.js'
import { events } from '../events.js'

export interface TimingOptions {
  readonly label: string
}

/** Not decorated: auto-registered as a singleton because @Intercept references it. */
export class TimingInterceptor implements MethodInterceptor<TimingOptions> {
  readonly clock: Clock

  constructor(clock: Clock) {
    this.clock = clock
  }

  intercept(invocation: MethodInvocation, options: TimingOptions): unknown {
    events.push(`timing:${options.label}:${invocation.methodName}`)
    return invocation.proceed()
  }
}
