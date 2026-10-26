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
  /** `...rest: T[]`. */
  readonly rest: boolean
  readonly decorators: readonly DecoratorInfo[]
  readonly location: Location
  /** Location of the type annotation (the parameter itself when there is none). */
  readonly typeLocation: Location
  readonly property: ParameterPropertyInfo | undefined
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
}
