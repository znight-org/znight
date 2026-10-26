import type { MethodInterception } from './metadata.ts'

import { ErrorCode, ZnightError } from './errors.ts'
import { isDevelopment, isThenable } from './utils.ts'

/** A call to an intercepted method, as seen by a {@link MethodInterceptor}. */
export interface MethodInvocation {
  /** The instance the method is called on. */
  readonly target: object
  /** Name of the provider (display name) the method belongs to. */
  readonly className: string
  readonly methodName: string
  /** Arguments of this call (as passed to this interceptor). */
  readonly args: readonly unknown[]
  /** Whether the intercepted method is async: interceptors must then return a promise. */
  readonly isAsync: boolean
  /**
   * Calls the next interceptor, or the original method for the innermost one, with `args` (default:
   * the current arguments) and returns its result. May be called several times (retries).
   */
  proceed(args?: readonly unknown[]): unknown
}

/**
 * A provider wrapping method calls (`@Intercept(MyInterceptor, options)`). It must return the value
 * of `invocation.proceed()` (or a replacement): a promise for async methods, a plain value for
 * synchronous ones.
 *
 * ```ts
 * @Injectable()
 * export class TimingInterceptor implements MethodInterceptor<{ label?: string }> {
 *   async intercept(invocation: MethodInvocation, options: { label?: string }) {
 *     const start = performance.now()
 *     try { return await invocation.proceed() }
 *     finally { console.log(options.label ?? invocation.methodName, performance.now() - start) }
 *   }
 * }
 * ```
 */
export interface MethodInterceptor<O = unknown> {
  intercept(invocation: MethodInvocation, options: O): unknown
}

/** One interceptor of a chain with its options. */
export interface InterceptorLink {
  readonly interceptor: MethodInterceptor
  readonly options?: unknown
}

export interface InterceptMethodOptions {
  /** Name used in messages and exposed as `invocation.className`. Default: the constructor name. */
  readonly className?: string
  /** Whether the method is async. Default: `false`. */
  readonly async?: boolean
  /**
   * Throw when an interceptor returns a thenable for a synchronous method.
   * Default: `true` unless `NODE_ENV === 'production'`.
   */
  readonly checkSync?: boolean
}

type Method = (this: unknown, ...args: unknown[]) => unknown

class Chain {
  readonly original: Method
  readonly links: readonly InterceptorLink[]
  readonly className: string
  readonly methodName: string
  readonly isAsync: boolean
  readonly checkSync: boolean

  constructor(
    original: Method,
    links: readonly InterceptorLink[],
    className: string,
    methodName: string,
    isAsync: boolean,
    checkSync: boolean,
  ) {
    this.original = original
    this.links = links
    this.className = className
    this.methodName = methodName
    this.isAsync = isAsync
    this.checkSync = checkSync
  }

  call(index: number, target: object, args: readonly unknown[]): unknown {
    if (index === this.links.length) return this.original.apply(target, args as unknown[])
    const link = this.links[index] as InterceptorLink
    const invocation = new Invocation(this, index, target, args)
    const result = link.interceptor.intercept(invocation, link.options)
    if (this.checkSync && !this.isAsync && result !== invocation.lastResult && isThenable(result)) {
      throw new ZnightError(
        ErrorCode.InvalidDecorator,
        `Interceptor ${interceptorName(link.interceptor)} returned a promise for the synchronous method ` +
          `${this.className}.${this.methodName}()`,
        { hints: ['Make the method async, or return invocation.proceed() synchronously from the interceptor'] },
      )
    }
    return result
  }
}

class Invocation implements MethodInvocation {
  readonly target: object
  readonly args: readonly unknown[]
  /** Last value returned by `proceed()` (lets the sync check accept pass-through thenables). */
  lastResult: unknown = undefined
  readonly #chain: Chain
  readonly #index: number

  constructor(chain: Chain, index: number, target: object, args: readonly unknown[]) {
    this.#chain = chain
    this.#index = index
    this.target = target
    this.args = args
  }

  get className(): string {
    return this.#chain.className
  }

  get methodName(): string {
    return this.#chain.methodName
  }

  get isAsync(): boolean {
    return this.#chain.isAsync
  }

  proceed(args?: readonly unknown[]): unknown {
    this.lastResult = this.#chain.call(this.#index + 1, this.target, args ?? this.args)
    return this.lastResult
  }
}

function interceptorName(interceptor: MethodInterceptor): string {
  const name = (interceptor as { constructor?: { name?: unknown } }).constructor?.name
  return typeof name === 'string' && name !== '' && name !== 'Object' ? name : '<anonymous interceptor>'
}

function assertInterceptor(value: unknown, where: string): asserts value is MethodInterceptor {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function') ||
    typeof (value as { intercept?: unknown }).intercept !== 'function'
  ) {
    throw new ZnightError(ErrorCode.InvalidDecorator, `${where}: the interceptor has no intercept() method`, {
      hints: ['Interceptors passed to @Intercept() must implement MethodInterceptor'],
    })
  }
}

/**
 * Wraps `target[methodName]` with `chain` (first link = outermost interceptor). The wrapper is
 * installed as an own, non-enumerable property of `target` (no Proxy): `#private` fields keep
 * working and calls through `this` (self-invocation) are intercepted too.
 *
 * @throws ZnightError (ZNIGHT005) when the method or an interceptor is invalid.
 */
export function interceptMethod(
  target: object,
  methodName: string,
  chain: readonly InterceptorLink[],
  options: InterceptMethodOptions = {},
): void {
  const className = options.className ?? (target.constructor?.name || 'Object')
  const original: unknown = (target as Record<string, unknown>)[methodName]
  if (typeof original !== 'function') {
    throw new ZnightError(ErrorCode.InvalidDecorator, `Cannot intercept ${className}.${methodName}: it is not a method`)
  }
  if (chain.length === 0) return
  for (const link of chain) assertInterceptor(link.interceptor, `Cannot intercept ${className}.${methodName}()`)
  const compiled = new Chain(
    original as Method,
    [...chain],
    className,
    methodName,
    options.async ?? false,
    options.checkSync ?? isDevelopment(),
  )
  const wrapper = function (this: unknown, ...args: unknown[]): unknown {
    return compiled.call(0, this === undefined || this === null ? target : (this as object), args)
  }
  Object.defineProperty(wrapper, 'name', { value: methodName, configurable: true })
  Object.defineProperty(target, methodName, { value: wrapper, writable: true, configurable: true, enumerable: false })
}

/**
 * Applies the interceptors of a provider definition to a freshly created instance. `deps` are the
 * resolved dependencies of the provider (`InterceptorBinding.dep` indexes into them).
 */
export function applyInterceptors(
  target: object,
  interceptions: Readonly<Record<string, MethodInterception>>,
  deps: readonly unknown[],
  className?: string,
): void {
  const name = className ?? (target.constructor?.name || 'Object')
  for (const [methodName, interception] of Object.entries(interceptions)) {
    const links: InterceptorLink[] = []
    for (const binding of interception.chain) {
      if (binding.dep < 0 || binding.dep >= deps.length) {
        throw new ZnightError(
          ErrorCode.InvalidDecorator,
          `Cannot intercept ${name}.${methodName}(): interceptor dependency #${binding.dep} does not exist`,
        )
      }
      const interceptor = deps[binding.dep]
      assertInterceptor(interceptor, `Cannot intercept ${name}.${methodName}()`)
      links.push({ interceptor, options: binding.options })
    }
    interceptMethod(target, methodName, links, { className: name, async: interception.async })
  }
}
