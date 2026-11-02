/**
 * Marker decorators of `@znight/graphql` (RFC 0005 §5.14). Like every Znight decorator they do
 * nothing at runtime: the compiler extension (`@znight/graphql/compiler`) reads them from the source
 * code, derives the schema from the TypeScript types they reach and generates
 * `metadata.extensions.graphql`. Arguments marked _static_ must be statically evaluable (literals,
 * `const` references); _value_ arguments may also be references to exported bindings (schemas,
 * guard classes). See docs/internals/architecture.md §4.6.
 *
 * Also here: `scalar<T>()`, the scalar aliases (`ID`, `Int`, `Float`, `JSONValue`) and `Loader<L>`,
 * which shares its name with the `@Loader()` decorator (one identity, `@znight/graphql#Loader`, for
 * the parameter decorator and the parameter type).
 */
import type { ClassMarker, MethodMarker, ParameterMarker, Scope } from '@znight/core'
import type { StandardSchemaV1 } from '@znight/http'
import type { GraphQLScalarType } from 'graphql'
import type { BatchLoad, BatchLoader, GraphQLGuardClass, LoaderKey, LoaderValue, ScalarDefinition } from './types.ts'

function marker(): void {
  // intentionally empty: decorators are compile-time markers
}

const classMarker: ClassMarker = marker
const methodMarker: MethodMarker = marker
const parameterMarker: ParameterMarker = marker
const classOrMethodMarker: ClassMarker & MethodMarker = marker

/** GraphQL `ID`: a string on the wire and in TypeScript. Recognised by the compiler through the alias. */
export type ID = string

/** GraphQL `Int` (32-bit signed integer). A `number` in TypeScript; plain `number` maps to `Float`. */
export type Int = number

/** GraphQL `Float`. Same as `number`, for symmetry with {@link Int}. */
export type Float = number

/** Any JSON value: the `JSON` scalar. */
export type JSONValue = string | number | boolean | null | readonly JSONValue[] | { readonly [key: string]: JSONValue }

/**
 * The DataLoader of the current execution for the loader provider `L`, injected with `@Loader()`:
 * created on first use, cached for the operation (or for one subscription event), then dropped.
 *
 * ```ts
 * @ResolveField()
 * author(@Parent() book: Book, @Loader() authors: Loader<AuthorsById>): Promise<Author> {
 *   return authors.load(book.authorId)
 * }
 * ```
 */
export type Loader<L extends BatchLoad<unknown, unknown>> = BatchLoader<LoaderKey<L>, LoaderValue<L>>

/** Options of {@link Resolver} (static). */
export interface ResolverOptions {
  /** Provider scope. Default: `singleton`; `request` creates one resolver per operation. */
  readonly scope?: Scope
}

/**
 * Declares a resolver: a provider (singleton by default) whose `@Query`, `@Mutation`,
 * `@Subscription` and `@ResolveField` methods are fields of the schema. Route decorators of
 * `@znight/http` (`createRouteDecorator`) on the class are the default decisions of its fields.
 *
 * ```ts
 * @Resolver()
 * export class BookResolver {
 *   constructor(private readonly catalog: CatalogService) {}
 *
 *   @Query()
 *   book(@Args('id') id: ID): Promise<Book | null> {
 *     return this.catalog.find(id)
 *   }
 * }
 * ```
 *
 * @param options static: `{ scope? }`.
 */
export function Resolver(_options?: ResolverOptions): ClassMarker {
  return classMarker
}

/**
 * A field of the `Query` root type. The method's declared return type is the field type
 * (`Promise<T>` unwrapped), its `@Args` the arguments, its JSDoc the description.
 *
 * @param name static: field name. Default: the method name.
 */
export function Query(_name?: string): MethodMarker {
  return methodMarker
}

/**
 * A field of the `Mutation` root type.
 *
 * @param name static: field name. Default: the method name.
 */
export function Mutation(_name?: string): MethodMarker {
  return methodMarker
}

/**
 * A field of the `Subscription` root type. The method returns an `AsyncIterable<T>` (an async
 * generator, or `pubsub.subscribe(...)`), each value being the field value of one event.
 *
 * @param name static: field name. Default: the method name.
 */
export function Subscription(_name?: string): MethodMarker {
  return methodMarker
}

/**
 * A field resolver: adds a field to the type of the `@Parent()` parameter (mandatory), or replaces
 * the property field of the same name.
 *
 * @param name static: field name. Default: the method name.
 */
export function ResolveField(_name?: string): MethodMarker {
  return methodMarker
}

/**
 * Field arguments. Without a name, the properties of the parameter type become arguments
 * (`@Args() filter: BookFilter`); with a name, one argument (`@Args('id') id: ID`). With a Standard
 * Schema, the value is validated (and transformed) after GraphQL coerced it; a failure is a
 * `BAD_USER_INPUT` error listing the issues.
 *
 * @param name static: argument name.
 * @param schema value: a Standard Schema validating the value (its output is injected).
 */
export function Args(): ParameterMarker
export function Args(name: string, schema?: StandardSchemaV1): ParameterMarker
export function Args(schema: StandardSchemaV1): ParameterMarker
export function Args(_nameOrSchema?: string | StandardSchemaV1, _schema?: StandardSchemaV1): ParameterMarker {
  return parameterMarker
}

/** The parent object of a field resolver (`@ResolveField` only; its type is the parent type). */
export function Parent(): ParameterMarker {
  return parameterMarker
}

/** The `GraphQLContext` of the operation. */
export function Ctx(): ParameterMarker {
  return parameterMarker
}

/** The graphql-js `GraphQLResolveInfo` of the call (escape hatch). */
export function Info(): ParameterMarker {
  return parameterMarker
}

/** The DataLoader of the current execution for the `Loader<L>` parameter type (see {@link Loader}). */
export function Loader(): ParameterMarker {
  return parameterMarker
}

/**
 * Guards of the fields of a resolver class or of one field, run after the global guards (class
 * guards, then method guards). Guards are providers implementing `GraphQLGuard`.
 *
 * @param guards value: guard classes.
 */
export function UseGuard(..._guards: [GraphQLGuardClass, ...GraphQLGuardClass[]]): ClassMarker & MethodMarker {
  return classOrMethodMarker
}

/**
 * Maps the TypeScript type `T` to the GraphQL scalar `name` wherever it appears. `name` is static;
 * the returned definition must be exported (`export const`): the generated module imports it.
 * Returns `definition` unchanged.
 *
 * ```ts
 * export type EmailAddress = string & { readonly __brand: 'EmailAddress' }
 *
 * export const EmailAddressScalar = scalar<EmailAddress>('EmailAddress', {
 *   serialize: value => value,
 *   parseValue: value => {
 *     if (typeof value !== 'string' || !value.includes('@')) throw new TypeError('Expected an e-mail address')
 *     return value.toLowerCase() as EmailAddress
 *   },
 * })
 *
 * export const UrlScalar = scalar<URL>('URL', GraphQLURL) // a graphql-js GraphQLScalarType
 * ```
 *
 * @param name static: the GraphQL name of the scalar.
 * @param definition value: a {@link ScalarDefinition} or a graphql-js `GraphQLScalarType` (whose
 *   name must be `name`, ZNIGHT066 at boot otherwise).
 */
export function scalar<T>(name: string, definition: ScalarDefinition<T>): ScalarDefinition<T>
export function scalar<T>(name: string, definition: GraphQLScalarType): GraphQLScalarType<T>
export function scalar<T>(
  _name: string,
  definition: ScalarDefinition<T> | GraphQLScalarType,
): ScalarDefinition<T> | GraphQLScalarType {
  return definition
}
