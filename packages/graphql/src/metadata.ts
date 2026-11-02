/**
 * GraphQL section of the generated metadata (`__ZNIGHT_METADATA__.extensions.graphql`, RFC 0005
 * §7), produced by the `@znight/graphql/compiler` extension and consumed by `GraphQLPlugin`, which
 * validates it at boot (ZNIGHT066), because metadata can be hand-written.
 *
 * Data, not code, except `invoke` (one arrow per resolver) and the scalar implementations imported
 * from user code. The SDL printer (`sdl.ts`) reads the same shape without its functions.
 *
 * Import-free: types, type-only imports and one constant, shared by the compiler extension and the
 * runtime.
 */
import type { Token } from '@znight/core'
import type { HttpRouteGroupDefinition } from '@znight/http'
import type { GraphQLResolveInfo, GraphQLScalarType } from 'graphql'
import type { GraphQLArgs, GraphQLContext, ScalarDefinition } from './types.ts'

/** Format version of `metadata.extensions.graphql` (another version is ZNIGHT066 at boot). */
export const GRAPHQL_METADATA_VERSION = 1

/** The schema of the application. The section is omitted when the application has no resolver. */
export interface GraphQLMetadata {
  /** {@link GRAPHQL_METADATA_VERSION}. */
  readonly version: number
  /** First 16 hexadecimal characters of the SHA-256 of the SDL (`printSdl`): logs, caches. */
  readonly schemaHash: string
  readonly roots: GraphQLRootTypes
  /** Every named type except the graphql-js specified scalars, sorted by name (code-unit order). */
  readonly types: readonly GraphQLTypeDefinition[]
  /**
   * Route decorator groups used on resolvers that must be known at runtime (required, or holding
   * several keys), by group name: the shape of `extensions.http.groups` (RFC 0001).
   */
  readonly groups?: Readonly<Record<string, HttpRouteGroupDefinition>>
}

/** Names of the root operation types (`Query`, `Mutation`, `Subscription`). */
export interface GraphQLRootTypes {
  readonly query: string
  readonly mutation?: string
  readonly subscription?: string
}

/** A named type of the schema. */
export type GraphQLTypeDefinition =
  | GraphQLObjectTypeDefinition
  | GraphQLInputTypeDefinition
  | GraphQLEnumTypeDefinition
  | GraphQLUnionTypeDefinition
  | GraphQLBuiltinScalarDefinition
  | GraphQLCustomScalarDefinition

/** An object type: resolver return types, their fields, the root types. */
export interface GraphQLObjectTypeDefinition {
  readonly kind: 'object'
  readonly name: string
  readonly description?: string
  /** Declaration order (base members first), then field resolvers by resolver token and source order. */
  readonly fields: readonly GraphQLFieldDefinition[]
}

/** An input object type. */
export interface GraphQLInputTypeDefinition {
  readonly kind: 'input'
  readonly name: string
  readonly description?: string
  readonly fields: readonly GraphQLInputFieldDefinition[]
}

/** An enum: a TypeScript `enum`, or a named alias of a union of string literals. */
export interface GraphQLEnumTypeDefinition {
  readonly kind: 'enum'
  readonly name: string
  readonly description?: string
  /** Declaration order. */
  readonly values: readonly GraphQLEnumValueDefinition[]
}

/** A union of object types. */
export interface GraphQLUnionTypeDefinition {
  readonly kind: 'union'
  readonly name: string
  readonly description?: string
  /** Member type names, sorted. */
  readonly members: readonly string[]
  readonly discriminator: GraphQLDiscriminator
}

/** A scalar implemented by `@znight/graphql`: `DateTime`, `BigInt` or `JSON` (`names.ts`). */
export interface GraphQLBuiltinScalarDefinition {
  readonly kind: 'scalar'
  readonly name: string
  readonly description?: string
  readonly builtin: true
}

/** A scalar declared with `scalar<T>(name, definition)`: the definition is imported from user code. */
export interface GraphQLCustomScalarDefinition {
  readonly kind: 'scalar'
  readonly name: string
  /** `ScalarDefinition<T>` of any `T` (its methods are bivariant), or a graphql-js scalar named `name`. */
  readonly scalar: ScalarDefinition<unknown> | GraphQLScalarType
}

/** A field of an object type. */
export interface GraphQLFieldDefinition {
  readonly name: string
  /** Type reference (`'Book!'`, `'[Book!]!'`, `'Int'`), parsed by `type-ref.ts`. */
  readonly type: string
  readonly description?: string
  readonly deprecationReason?: string
  readonly args?: readonly GraphQLArgumentDefinition[]
  /** Absent: the graphql-js default resolver (`parent[name]`). */
  readonly resolver?: GraphQLResolverBinding
}

/** An argument of a field. */
export interface GraphQLArgumentDefinition {
  readonly name: string
  readonly type: string
  readonly description?: string
  readonly deprecationReason?: string
  /**
   * Default value, as an external value: JSON-compatible, enum values by GraphQL name (passed to
   * graphql-js as `default: { value }`). Absent: no default.
   */
  readonly defaultValue?: unknown
  /** The TypeScript type does not accept `null`: a `null` sent by the client becomes `undefined` (§5.4). */
  readonly nullAsUndefined?: true
}

/** A field of an input object type. */
export interface GraphQLInputFieldDefinition extends GraphQLArgumentDefinition {}

/** A value of an enum. */
export interface GraphQLEnumValueDefinition {
  /** GraphQL name (the member name, or the literal). */
  readonly name: string
  /** Internal value (the member value, or the literal), what resolvers receive and return. */
  readonly value: string | number
  readonly description?: string
  readonly deprecationReason?: string
}

/** How the runtime tells the members of a union apart (`resolveType`). */
export type GraphQLDiscriminator =
  | {
      readonly by: 'property'
      readonly property: string
      /** Literal value of the property (as a string) → member type name. */
      readonly values: Readonly<Record<string, string>>
    }
  | {
      readonly by: 'class'
      /** Member classes and their type names, subclasses first (`instanceof` order). */
      readonly classes: readonly (readonly [cls: abstract new (...args: never[]) => unknown, name: string])[]
    }
  | { readonly by: 'typename' }

/** Kind of field a resolver method provides. */
export type GraphQLResolverOperation = 'query' | 'mutation' | 'subscription' | 'field'

/** The resolver method behind a field. */
export interface GraphQLResolverBinding {
  /** Provider token of the resolver class. */
  readonly token: Token
  readonly method: string
  readonly operation: GraphQLResolverOperation
  /** Guard provider tokens: class `@UseGuard` guards, then method ones. */
  readonly guards: readonly Token[]
  /**
   * Effective field metadata (`createRouteDecorator` values, method decisions over class ones, one
   * decision per group). Empty: no metadata, so global guards skip a field resolver (§5.9).
   */
  readonly meta: Readonly<Record<string, unknown>>
  /** Informational: loader provider tokens the method injects. */
  readonly loaders?: readonly Token[]
  /**
   * Calls the method: maps the graphql-js arguments to the method parameters (§7.3). Synchronous
   * unless an argument is validated with a Standard Schema.
   */
  readonly invoke: (
    // biome-ignore lint/suspicious/noExplicitAny: generated invokers receive the concrete resolver class
    resolver: any,
    parent: unknown,
    args: GraphQLArgs,
    context: GraphQLContext,
    info: GraphQLResolveInfo,
  ) => unknown
}

declare module '@znight/core' {
  interface ZnightExtensionsMetadata {
    readonly graphql?: GraphQLMetadata
  }
}
