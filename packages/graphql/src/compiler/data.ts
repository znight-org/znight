/**
 * Data stored by the extension during analysis (`ctx.store()`), read back by `validate` and
 * `generate`. Only what compiled libraries can encode: primitives, plain objects and arrays,
 * `ClassInfo` (kept for its identity), `ValueRef`, `BindingHandle` and `Location`. Methods and
 * parameters are looked up again by name and index (`ctx.classInfo(host.identity)`).
 */

import type { BindingHandle, ClassInfo, ClassRef, Location, ValueRef } from '@znight/compiler'
import type { Scope } from '@znight/core'
import type { MetaEntry } from '@znight/http/compiler'

/** Kind of field a resolver method provides. */
export type FieldOperation = 'query' | 'mutation' | 'subscription' | 'field'

/** A `@Resolver` class. */
export interface ResolverData {
  readonly kind: 'resolver'
  /** The resolver class; its identity is the provider token. */
  readonly host: ClassInfo
  readonly scope: Scope
  /** Location of `@Resolver`. */
  readonly location: Location
  /**
   * `@Resolver('Event')`: the SDL object type its `@ResolveField` methods belong to (schema-first,
   * RFC 0007), with the location of the argument.
   */
  readonly typeName?: { readonly name: string; readonly location: Location }
  /** Class `@UseGuard` guards. */
  readonly guards: readonly ClassRef[]
  /** One entry per field decorator of the class's methods, in source order. */
  readonly fields: readonly FieldData[]
}

/** One `@Query`, `@Mutation`, `@Subscription` or `@ResolveField` decorator. */
export interface FieldData {
  /** Method name. */
  readonly method: string
  readonly operation: FieldOperation
  /** GraphQL field name (decorator argument, or the method name). */
  readonly name: string
  /** Location of the field decorator. */
  readonly location: Location
  /** Location of the method name. */
  readonly methodLocation: Location
  /** Method `@UseGuard` guards (class guards are on {@link ResolverData.guards}). */
  readonly guards: readonly ClassRef[]
  /** Effective route metadata: the class entries a method decision does not replace, then the method's. */
  readonly meta: readonly MetaEntry[]
  /** One entry per method parameter, by index (`undefined`: the parameter could not be analysed). */
  readonly params: readonly (ParamData | undefined)[]
  /** `false` when a parameter or the method could not be analysed (an error was reported). */
  readonly complete: boolean
}

/** What a method parameter receives (§7.3). */
export type ParamData =
  | {
      readonly kind: 'args'
      /** `@Args('name')`: one argument; `undefined`: the properties of the type are the arguments. */
      readonly name: string | undefined
      /** `@Args(..., Schema)`: the Standard Schema validating the value. */
      readonly schema: ValueRef | undefined
      readonly location: Location
    }
  | { readonly kind: 'parent'; readonly location: Location }
  | { readonly kind: 'ctx' }
  | { readonly kind: 'info' }
  | {
      readonly kind: 'loader'
      /** Binding of the loader provider (lazy edge from the resolver). */
      readonly binding: BindingHandle
      /** Identity of `L` in `Loader<L>`. */
      readonly identity: string
      readonly location: Location
    }

/** Everything the extension stores. */
export type GraphQLData = ResolverData
