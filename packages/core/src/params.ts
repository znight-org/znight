/**
 * Custom parameter decorators (RFC 0010). `createParamDecorator` returns a marker decorator, read
 * by `@znight/compiler`, and keeps the resolvers that the generated `invoke` of each transport calls.
 */
import type { ParameterMarker } from './decorators.ts'

/**
 * Resolver contexts by transport. Each transport package adds its own entry through declaration
 * merging (`http: HttpContext` in `@znight/http`, `graphql: ResolverContext`, `messaging:
 * InboundMessage`); a transport that is not installed has no entry.
 *
 * ```ts
 * declare module '@znight/core' {
 *   interface ParamContexts {
 *     http: HttpContext
 *   }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmented by the transport packages (declaration merging)
export interface ParamContexts {}

/** A provider computing the value of a parameter, in the scope of the call (RFC 0010 §4.6). */
export interface ParamResolver<C, T, D = undefined> {
  resolve(ctx: C, data: D): T | PromiseLike<T>
}

/** A resolver function: receives the context of its transport and the data argument of the use. */
export type ParamResolverFunction<C, T, D> = (ctx: C, data: D) => T | PromiseLike<T>

/** The class of a provider implementing {@link ParamResolver} (bound at build time, resolved in the scope of the call). */
export type ParamResolverClass<C, T, D> = abstract new (...args: never[]) => ParamResolver<C, T, D>

/** Computes the value of a parameter: a function, or the class of a provider implementing {@link ParamResolver}. */
export type ParamResolverOf<C, T, D> = ParamResolverFunction<C, T, D> | ParamResolverClass<C, T, D>

/** The resolvers of a definition, by transport (keys of {@link ParamContexts}). */
export type ParamResolvers<T, D> = {
  readonly [K in keyof ParamContexts]?: ParamResolverOf<ParamContexts[K], T, D>
}

/** Arguments of a use: none when `D` is `undefined`, optional when `D` includes `undefined`, required otherwise. */
export type ParamDataArgs<D> = undefined extends D ? [data?: D] : [data: D]

/** What {@link createParamDecorator} returns: the decorator (a no-op marker) and its resolvers, for generated code. */
export interface ParamDecorator<T, D = undefined> {
  (...data: ParamDataArgs<D>): ParameterMarker
  /** The resolvers of the definition, frozen. */
  readonly resolvers: ParamResolvers<T, D>
}

/**
 * The resolver function of a definition for a transport, as generated code calls it:
 * `(CurrentUser.resolvers.http as ParamFunctionOf<typeof CurrentUser, 'http'>)(ctx, undefined)`.
 * The compiler emits it only for function resolvers.
 */
export type ParamFunctionOf<P extends { readonly resolvers: object }, K extends keyof P['resolvers']> = Extract<
  NonNullable<P['resolvers'][K]>,
  // biome-ignore lint/suspicious/noExplicitAny: matches every function type, whatever its parameters
  (...args: any[]) => unknown
>

function marker(): void {
  // intentionally empty: decorators are compile-time markers
}

const parameterMarker: ParameterMarker = marker

/**
 * Defines a parameter decorator whose value is computed per call by a resolver of the handler's
 * transport (RFC 0010). `T` (required) is the injected type, checked at build time against every
 * decorated parameter; `D` is the type of the data argument (none by default). The definition must
 * be an exported top-level `const`: the generated module imports it.
 *
 * ```ts
 * export const CurrentUser = createParamDecorator<User>({
 *   http: ctx => userOf(ctx.state),
 *   graphql: ctx => userOf(ctx.operation.state),
 * })
 *
 * @Get('/me')
 * me(@CurrentUser() user: User) { ... }
 * ```
 */
export function createParamDecorator<T, D = undefined>(resolvers: ParamResolvers<T, D>): ParamDecorator<T, D> {
  const decorator = ((..._data: ParamDataArgs<D>): ParameterMarker => parameterMarker) as ParamDecorator<T, D>
  Object.defineProperty(decorator, 'resolvers', { value: Object.freeze({ ...resolvers }), enumerable: true })
  return decorator
}
