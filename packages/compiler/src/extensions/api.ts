/**
 * Public compiler extension API (spec §6.5).
 *
 * A feature package (`@znight/http`, `@znight/messaging`...) ships a compiler extension in a
 * dedicated entry (`@znight/http/compiler`) declared in its manifest (`package.json#znight.compiler`).
 * That entry **only `import type`s** from `@znight/compiler`: everything an extension needs at
 * runtime (type formatting, evaluation, code builders) is reached through the context objects it
 * receives, so building a feature package never loads the compiler.
 *
 * ```ts
 * import type { CompilerExtension } from '@znight/compiler'
 *
 * export default {
 *   apiVersion: 1,
 *   name: 'http',
 *   decorators: {
 *     '@znight/http#Controller': { targets: ['class'], params: ['static'] },
 *     '@znight/http#Get': { targets: ['method'], params: ['static'] },
 *     '@znight/http#UseGuard': { targets: ['class', 'method'], params: [], rest: 'value' },
 *   },
 *   analyzeClass(cls, ctx) {
 *     const controller = cls.decorators.find(d => d.identity === '@znight/http#Controller')
 *     if (!controller) return
 *     ctx.registerProvider(cls)
 *     ctx.store({ token: cls.identity, routes: [...] })
 *   },
 * } satisfies CompilerExtension
 * ```
 */
import type { DependencyRef, Scope, Token } from '@znight/core'
import type { Decorator, Expression } from 'oxc-parser'
import type { ApplicationGraph, ProviderNode } from '../graph/types.ts'
import type { ResolvedOptions } from '../options.ts'
import type {
  Declaration,
  Diagnostic,
  ImportRoute,
  ImportRouteFailure,
  Location,
  Project,
  ReferenceType,
  StaticValue,
  TypeInfo,
  ValueRef,
} from '../project/index.ts'
import type { GenerateContext, GenNode } from './generate.ts'

/** Version of the compiler extension API implemented by this compiler. */
export const EXTENSION_API_VERSION = 1

/**
 * Where a decorator may be applied:
 * - `class`, `method` (methods and accessors), `property` (class fields and auto-accessors);
 * - `parameter`: a parameter of a method (not of the constructor);
 * - `constructorParameter`: a parameter of the constructor.
 */
export type DecoratorTarget = 'class' | 'method' | 'property' | 'parameter' | 'constructorParameter'

/**
 * How a decorator argument is evaluated (§4.6):
 * - `static`: MUST be statically evaluable (paths, names, scopes, queue names, env names);
 * - `value`: evaluated when possible, otherwise MUST be a reference to an exported binding that the
 *   generated module imports (schemas, guards, defaults, options). References may also appear
 *   nested in evaluated objects/arrays (`{ schema: CreateUser }`).
 */
export type ArgKind = 'static' | 'value'

/** Declaration of a decorator owned by an extension. */
export interface DecoratorSpec {
  /** Allowed targets; any other usage is ZNIGHT005. */
  readonly targets: readonly DecoratorTarget[]
  /** Kind of each positional argument. Missing arguments are allowed (optional parameters). */
  readonly params: readonly ArgKind[]
  /**
   * Kind of the arguments after `params` (variadic decorators such as `@UseGuard(...guards)`).
   * Without it, extra arguments are ZNIGHT005.
   */
  readonly rest?: ArgKind
}

/**
 * A compiler extension (§6.5). `TData` is the type of the data the extension stores during
 * analysis ({@link AnalyzeContext.store}) and reads back in {@link validate} / {@link generate}.
 */
export interface CompilerExtension<TData = unknown> {
  /** Must be {@link EXTENSION_API_VERSION}; another version is ZNIGHT018 and the extension is ignored. */
  readonly apiVersion: 1
  /** Unique name, also the key of the extension's section in `metadata.extensions`. */
  readonly name: string
  /** Decorators owned by the extension, by canonical identity (`'@znight/http#Get'`). */
  readonly decorators: Readonly<Record<string, DecoratorSpec>>
  /**
   * Called once for every analysed class carrying at least one decorator owned by the extension
   * (on the class, a member or a parameter), in identity order, after the core analysis.
   */
  analyzeClass?(cls: ClassInfo, ctx: AnalyzeContext<TData>): void
  /** Called once after binding and core validation. */
  validate?(ctx: ValidateContext<TData>): void
  /** Called by the code generator; returns the extension's `metadata.extensions[name]` value. */
  generate?(ctx: GenerateContext<TData>): GenNode | undefined
}

