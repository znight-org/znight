/**
 * The schema model built by `validate` (RFC 0005 §6.1) and emitted by `generate` (§7): the GraphQL
 * types reachable from the root fields, with their TypeScript origins (locations, resolver data).
 */
import type { Location } from '@znight/compiler'
import type { MetaEntry } from '@znight/http/compiler'
import type { GraphQLTypeRef } from '../type-ref.ts'
import type { FieldData, ResolverData } from './data.ts'

/** A field of an object type. */
export interface FieldModel {
  readonly name: string
  /** Printed type reference (`'[Book!]!'`). */
  type: string
  description: string | undefined
  deprecationReason: string | undefined
  readonly args: ArgModel[]
  /** The resolver method behind the field; `undefined`: the default resolver (`parent[name]`). */
  binding: { readonly resolver: ResolverData; readonly field: FieldData } | undefined
  readonly location: Location | undefined
}

/** An argument or an input field. */
export interface ArgModel {
  readonly name: string
  type: string
  ref: GraphQLTypeRef
  readonly description: string | undefined
  readonly deprecationReason: string | undefined
  /** External default value (enum values by name); `undefined`: no default. */
  defaultValue: unknown
  /** The TypeScript type does not accept `null` (§5.4). */
  nullAsUndefined: boolean
  readonly location: Location | undefined
}

/** What every named type of the model has. */
interface BaseModel {
  readonly name: string
  /** The declaration key (shapes) or a synthetic key (`#root:query`, `#builtin:DateTime`). */
  readonly key: string
  readonly description: string | undefined
  readonly location: Location | undefined
}

/** An object type (root types included). */
export interface ObjectModel extends BaseModel {
  readonly kind: 'object'
  readonly fields: FieldModel[]
  /** How the type was first reached (`Query.book → Book`), for "reached from" diagnostics. */
  readonly trail: string
  /** The root field the type was first reached from. */
  readonly root: Location | undefined
  /** Identity of the class when the type is a non-generic class (union discriminators). */
  readonly classIdentity: string | undefined
  /** Property names of the declaration, with their literal value when they have one (discriminators). */
  readonly properties: readonly DiscriminantProperty[]
  /** Implemented interfaces (schema-first, RFC 0007), in declaration order; empty in code-first. */
  readonly interfaces: readonly string[]
}

/** An interface type (schema-first, RFC 0007). Its fields have no binding. */
export interface InterfaceModel extends BaseModel {
  readonly kind: 'interface'
  readonly fields: FieldModel[]
  readonly interfaces: readonly string[]
  discriminator: DiscriminatorModel | undefined
}

/** A property of an object type's declaration, as union discriminators see it. */
export interface DiscriminantProperty {
  readonly name: string
  readonly optional: boolean
  /** The literal value of a literal-typed property. */
  readonly literal: string | number | boolean | undefined
}

/** An input object type. */
export interface InputModel extends BaseModel {
  readonly kind: 'input'
  readonly fields: ArgModel[]
}

/** An enum type. */
export interface EnumModel extends BaseModel {
  readonly kind: 'enum'
  readonly values: readonly EnumValueModel[]
}

/** A value of an enum. */
export interface EnumValueModel {
  readonly name: string
  readonly value: string | number
  readonly description: string | undefined
  readonly deprecationReason: string | undefined
}

/** A union type. */
export interface UnionModel extends BaseModel {
  readonly kind: 'union'
  members: readonly string[]
  discriminator: DiscriminatorModel | undefined
}

/** How the runtime tells union members apart. */
export type DiscriminatorModel =
  | { readonly by: 'property'; readonly property: string; readonly values: Readonly<Record<string, string>> }
  | { readonly by: 'class'; readonly classes: readonly { readonly identity: string; readonly name: string }[] }
  | { readonly by: 'typename' }

/** A scalar: built in (`DateTime`, `BigInt`, `JSON`) or declared with `scalar<T>()`. */
export interface ScalarModel extends BaseModel {
  readonly kind: 'scalar'
  /** Identity of the exported `scalar<T>()` constant; `undefined` for a built-in scalar. */
  readonly definition: string | undefined
  readonly specifiedByURL: string | undefined
  /**
   * Schema-first: the description and `specifiedByURL` come from the SDL and are emitted in the
   * metadata, where they win over the definition's (RFC 0007 §5.2).
   */
  readonly fromSdl?: true
}

/** A named type of the model. */
export type TypeModel = ObjectModel | InterfaceModel | InputModel | EnumModel | UnionModel | ScalarModel

/** The schema of the application, built once per compile. */
export interface GraphQLModel {
  readonly roots: { readonly query: string; readonly mutation?: string; readonly subscription?: string }
  /** Sorted by name. */
  readonly types: readonly TypeModel[]
  /** Route metadata entries of every field (effective), for `groups`. */
  readonly meta: readonly MetaEntry[]
  /** The SDL (`printSdl`), without trailing newline. */
  readonly sdl: string
  readonly schemaHash: string
}
