/**
 * Interceptor decorators. Like every Znight decorator they are compile-time markers: they do
 * nothing at runtime. `@znight/compiler` maps them to their interceptor through this package's
 * manifest (`package.json#znight.interceptors`), binds the interceptor external
 * (`@znight/observability#LoggedInterceptor`...) and emits the options as a literal. Options are
 * _value_ arguments: literals or references to exported constants.
 */
import type { MethodMarker } from '@znight/core'
import type { LoggedOptions } from './interceptors/logged.ts'
import type { MetricOptions } from './interceptors/metric.ts'
import type { TracedOptions } from './interceptors/traced.ts'

function marker(): void {
  // intentionally empty: decorators are compile-time markers
}

const methodMarker: MethodMarker = marker

/**
 * Logs each call of the method (duration, optionally arguments and result; errors at `errorLevel`)
 * through {@link LoggedInterceptor}.
 *
 * ```ts
 * @Logged({ level: 'info', args: true })
 * async createUser(dto: CreateUserDto): Promise<User> { ... }
 * ```
 */
export function Logged(_options?: LoggedOptions): MethodMarker {
  return methodMarker
}

/**
 * Runs each call of the method in its own OpenTelemetry span through {@link TracedInterceptor}.
 *
 * ```ts
 * @Traced({ name: 'billing.charge', attributes: { 'billing.provider': 'stripe' } })
 * async charge(order: Order): Promise<Receipt> { ... }
 * ```
 */
export function Traced(_options?: TracedOptions): MethodMarker {
  return methodMarker
}

/**
 * Records each call of the method in a Prometheus histogram (duration) or counter through
 * {@link MetricInterceptor}, labelled with `class`, `method` and `outcome`.
 *
 * ```ts
 * @Metric({ name: 'orders_placed_total', type: 'counter', help: 'Orders placed' })
 * async placeOrder(cart: Cart): Promise<Order> { ... }
 * ```
 */
export function Metric(_options?: MetricOptions): MethodMarker {
  return methodMarker
}