/** Member visibility. `#private` members are `private` with `privateName: true`. */
export type Visibility = 'public' | 'protected' | 'private'

/** A statically evaluated decorator argument (or property initializer). */
export interface ArgInfo {
  /** Declared kind (`undefined` for decorators not owned by the core or an extension: not evaluated). */
  readonly kind: ArgKind | undefined
  /**
   * `true` when {@link value} holds the evaluated value (it may legitimately be `undefined`).
   * For `value` arguments it may contain nested {@link ValueRef}s.
   */
  readonly evaluated: boolean
  readonly value?: StaticValue
  /** Set when the argument is a reference to an exported binding (class, function, schema...). */
  readonly ref?: ValueRef
  /** Why the argument could not be evaluated (already reported as ZNIGHT005). */
  readonly error?: string
  readonly location: Location
  /** Source text of the argument. */
  readonly text: string
  /** The argument expression (escape hatch for advanced extensions). */
  readonly node: Expression
}

/** A block tag of a {@link DocComment} (`@param search Text`, `@deprecated`, `@example ...`). */
export interface DocTag {
  /** Tag name without `@` (`param`, `returns`, `deprecated`, `minimum`). */
  readonly name: string
  /**
   * Text after the tag name, trimmed (`'search Case-insensitive search'` for `@param search ...`,
   * `''` for `@deprecated`). Continuation lines are kept with their line breaks and indentation
   * (`@example` code).
   */
  readonly text: string
  /** From the `@` to the end of the tag text (diagnostics about tag values). */
  readonly location: Location
}

/**
 * A JSDoc comment (`/** ... *\/`), C2 of RFC 0002. The documented node is the nearest JSDoc block
 * before it, separated only by whitespace, other comments, decorators and modifiers (`export`,
 * `default`, `declare`, `const`), as in TypeScript. Lines are stripped of their leading ` * `.
 *
 * ```ts
 * /**
 *  * List books
 *  *
 *  * Sorted and paginated.
 *  * @param search Case-insensitive search.
 *  *\/
 * ```
 *
 * gives `{ text: 'List books\n\nSorted and paginated.', summary: 'List books', description:
 * 'Sorted and paginated.', tags: [{ name: 'param', text: 'search Case-insensitive search.' }] }`.
 */
export interface DocComment {
  /** Everything before the first block tag, trimmed (`''` when the comment only has tags). */
  readonly text: string
  /**
   * The first paragraph of {@link text}, its lines joined with a space (`undefined` when the text is
   * empty). It is the first line in the usual layout.
   */
  readonly summary: string | undefined
  /** {@link text} after the first paragraph, trimmed (`undefined` when nothing follows). */
  readonly description: string | undefined
  /** Block tags, in source order (`@param`, `@returns`, `@deprecated`, `@example`, `@default`...). */
  readonly tags: readonly DocTag[]
  /** The whole comment. */
  readonly location: Location
}

/** A decorator applied to a class, member or parameter. */
export interface DecoratorInfo {
  /** Canonical identity of the decorator function (`'@znight/core#Injectable'`), when resolvable. */
  readonly identity: string | undefined
  /** Display name (`Injectable`, or the callee text when the identity is unknown). */
  readonly name: string
  /** Who owns the decorator: `'core'`, an extension name, `'manifest'` (interceptor decorators), or `undefined`. */
  readonly owner: string | undefined
  /** Arguments. Empty for a decorator used without call (`@Injectable`). */
  readonly args: readonly ArgInfo[]
  /**
   * Type arguments of the call, resolved (§4.4): `@ApiResponse<Book[]>(200)` → `[Book[]]`. They are
   * erased at runtime, but the compiler reads them. Also a {@link ShapeTarget}
   * (`{ decorator, typeArgument: 0 }`). Empty without type arguments.
   */
  readonly typeArgs: readonly TypeInfo[]
  /** `false` for `@X` (not called). Znight decorators must be called (ZNIGHT005). */
  readonly called: boolean
  readonly target: DecoratorTarget
  /** Location of the whole decorator (`@Get('/x')`). */
  readonly location: Location
  readonly node: Decorator
}

/** Where a TypeScript parameter property (`constructor(private readonly x: X)`) is declared. */
export interface ParameterPropertyInfo {
  readonly visibility: Visibility
  readonly readonly: boolean
}

