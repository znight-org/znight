/**
 * Marker decorators. They are read from the source code by `@znight/compiler` and do nothing at
 * runtime: every factory returns the same shared no-op function (and the Vite plugin strips them
 * from the bundle by default). They support TypeScript `experimentalDecorators` (class, method and
 * parameter positions); class and method markers also type-check as standard decorators.
 *
 * Arguments marked _static_ must be statically evaluable by the compiler (literals, `const`
 * references, simple expressions); see docs/internals/architecture.md §4.6.
 */
import type { MethodInterceptor } from './aop.ts'
import type { Scope } from './metadata.ts'

/** A class constructor, as received by a class decorator. */
type AnyClass = abstract new (...args: never[]) => unknown

/** Marker usable on a class. */
export type ClassMarker = (target: AnyClass, context?: ClassDecoratorContext) => void

/** Marker usable on a method (instance or static). */
export type MethodMarker = (
  target: object,
  propertyKeyOrContext: string | symbol | ClassMethodDecoratorContext,
  descriptor?: PropertyDescriptor,
) => void

/** Marker usable on a constructor or method parameter (`experimentalDecorators` only). */
export type ParameterMarker = (target: object, propertyKey: string | symbol | undefined, parameterIndex: number) => void

/** Options of {@link Injectable} (static). */
export interface InjectableOptions {
  /** Lifetime of the instances. Default: `singleton`. */
  readonly scope?: Scope
  /** Qualifier, as with {@link Named}. */
  readonly name?: string
  /** Preferred candidate when several providers match an injection point, as with {@link Primary}. */
  readonly primary?: boolean
}

/** Options of {@link Provides} (static). */
export interface ProvidesOptions extends InjectableOptions {
  /** Name of a method of the provided value called on shutdown (`'end'`, `'close'`...). */
  readonly dispose?: string
}

/** Class implementing {@link MethodInterceptor} with options `O`. */
export type InterceptorClass<O> = abstract new (...args: never[]) => MethodInterceptor<O>

/** Options argument of {@link Intercept}: required when the interceptor options do not accept `undefined`. */
export type InterceptOptionsArgs<O> = undefined extends O ? [options?: NoInfer<O>] : [options: NoInfer<O>]

function marker(): void {
  // intentionally empty: decorators are compile-time markers
}

const classMarker: ClassMarker = marker
const methodMarker: MethodMarker = marker
const parameterMarker: ParameterMarker = marker
const classOrMethodMarker: ClassMarker & MethodMarker = marker

/**
 * Declares a provider class. Its constructor parameters are injected.
 *
 * ```ts
 * @Injectable()
 * export class UserService {
 *   constructor(private readonly repository: UserRepository) {}
 * }
 * ```
 */
export function Injectable(_options?: InjectableOptions): ClassMarker {
  return classMarker
}

/** Declares a singleton whose {@link Provides} methods produce providers. */
export function Factory(): ClassMarker {
  return classMarker
}

/**
 * Declares a provider produced by a method of a {@link Factory} class. The explicit return type is
 * the provided type (`Promise<T>` makes it async, singletons only); parameters are injected.
 *
 * ```ts
 * @Factory()
 * export class DbFactory {
 *   @Provides({ dispose: 'end' })
 *   async createPool(config: DbConfig): Promise<Pool> { ... }
 * }
 * ```
 */
export function Provides(_options?: ProvidesOptions): MethodMarker {
  return methodMarker
}

/** Injects the provider qualified with `name` (see {@link Named}). `name` is static. */
export function Inject(_name: string): ParameterMarker {
  return parameterMarker
}

/** Marks a dependency as optional: `undefined` is injected when no provider exists. */
export function Optional(): ParameterMarker {
  return parameterMarker
}

/** Sets the qualifier of a provider class or `@Provides` method. `name` is static. */
export function Named(_name: string): ClassMarker & MethodMarker {
  return classOrMethodMarker
}

/** Makes a provider the preferred candidate when several providers match an injection point. */
export function Primary(): ClassMarker & MethodMarker {
  return classOrMethodMarker
}

/**
 * Intercepts calls to a method with an interceptor provider (AOP). The top-most `@Intercept` is the
 * outermost interceptor.
 *
 * ```ts
 * @Intercept(TimingInterceptor, { label: 'users.find' })
 * async find(id: string): Promise<User> { ... }
 * ```
 */
export function Intercept<O>(_interceptor: InterceptorClass<O>, ..._options: InterceptOptionsArgs<O>): MethodMarker {
  return methodMarker
}