/** A parameter of a constructor or method. */
export interface ParameterInfo {
  /** Binding name, or `arg<index>` for destructuring patterns. */
  readonly name: string
  readonly index: number
  /**
   * Annotated type, resolved (§4.4). For constructors inherited from a generic base class, type
   * parameters are substituted with the heritage type arguments. Missing annotation → opaque.
   */
  readonly type: TypeInfo
  /** `x?: T`. */
  readonly optional: boolean
  /** `x: T = value`. */
  readonly hasDefault: boolean
  /**
   * The default value (`limit = 20`), evaluated as a `value` argument: check `evaluated` (`20`), `ref`
   * (a reference to an exported binding) or `error` (not evaluable, e.g. `= new Date()`; never
   * reported). `undefined` without default value.
   */
  readonly initializer: ArgInfo | undefined
  /** `...rest: T[]`. */
  readonly rest: boolean
  readonly decorators: readonly DecoratorInfo[]
  readonly location: Location
  /** Location of the type annotation (the parameter itself when there is none). */
  readonly typeLocation: Location
  readonly property: ParameterPropertyInfo | undefined
  /** JSDoc of the parameter itself (parameter properties: `constructor(/** Id *\/ readonly id: string)`). */
  readonly doc: DocComment | undefined
}

/** The constructor used to instantiate a class (own or inherited, §4.5). */
export interface ConstructorInfo {
  readonly params: readonly ParameterInfo[]
  /** Identity of the class declaring the constructor; `undefined` when no class of the chain declares one. */
  readonly declaredBy: string | undefined
  readonly visibility: Visibility
  readonly location: Location | undefined
  /** Why the constructor cannot be analysed (`extends Mixin(Base)`...): ZNIGHT010 when the class is a provider. */
  readonly error:
    | { readonly message: string; readonly location: Location; readonly hints: readonly string[] }
    | undefined
}

/** A method or accessor declared by the class itself. */
export interface MethodInfo {
  /** `findById`, `#secret`, `'quoted'` → `quoted`, `[Symbol.asyncDispose]`. */
  readonly name: string
  readonly kind: 'method' | 'get' | 'set'
  readonly visibility: Visibility
  /** `#name`. */
  readonly privateName: boolean
  /** Computed key (`[Symbol.asyncDispose]`, `[KEY]`). */
  readonly computed: boolean
  readonly static: boolean
  readonly abstract: boolean
  /** `async` keyword, or `Promise<T>` return type. */
  readonly async: boolean
  readonly generator: boolean
  readonly optional: boolean
  readonly decorators: readonly DecoratorInfo[]
  readonly params: readonly ParameterInfo[]
  /** Annotated return type, `undefined` without annotation. */
  readonly returnType: TypeInfo | undefined
  /** Method type parameters (`<T>`): such a method cannot be a provider. */
  readonly typeParameters: readonly string[]
  readonly location: Location
  /** JSDoc of the method (route handlers: summary, description, `@param`, `@returns`, `@deprecated`). */
  readonly doc: DocComment | undefined
}

/** A class field or auto-accessor declared by the class itself. */
export interface PropertyInfo {
  readonly name: string
  readonly privateName: boolean
  readonly computed: boolean
  readonly static: boolean
  readonly visibility: Visibility
  readonly readonly: boolean
  /** `x?: T`. */
  readonly optional: boolean
  /** `declare x: T`. */
  readonly declare: boolean
  /** `accessor x = ...`. */
  readonly accessor: boolean
  readonly decorators: readonly DecoratorInfo[]
  /** Annotated type, `undefined` without annotation. */
  readonly type: TypeInfo | undefined
  /** The initializer, evaluated as a `value` (`undefined` when there is none). */
  readonly initializer: ArgInfo | undefined
  readonly location: Location
  readonly doc: DocComment | undefined
}

/** Lifecycle hook names detected on classes (§4.5). */
export type LifecycleHookName = 'onStart' | 'onReady' | 'onStop' | 'asyncDispose' | 'dispose'

/** A lifecycle hook found on a class or one of its analysable base classes. */
export interface LifecycleHookInfo {
  readonly hook: LifecycleHookName
  /** Member name: `onStart`, `[Symbol.asyncDispose]`... */
  readonly member: string
  /** Identity of the class declaring it. */
  readonly declaredBy: string
  readonly static: boolean
  /** Parameters without `?`, default value or rest. */
  readonly requiredParams: number
  readonly location: Location
}

/** Everything the compiler knows about a class (§6.5). Built once per compile. */
export interface ClassInfo {
  /** Local name (`UserService`, `default` for an anonymous default export). */
  readonly name: string
  /** Canonical identity (§4.1), also the token of a class provider. */
  readonly identity: string
  readonly displayName: string
  /** Absolute path of the declaring file. */
  readonly file: string
  /** Declaring file relative to the project root (messages). */
  readonly relativeFile: string
  /** Location of the class name. */
  readonly location: Location
  /** `true` when the generated module can import the class ({@link importRoute} is set). */
  readonly exported: boolean
  readonly importRoute: ImportRoute | undefined
  readonly importError: ImportRouteFailure | undefined
  readonly abstract: boolean
  /** Declared in a declaration file (`.d.ts`) or with `declare`. */
  readonly ambient: boolean
  /** Type parameter names (`class Repository<T>` → `['T']`). */
  readonly typeParameters: readonly string[]
  /** Class decorators, in source order (top-most first). */
  readonly decorators: readonly DecoratorInfo[]
  readonly ctor: ConstructorInfo
  /** Methods and accessors declared by the class itself (overload signatures excluded). */
  readonly methods: readonly MethodInfo[]
  /** Fields and auto-accessors declared by the class itself. */
  readonly properties: readonly PropertyInfo[]
  /** Direct `extends` clause (type arguments as written), when it is a type reference. */
  readonly superClass: ReferenceType | undefined
  /** Heritage closure: every `extends`/`implements` type, transitively, with substituted type arguments. */
  readonly heritage: readonly ReferenceType[]
  readonly lifecycle: readonly LifecycleHookInfo[]
  /** `true` when the class, a member or a parameter carries a decorator. */
  readonly decorated: boolean
  /** The class declaration (escape hatch: `declaration.node` is the oxc AST node). */
  readonly declaration: Declaration
  /** JSDoc of the class (before its decorators and `export`). */
  readonly doc: DocComment | undefined
}

/** Shapes without payload (§6.2 of RFC 0002). */
export type ShapeKeyword =
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  /** `undefined` and `void` (dropped from object properties, which become optional). */
  | 'undefined'
  /** `unknown` and `any`. */
  | 'unknown'
  | 'never'
  /** `Date` (`Date.prototype.toJSON`: an ISO string). */
  | 'date'
  /** `bigint` and bigint literals: `JSON.stringify` throws on them (also a {@link ShapeIssue}). */
  | 'bigint'
  /** Bytes and streams: `Uint8Array` and the other typed arrays, `ArrayBuffer`, `DataView`, `Buffer`, `Blob`, `File`, `ReadableStream`, `Readable`. */
  | 'binary'
  /** `URL` (`URL.prototype.toJSON`: a string). */
  | 'url'

/** Why a part of a type has no shape. Every opaque occurrence is also a {@link ShapeIssue}. */
export type ShapeOpaqueReason =
  /** Function and constructor types, callable interfaces. */
  | 'function'
  | 'symbol'
  /** An unbound type parameter (`T` of a generic method). */
  | 'type-parameter'
  /** A type `JSON.stringify` does not serialise as declared: `Map`, `Set`, `WeakMap`, `RegExp`, `Error`, a nested `Promise`... */
  | 'non-json'
  /** A mapped type other than the supported forms (`as` clauses, non-literal keys). */
  | 'mapped'
  /** A conditional type that is not a schema alias. */
  | 'conditional'
  /** `typeof x` that is not a schema reference. */
  | 'typeof'
  /** `T[K]` that cannot be resolved structurally. */
  | 'indexed-access'
  /** `keyof`, `unique symbol` and other operators on unsupported operands. */
  | 'type-operator'
  | 'this'
  /** A name that does not resolve, or does not name a type. */
  | 'unresolved'
  /** No type annotation. */
  | 'missing-annotation'
  /** A class with a `toJSON()` method without return type annotation. */
  | 'to-json'
  /** A recursion the resolver cannot follow (infinitely growing generic instantiations, `extends` cycles). */
  | 'recursive'
  /** Anything else (`import()` types, intrinsic types, utility types without structure such as `ReturnType`). */
  | 'unsupported'

/** A property of an object shape. */
export interface ShapeProperty {
  readonly name: string
  /** The shape, `undefined` removed when the property is optional. */
  readonly shape: Shape
  /** `x?: T` or `x: T | undefined` (`JSON.stringify` omits `undefined` values). */
  readonly optional: boolean
  readonly readonly: boolean
  /** JSDoc of the property (`description`, `@deprecated`, `@example`, `@format`, `@minimum`...). */
  readonly doc: DocComment | undefined
  /** The property declaration (`undefined` for properties created by `Record<'a' | 'b', T>`). */
  readonly location: Location | undefined
}

/**
 * Structural view of a TypeScript type (C1 of RFC 0002), computed from declarations (sources and
 * `.d.ts` alike) by {@link TypeHelpers.shape}. Unions are normalised like {@link TypeInfo} unions
 * (flattened, de-duplicated, sorted by serialization; `true | false` is `boolean`, literals absorbed
 * by their primitive, `never` dropped, `unknown` absorbs everything).
 */
export type Shape =
  | { readonly kind: ShapeKeyword }
  | { readonly kind: 'literal'; readonly value: string | number | boolean }
  /** `T[]`, `readonly T[]`, `Array<T>`, `ReadonlyArray<T>`. */
  | { readonly kind: 'array'; readonly items: Shape }
  /** `[A, B?, ...C[]]`: `items` are the fixed elements, `rest` the element type of the rest. */
  | { readonly kind: 'tuple'; readonly items: readonly Shape[]; readonly rest?: Shape; readonly minItems: number }
  /**
   * Interfaces (flattened with their `extends`, merged declarations included), object literal
   * types, classes, records, mapped types over literal keys and object intersections.
   * `additional` is the value of an index signature or of `Record<string, T>`. A class is what
   * `JSON.stringify` serialises: its inherited and own instance fields and parameter properties
   * (parameter properties first, as in declaration files), without methods, accessors, static,
   * `#private` and TypeScript `private` members (internals, whose types `.d.ts` files erase); a
   * class with a `toJSON()` method is the shape of its annotated return type.
   */
  | { readonly kind: 'object'; readonly properties: readonly ShapeProperty[]; readonly additional?: Shape }
  | { readonly kind: 'union' | 'intersection'; readonly members: readonly Shape[] }
  /** A named declaration (interface, class, type alias or enum): see {@link ShapeResult.named}. */
  | { readonly kind: 'named'; readonly key: string }
  /** `z.output<typeof S>` and the other {@link ShapeOptions.schemaAliases}: the Standard Schema `S`. */
  | { readonly kind: 'schema'; readonly ref: ValueRef; readonly io: 'input' | 'output' }
  /** A type listed in {@link ShapeOptions.keep}, not expanded (`HttpResponse<Book>`). */
  | {
      readonly kind: 'reference'
      readonly identity: string
      readonly name: string
      /** Type arguments, default ones filled in. */
      readonly typeArgs: readonly Shape[]
      /**
       * Number of type arguments written in the source (`HttpResponse` → 0). From a `{ type }`
       * target, whose defaults are already filled in, every type argument counts.
       */
      readonly explicitTypeArgs: number
    }
  | { readonly kind: 'opaque'; readonly text: string; readonly reason: ShapeOpaqueReason }

/** A named declaration reached by a shape (a component of an OpenAPI document). */
export interface NamedShape {
  /** Identity plus serialized type arguments: `src/page.ts#Page<src/book.ts#Book>`. */
  readonly key: string
  /** Canonical identity of the declaration (`src/page.ts#Page`). */
  readonly identity: string
  /** Display name (`Page`). */
  readonly name: string
  readonly declaration: 'interface' | 'class' | 'alias' | 'enum'
  /** Type arguments (`[{ kind: 'named', key: 'src/book.ts#Book' }]`), default ones filled in. */
  readonly typeArgs: readonly Shape[]
  /** The structure: an object (interfaces, classes), a union of literals (enums), anything (aliases). */
  readonly shape: Shape
  /** JSDoc of the declaration. */
  readonly doc: DocComment | undefined
  /** Location of the declaration name. */
  readonly location: Location
}

/**
 * An unrepresentable part of a shape: every `opaque` occurrence, every `bigint`. A result only
 * reports the parts its shapes contain (`Out<typeof S>` resolved to a schema does not report
 * `typeof S`; `Pick<Book, 'id'>` does not report the other properties of `Book`).
 */
export interface ShapeIssue {
  readonly reason: ShapeOpaqueReason | 'bigint'
  /** Where in the type: `ShelfStats.total`, `items[]`, `[0]`, `[string]` (`''` for the root). */
  readonly path: string
  /**
   * Key of the named shape whose declaration contains it (`undefined` when it is written in the
   * annotation of the target itself). A property copied by a utility type (`Pick<Stats, 'total'>`)
   * keeps the key of `Stats`, even though `Stats` is then not among the named shapes of the result.
   */
  readonly named: string | undefined
  /** Source text of the part (`bigint`, `Map<string, number>`). */
  readonly text: string
  /** The annotation of the part, when it has one in a readable file. */
  readonly location: Location | undefined
}

/** What {@link TypeHelpers.shape} describes. */
export type ShapeTarget =
  /** The return type annotation, a top-level `Promise<T>` unwrapped (the body a route handler produces). */
  | { readonly returnOf: MethodInfo }
  /** The annotation of a method or constructor parameter. */
  | { readonly parameter: ParameterInfo }
  /** The annotation of a class field. */
  | { readonly property: PropertyInfo }
  /** A type argument of a decorator call: `@ApiResponse<Book[]>(200)` → `{ decorator, typeArgument: 0 }`. */
  | { readonly decorator: DecoratorInfo; readonly typeArgument: number }
  /**
   * A resolved {@link TypeInfo} (e.g. stored by another extension). Less precise than an annotation:
   * aliases are already expanded (no `named` alias, no schema alias) and object literal types are opaque.
   */
  | { readonly type: TypeInfo }

/** Options of {@link TypeHelpers.shape}. Results are cached per options for the whole compile. */
export interface ShapeOptions {
  /**
   * Generic aliases meaning "the Standard Schema S": canonical identity → io. A reference to one of
   * them whose first type argument is `typeof S` (`z.output<typeof S>`) is the shape
   * `{ kind: 'schema', ref: S, io }`, and so is an alias of it. Matched before alias expansion.
   */
  readonly schemaAliases?: Readonly<Record<string, 'input' | 'output'>>
  /** Members of a schema value meaning its type (ArkType `typeof S.infer` → `{ infer: 'output', inferIn: 'input' }`). */
  readonly schemaMembers?: Readonly<Record<string, 'input' | 'output'>>
  /**
   * Identities kept as `{ kind: 'reference' }` instead of being expanded, at any depth
   * (`'@znight/http#HttpResponse'`, `'globalThis#Response'`, `'globalThis#AsyncIterable'`).
   */
  readonly keep?: readonly string[]
  /** Read JSDoc comments (`doc` of properties and named shapes). Default `true`. */
  readonly jsdoc?: boolean
}

/**
 * Result of {@link TypeHelpers.shape}. Named shapes and their issues are computed once per compile
 * and options: results reaching the same declarations share the same `NamedShape` and `ShapeIssue`
 * objects (de-duplicate issues by identity across results), and must not be mutated.
 */
export interface ShapeResult {
  readonly root: Shape
  /**
   * Every named shape the root references, transitively (through their structures and type
   * arguments), by key, sorted by key. A declaration only used structurally (`Partial<Book>`,
   * `interface A extends B`) is not listed: its properties are copied.
   */
  readonly named: ReadonlyMap<string, NamedShape>
  /** Unrepresentable parts of the root (first), then of every named shape (by key, then path). */
  readonly issues: readonly ShapeIssue[]
}

/** Helpers on {@link TypeInfo} (extensions cannot import them from the compiler at runtime). */
export interface TypeHelpers {
  /** Human readable form for messages (`Repository<User>`). */
  format(type: TypeInfo): string
  /** Normative serialization (§4.4); equal types have equal serializations. */
  serialize(type: TypeInfo): string
  equals(a: TypeInfo, b: TypeInfo): boolean
  /** Removes `undefined`, `null` and `void` from a union. */
  stripNullish(type: TypeInfo): { readonly type: TypeInfo; readonly nullable: boolean }
  /** `Promise<T>` → `T` (other types unchanged). */
  awaited(type: TypeInfo): TypeInfo
  /**
   * Structural view of a type annotation (C1 of RFC 0002): what a value of that type looks like
   * once serialised as JSON, for schema generators. Works on declarations from sources and `.d.ts`
   * files alike; generics, utility types (`Partial`, `Required`, `Readonly`, `Pick`, `Omit`,
   * `Record`, `NonNullable`, `Exclude`, `Extract`, `Awaited`), `keyof`, indexed access and mapped
   * types over literal keys are applied structurally; interfaces, classes, aliases and enums are
   * `named` (recursion goes through them). Named shapes are computed once per compile and options;
   * the files read are part of `watchFiles`. Available in the analyze, validate and generate contexts.
   */
  shape(target: ShapeTarget, options?: ShapeOptions): ShapeResult
}

/**
 * Something to inject, resolved with the binding algorithm (§4.7). A `T[]` type means multi, a
 * `Lazy<T>` type means lazy and `| undefined` / `| null` mean optional, exactly like a constructor
 * parameter.
 */
export interface InjectionRequest {
  /** Requested type, or a canonical identity (`'@znight/config#ConfigSource'`). */
  readonly type: TypeInfo | string
  /** `@Inject(qualifier)`. */
  readonly qualifier?: string
  readonly optional?: boolean
  readonly location?: Location
  /** Describes the injection point in messages (`"field 'url' of DbConfig"`). */
  readonly label?: string
}

/** Input of {@link CustomFactory.generate}. */
export interface FactoryInput {
  /** The provider class (imported). */
  readonly cls: GenNode
  /** One node per {@link CustomFactory.deps} entry (`d[i]`). */
  readonly deps: readonly GenNode[]
}

/** A provider whose instance is built by extension-generated code instead of `new Class(...)`. */
export interface CustomFactory {
  /** Dependencies of the factory, bound like constructor parameters (they replace constructor injection). */
  readonly deps: readonly InjectionRequest[]
  /** The generated factory returns a promise (singletons only, ZNIGHT014). */
  readonly async?: boolean
  /** Emits the factory body: `(d) => <returned node>`. */
  readonly generate: (ctx: GenerateContext, input: FactoryInput) => GenNode
}

/** Options of {@link AnalyzeContext.registerProvider}. */
export interface ProviderRegistration {
  /** Default `'singleton'`. */
  readonly scope?: Scope
  /** Qualifier (merged with `@Named`, a conflict is ZNIGHT005). */
  readonly name?: string
  readonly primary?: boolean
  /** Custom factory; default: constructor injection. */
  readonly factory?: CustomFactory
}

/** A class reference bound to a provider token ({@link AnalyzeContext.resolveClassRef}). */
export interface ClassRef {
  /** Provider (or external) token. */
  readonly token: Token
  readonly identity: string
  readonly displayName: string
  readonly location: Location
}

/** Result handle of {@link AnalyzeContext.bindInjection}, resolved after binding. */
export interface BindingHandle {
  readonly id: number
}

/** Details of {@link AnalyzeContext.addDependency}. */
export interface DependencyDetails {
  readonly location?: Location
  /** `"guard"`, `"interceptor"`... used in messages. */
  readonly reason?: string
}

/** Options of {@link AnalyzeContext.resolveClassRef}. */
export interface ClassRefOptions {
  /** Provider that uses the referenced class: adds a validation edge (ZNIGHT003, ZNIGHT019). */
  readonly from?: ClassInfo | Token
  /** Role of the class in messages (`"guard"`). Default `"class"`. */
  readonly role?: string
}

/** Details of {@link AnalyzeContext.addRoot}. */
export interface RootDetails {
  /** Where the class is used (diagnostics of its auto-registration). Default: the extension's first decorator on the class. */
  readonly location?: Location
  /** What the root is, in messages (`'scheduled job host'`). */
  readonly reason?: string
}

/** A root declared with {@link AnalyzeContext.addRoot} (or by a compiled library). */
export interface RootNode {
  readonly token: Token
  /** `extension '<name>'` or `compiled library <package>`. */
  readonly origin: string
  readonly reason: string
  readonly location: Location | undefined
}

/**
 * A top-level `const` of a scanned file initialised with a call to a given function
 * ({@link AnalyzeContext.definitionsOf}): `export const Roles = createRouteDecorator('roles', {...})`.
 */
export interface DefinitionInfo {
  /** Canonical identity of the constant (`src/auth/access.ts#Roles`): what decorators and references resolve to. */
  readonly identity: string
  /** Name in its file. */
  readonly name: string
  readonly displayName: string
  /** Absolute path of the declaring file. */
  readonly file: string
  /** Location of the constant's name. */
  readonly location: Location
  /** Location of the call. */
  readonly call: Location
  /**
   * Arguments, evaluated as `value` arguments (spreads of evaluable arrays expanded). Nothing is
   * reported: check `evaluated`, `ref` and `error`.
   */
  readonly args: readonly ArgInfo[]
  /** Type arguments of the call (`createRouteDecorator<readonly Role[]>(...)`), resolved. */
  readonly typeArgs: readonly TypeInfo[]
  readonly doc: DocComment | undefined
  /** The generated module can import the constant (`importValue(identity)`). */
  readonly exported: boolean
}

/** Context of {@link CompilerExtension.analyzeClass}. */
export interface AnalyzeContext<TData = unknown> {
  readonly extension: string
  readonly project: Project
  readonly options: ResolvedOptions
  readonly types: TypeHelpers
  /**
   * Registers `cls` as a provider (token = `cls.identity`). A class registered by several provider
   * decorators is ZNIGHT005. Class-level `@Named` / `@Primary` / `@Intercept` still apply.
   */
  registerProvider(cls: ClassInfo, registration?: ProviderRegistration): Token
  /**
   * Binds a class reference (a `value` argument such as a guard) to a provider token. When the class
   * is neither a provider nor an external, it is auto-registered as a singleton provider with
   * constructor injection (helper classes such as guards and interceptors need no decorator).
   * Returns `undefined` (and reports ZNIGHT005) when the argument is not a class reference.
   */
  resolveClassRef(arg: ArgInfo | ValueRef, options?: ClassRefOptions): ClassRef | undefined
  /**
   * Binds an injection request with §4.7; the result is available in {@link ValidateContext.binding}
   * and `GenerateContext.binding`. With `from`, the dependency also takes part in validation
   * (ZNIGHT003, ZNIGHT019). Such dependencies are resolved by the extension's plugin at runtime:
   * they never take part in the instantiation order (and in ZNIGHT002).
   */
  bindInjection(request: InjectionRequest, options?: { readonly from?: ClassInfo | Token }): BindingHandle
  /** Declares that `from` uses the provider `to` at runtime (validation edge: ZNIGHT003, ZNIGHT019). */
  addDependency(from: ClassInfo | Token, to: Token | ClassRef, details?: DependencyDetails): void
  /** Analysis of another class (by identity), built on demand. */
  classInfo(identity: string): ClassInfo | undefined
  report(diagnostic: Diagnostic): void
  /** Appends data for {@link ValidateContext.stored} / `GenerateContext.stored`. */
  store(data: TData): void
  /**
   * Declares `cls` as an entry point used by the extension's plugin at runtime (a class whose only
   * use is a `@Cron` method): its provider is a **root** of ZNIGHT019 and `prune`, also through
   * compiled libraries (`roots` of `znight.providers.json`). When no provider decorator (core or
   * extension) registers the class by the end of the analysis, it is registered as a singleton
   * with constructor injection (`registeredBy: 'auto'`, like the classes of `resolveClassRef`).
   * Calling it several times is harmless. Returns the token (`cls.identity`). Roots are listed in
   * `ApplicationGraph.roots`.
   */
  addRoot(cls: ClassInfo, details?: RootDetails): Token
  /**
   * The top-level `const` declarations of the scanned files (application and source libraries)
   * initialised with a call to the function `callee` (canonical identity, e.g.
   * `'@znight/http#createRouteDecorator'`), sorted by identity. Lets an extension see definitions
   * that are not applied anywhere (every route decorator group of the application). Computed once
   * per compile and callee.
   */
  definitionsOf(callee: string): readonly DefinitionInfo[]
}

/** Context of {@link CompilerExtension.validate}. */
export interface ValidateContext<TData = unknown> {
  readonly extension: string
  readonly project: Project
  readonly options: ResolvedOptions
  readonly types: TypeHelpers
  /** The bound application graph (diagnostics so far included). */
  readonly graph: ApplicationGraph
  /** Data stored by the extension, in call order. */
  readonly stored: readonly TData[]
  provider(token: Token): ProviderNode | undefined
  classInfo(identity: string): ClassInfo | undefined
  /** Result of {@link AnalyzeContext.bindInjection} (`undefined` when binding failed). */
  binding(handle: BindingHandle): DependencyRef | undefined
  report(diagnostic: Diagnostic): void
  /** Same as {@link AnalyzeContext.definitionsOf}. */
  definitionsOf(callee: string): readonly DefinitionInfo[]
}
