/**
 * Core analysis (§5 `@znight/core`): `@Injectable`, `@Factory` + `@Provides`, `@Inject`, `@Optional`,
 * `@Named`, `@Primary`, `@Intercept` and manifest interceptor decorators. Also the provider
 * registration shared with extensions ({@link ProviderBuilder.registerClass}) and the binding of
 * class references (`resolveClassRef`, interceptors) with auto-registration of helper classes.
 */
import type { Scope, Token } from '@znight/core'
import type {
  ArgInfo,
  ClassInfo,
  ClassRef,
  CustomFactory,
  DecoratorInfo,
  InjectionRequest,
  MethodInfo,
  ParameterInfo,
} from '../extensions/api.ts'
import type { Declaration, Location, Project, StaticValue, TypeInfo } from '../project/index.ts'
import type { Reporter } from './arguments.ts'
import type { ClassAnalyzer } from './class-analyzer.ts'
import type { DecoratorCatalog } from './decorators.ts'
import type { ManifestIndex } from './manifests.ts'
import type { InterceptedMethodDraft, InterceptorLinkDraft, ParameterSite, ProviderRegistry } from './registry.ts'

import { ErrorCode } from '@znight/core'

import { awaitedType, stripNullish } from '../binding/injection.ts'
import { compareStrings } from '../project/compare.ts'
import { displayNameOf, formatType, referenceType, serializeType, ValueRef } from '../project/index.ts'
import { CoreDecorator, MANIFEST_OWNER } from './core-decorators.ts'

const SCOPES: readonly Scope[] = ['singleton', 'request', 'transient']
const INJECTABLE_OPTIONS = ['scope', 'name', 'primary'] as const
const PROVIDES_OPTIONS = ['scope', 'name', 'primary', 'dispose'] as const

/** How a class is registered as a provider. */
export interface ClassRegistration {
  /** `'core'`, `'auto'` or an extension name. */
  readonly registeredBy: string
  /** For messages: `@Injectable`, `@Controller`, `interceptor reference`... */
  readonly registeredWith: string
  readonly registration: Location
  readonly scope: Scope
  readonly name?: string | undefined
  readonly primary?: boolean | undefined
  readonly custom?: CustomFactory | undefined
}

/** A pending binding of a class reference to a provider token. */
interface ClassRefRequest {
  readonly token: Token
  readonly declaration: Declaration | undefined
  readonly location: Location
  readonly role: string
}

/** Builds provider drafts. One instance per compile. */
export class ProviderBuilder {
  readonly #project: Project
  readonly #analyzer: ClassAnalyzer
  readonly #catalog: DecoratorCatalog
  readonly #manifests: ManifestIndex
  readonly #registry: ProviderRegistry
  readonly #report: Reporter
  readonly #pending: ClassRefRequest[] = []
  readonly #requested = new Set<Token>()

  constructor(
    project: Project,
    analyzer: ClassAnalyzer,
    catalog: DecoratorCatalog,
    manifests: ManifestIndex,
    registry: ProviderRegistry,
    report: Reporter,
  ) {
    this.#project = project
    this.#analyzer = analyzer
    this.#catalog = catalog
    this.#manifests = manifests
    this.#registry = registry
    this.#report = report
  }

  // ------------------------------------------------------------ core analysis

  /** Core decorators of a class. */
  analyzeCore(cls: ClassInfo): void {
    const injectable = this.#single(cls.decorators, CoreDecorator.Injectable)
    const factory = this.#single(cls.decorators, CoreDecorator.Factory)
    if (injectable) {
      const options = this.#options(injectable, INJECTABLE_OPTIONS)
      this.registerClass(cls, {
        registeredBy: 'core',
        registeredWith: '@Injectable',
        registration: injectable.location,
        scope: options.scope ?? 'singleton',
        name: options.name,
        primary: options.primary,
      })
    }
    if (factory) {
      this.registerClass(cls, {
        registeredBy: 'core',
        registeredWith: '@Factory',
        registration: factory.location,
        scope: 'singleton',
      })
    }
    for (const method of cls.methods) {
      const provides = this.#single(method.decorators, CoreDecorator.Provides)
      if (provides) {
        if (factory) {
          this.#registerProvides(cls, method, provides)
        } else {
          this.#error(
            provides.location,
            `@Provides can only be used in a @Factory class (${cls.displayName}.${method.name})`,
            [`Add @Factory() to ${cls.displayName}`],
          )
        }
      } else {
        for (const decorator of method.decorators) {
          if (decorator.identity === CoreDecorator.Named || decorator.identity === CoreDecorator.Primary) {
            this.#error(
              decorator.location,
              `@${decorator.name} on a method requires @Provides (${cls.displayName}.${method.name})`,
            )
          }
        }
        for (const param of method.params) {
          for (const decorator of param.decorators) {
            if (decorator.identity === CoreDecorator.Inject || decorator.identity === CoreDecorator.Optional) {
              this.#error(
                decorator.location,
                `@${decorator.name} can only be used on constructor parameters and @Provides method parameters (${cls.displayName}.${method.name})`,
              )
            }
          }
        }
      }
    }
  }

  // ------------------------------------------------------------ registration

  /** Registers a class provider (core, extension or auto-registration). Returns its token. */
  registerClass(cls: ClassInfo, registration: ClassRegistration): Token {
    const token = cls.identity
    const existing = this.#registry.get(token)
    if (existing) {
      this.#report({
        code: ErrorCode.InvalidDecorator,
        severity: 'error',
        message: `${cls.displayName} is registered by several provider decorators (${existing.registeredWith} and ${registration.registeredWith})`,
        location: registration.registration,
        hints: ['A class is a provider of one kind only: keep a single provider decorator'],
        related: [{ message: `first registered with ${existing.registeredWith}`, location: existing.registration }],
      })
      return token
    }
    const what = registration.registeredWith
    let skipBinding = false
    if (cls.abstract) {
      this.#error(registration.registration, `${what} cannot register the abstract class ${cls.displayName}`, [
        'Register a concrete subclass, or provide the value with a @Provides method',
      ])
    }
    if (cls.typeParameters.length > 0) {
      skipBinding = true
      this.#error(
        registration.registration,
        `${what} cannot register the generic class ${cls.displayName}<${cls.typeParameters.join(', ')}>: its type parameters are unbound`,
        [
          `Subclass it with concrete type arguments (\`class UserRepository extends ${cls.displayName}<User> {}\`)`,
          'Or provide it with a @Provides method returning a concrete type',
        ],
      )
    }
    if (!cls.exported) {
      this.#error(
        registration.registration,
        `${describeClass(cls)} must be importable by the generated module to be a provider: ${cls.importError?.message ?? 'not exported'}`,
        cls.importError?.hints.length ? cls.importError.hints : [`Export it: \`export class ${cls.name} ...\``],
      )
    }
    if (!registration.custom) {
      if (cls.ctor.error) {
        skipBinding = true
        this.#report({
          code: ErrorCode.UnresolvableType,
          severity: 'error',
          message: cls.ctor.error.message,
          location: this.#visible(cls.ctor.error.location, cls),
          hints: cls.ctor.error.hints,
        })
      } else if (cls.ctor.visibility !== 'public') {
        this.#error(
          cls.ctor.location ? this.#visible(cls.ctor.location, cls) : registration.registration,
          `The constructor of ${cls.displayName} is ${cls.ctor.visibility}: the generated module cannot instantiate it`,
          ['Make the constructor public'],
        )
      }
    }
    const qualifiers = this.#qualifiers(cls.decorators, registration.name, registration.primary, cls.displayName)
    const custom = registration.custom
    const async = custom?.async === true
    if (async && registration.scope !== 'singleton') {
      this.#report({
        code: ErrorCode.AsyncNonSingleton,
        severity: 'error',
        message: `${cls.displayName} has an async factory but is ${registration.scope}-scoped: async factories are only allowed for singletons`,
        location: registration.registration,
        hints: ['Make it a singleton, or create the value synchronously'],
      })
    }
    const params = custom
      ? custom.deps.map((request, index) => this.#requestSite(request, index, cls, registration.registeredBy))
      : cls.ctor.params.map(param => this.#constructorSite(param, cls))
    this.#registry.add({
      token,
      displayName: cls.displayName,
      kind: custom ? 'custom' : 'class',
      registeredBy: registration.registeredBy,
      cls,
      method: undefined,
      providedType: referenceType(cls.identity, cls.displayName, []),
      exactKey: cls.identity,
      heritage: cls.heritage,
      scope: registration.scope,
      name: qualifiers.name,
      primary: qualifiers.primary,
      async,
      dispose: undefined,
      location: cls.location,
      registration: registration.registration,
      registeredWith: what,
      params,
      custom,
      interceptors: this.#interceptors(cls),
      lifecycle: cls.lifecycle,
      factoryToken: undefined,
      skipBinding,
    })
    return token
  }

  #registerProvides(factory: ClassInfo, method: MethodInfo, decorator: DecoratorInfo): void {
    const where = `${factory.displayName}.${method.name}`
    if (method.static || method.privateName || method.visibility !== 'public' || method.computed) {
      const why = whyNotPublic(method)
      this.#error(decorator.location, `@Provides method ${where} must be a public instance method (it is ${why})`, [
        'Make it a public, non-static method with a plain name',
      ])
      return
    }
    if (method.kind !== 'method' || method.generator) {
      this.#error(
        decorator.location,
        `@Provides must be applied to a regular method (${where} is ${method.kind === 'method' ? 'a generator' : `a ${method.kind}ter`})`,
      )
      return
    }
    if (method.typeParameters.length > 0) {
      this.#error(decorator.location, `@Provides method ${where} cannot be generic`, [
        'Declare one @Provides method per concrete type',
      ])
      return
    }
    if (method.returnType === undefined) {
      this.#error(
        decorator.location,
        `@Provides method ${where} must declare its return type: it is the provided type`,
        [`Annotate it: \`${method.name}(...): MyType\``],
      )
      return
    }
    const options = this.#options(decorator, PROVIDES_OPTIONS)
    const qualifiers = this.#qualifiers(method.decorators, options.name, options.primary, where)
    const scope = options.scope ?? 'singleton'
    const isAsync = method.returnType.kind === 'promise'
    const provided = stripNullish(awaitedType(method.returnType)).type
    if (!isConcrete(provided)) {
      this.#error(
        decorator.location,
        `@Provides method ${where} must return a concrete type (it returns ${formatType(method.returnType)})`,
        ['Annotate the method with the type of the value it creates'],
      )
      return
    }
    if (provided.kind !== 'reference' && qualifiers.name === undefined) {
      this.#error(
        decorator.location,
        `@Provides method ${where} returns '${formatType(provided)}', which has no identity: it needs a qualifier`,
        [
          `Name it with @Provides({ name: '${method.name}' }) or @Named('${method.name}') and inject it with @Inject('${method.name}')`,
        ],
      )
    }
    if (isAsync && scope !== 'singleton') {
      this.#report({
        code: ErrorCode.AsyncNonSingleton,
        severity: 'error',
        message: `@Provides method ${where} is async but ${scope}-scoped: async factories are only allowed for singletons`,
        location: decorator.location,
        hints: ['Make it a singleton, or return the value synchronously'],
      })
    }
    const token = `${factory.identity}.${method.name}`
    this.#registry.add({
      token,
      displayName: displayNameOf(token),
      kind: 'provides',
      registeredBy: 'core',
      cls: factory,
      method,
      providedType: provided,
      exactKey: serializeType(provided),
      heritage: provided.kind === 'reference' ? this.#analyzer.heritageOfType(provided) : [],
      scope,
      name: qualifiers.name,
      primary: qualifiers.primary,
      async: isAsync,
      dispose: options.dispose,
      location: method.location,
      registration: decorator.location,
      registeredWith: '@Provides',
      params: method.params.map(param => this.#methodSite(param, where)),
      custom: undefined,
      interceptors: [],
      lifecycle: provided.kind === 'reference' ? this.#analyzer.lifecycleOfIdentity(provided.identity) : [],
      factoryToken: factory.identity,
      skipBinding: false,
    })
  }

  // ------------------------------------------------------------- class refs

  /** Binds a class reference argument to a token (`resolveClassRef`, `@Intercept`). */
  classRef(arg: ArgInfo | ValueRef, role: string, decoratorName: string | undefined): ClassRef | undefined {
    const ref = arg instanceof ValueRef ? arg : arg.ref
    const location = arg instanceof ValueRef ? arg.location : arg.location
    if (!ref) {
      if (!(arg instanceof ValueRef) && arg.error === undefined) {
        this.#error(
          location,
          `${decoratorName ? `@${decoratorName}: ` : ''}expected a reference to the ${role} class, got ${arg.text}`,
          [`Pass the class itself: ${decoratorName ? `@${decoratorName}(MyClass)` : 'MyClass'}`],
        )
      }
      return undefined
    }
    const symbol = ref.symbol
    if (symbol.kind === 'declaration') {
      const declaration = symbol.declarations.find(candidate => candidate.kind === 'class')
      if (!declaration) {
        this.#error(location, `'${ref.text}' is not a class: the ${role} must be a class`)
        return undefined
      }
      const identity = this.#project.identityOf(declaration)
      if (!identity) {
        return undefined
      }
      this.#request({ token: identity.identity, declaration, location, role })
      return { token: identity.identity, identity: identity.identity, displayName: identity.displayName, location }
    }
    if (ref.identity !== undefined && (symbol.kind === 'external' || symbol.kind === 'expression')) {
      this.#request({ token: ref.identity, declaration: undefined, location, role })
      return { token: ref.identity, identity: ref.identity, displayName: ref.name, location }
    }
    this.#error(location, `'${ref.text}' cannot be used as the ${role}: it is not an analysable class`)
    return undefined
  }

  /** Binds a class identity (manifest interceptors) to a token. */
  classRefOfIdentity(identity: string, location: Location, role: string): ClassRef {
    const symbol = this.#project.lookupIdentity(identity)
    const declaration =
      symbol.kind === 'declaration' ? symbol.declarations.find(candidate => candidate.kind === 'class') : undefined
    this.#request({ token: identity, declaration, location, role })
    return { token: identity, identity, displayName: displayNameOf(identity), location }
  }

  /**
   * Resolves pending class references: providers and externals are kept, other classes are
   * auto-registered as singletons (which may request more references).
   */
  resolveClassRefs(): void {
    while (this.#pending.length > 0) {
      const request = this.#pending.shift() as ClassRefRequest
      if (this.#registry.has(request.token) || this.#manifests.external(request.token)) {
        continue
      }
      if (!request.declaration) {
        this.#report({
          code: ErrorCode.MissingProvider,
          severity: 'error',
          message: `Missing provider for the ${request.role} ${displayNameOf(request.token)}`,
          location: request.location,
          hints: [
            `Declare it in the "provides" of its package manifest, or add '${request.token}' to the "externals" option`,
          ],
        })
        continue
      }
      const cls = this.#analyzer.infoOf(request.declaration)
      this.registerClass(cls, {
        registeredBy: 'auto',
        registeredWith: `${request.role} reference`,
        registration: request.location,
        scope: 'singleton',
      })
    }
  }

  #request(request: ClassRefRequest): void {
    if (!this.#requested.has(request.token)) {
      this.#requested.add(request.token)
      this.#pending.push(request)
    }
  }

  // --------------------------------------------------------- final checks

  /**
   * Core decorators that have no effect because their class is not a provider (nor a base class of
   * one): `@Named`, `@Primary`, `@Intercept`, interceptor decorators, constructor `@Inject`/`@Optional`.
   */
  checkIneffective(classes: readonly ClassInfo[]): void {
    const used = new Set<string>()
    for (const draft of this.#registry.all()) {
      if (draft.kind === 'provides') {
        continue
      }
      let current: ClassInfo | undefined = draft.cls
      while (current && !used.has(current.identity)) {
        used.add(current.identity)
        current = this.#analyzer.baseOf(current)
      }
    }
    for (const cls of classes) {
      if (used.has(cls.identity)) {
        continue
      }
      const ineffective: DecoratorInfo[] = []
      for (const decorator of cls.decorators) {
        if (decorator.identity === CoreDecorator.Named || decorator.identity === CoreDecorator.Primary) {
          ineffective.push(decorator)
        }
      }
      if (cls.ctor.declaredBy === cls.identity) {
        for (const param of cls.ctor.params) {
          for (const decorator of param.decorators) {
            if (decorator.identity === CoreDecorator.Inject || decorator.identity === CoreDecorator.Optional) {
              ineffective.push(decorator)
            }
          }
        }
      }
      for (const method of cls.methods) {
        for (const decorator of method.decorators) {
          if (decorator.identity === CoreDecorator.Intercept || decorator.owner === MANIFEST_OWNER) {
            ineffective.push(decorator)
          }
        }
      }
      for (const decorator of ineffective) {
        this.#error(decorator.location, `@${decorator.name} has no effect: ${cls.displayName} is not a provider`, [
          `Register ${cls.displayName} as a provider (@Injectable()) or remove @${decorator.name}`,
        ])
      }
    }
  }

  // ---------------------------------------------------------------- helpers

  #single(decorators: readonly DecoratorInfo[], identity: string): DecoratorInfo | undefined {
    const found = decorators.filter(decorator => decorator.identity === identity)
    for (const duplicate of found.slice(1)) {
      this.#error(duplicate.location, `@${duplicate.name} is applied several times`, [
        `Keep a single @${duplicate.name}`,
      ])
    }
    return found[0]
  }

  /** Validated options object of `@Injectable` / `@Provides`. */
  #options(
    decorator: DecoratorInfo,
    allowed: readonly string[],
  ): { scope?: Scope; name?: string; primary?: boolean; dispose?: string } {
    const arg = decorator.args[0]
    if (!arg?.evaluated || arg.value === undefined) {
      return {}
    }
    const value = arg.value
    if (typeof value !== 'object' || value === null || Array.isArray(value) || value instanceof ValueRef) {
      this.#error(arg.location, `The options of @${decorator.name} must be an object (got ${arg.text})`)
      return {}
    }
    const record = value as Readonly<Record<string, StaticValue>>
    const result: { scope?: Scope; name?: string; primary?: boolean; dispose?: string } = {}
    for (const key of Object.keys(record).sort(compareStrings)) {
      const option = record[key]
      if (!allowed.includes(key)) {
        this.#error(arg.location, `Unknown option '${key}' of @${decorator.name} (allowed: ${allowed.join(', ')})`)
        continue
      }
      if (option === undefined) {
        continue
      }
      switch (key) {
        case 'scope':
          if (typeof option === 'string' && (SCOPES as readonly string[]).includes(option)) {
            result.scope = option as Scope
          } else {
            this.#error(
              arg.location,
              `Option 'scope' of @${decorator.name} must be 'singleton', 'request' or 'transient'`,
            )
          }
          break
        case 'primary':
          if (typeof option === 'boolean') {
            result.primary = option
          } else {
            this.#error(arg.location, `Option 'primary' of @${decorator.name} must be a boolean`)
          }
          break
        default:
          if (typeof option === 'string' && option !== '') {
            result[key as 'name' | 'dispose'] = option
          } else {
            this.#error(arg.location, `Option '${key}' of @${decorator.name} must be a non-empty string`)
          }
      }
    }
    return result
  }

  /** Merges `@Named` / `@Primary` with the registration options (a conflict is ZNIGHT005). */
  #qualifiers(
    decorators: readonly DecoratorInfo[],
    name: string | undefined,
    primary: boolean | undefined,
    owner: string,
  ): { name: string | undefined; primary: boolean } {
    let resolvedName = name
    const named = this.#single(decorators, CoreDecorator.Named)
    if (named) {
      const value = this.#stringArg(named)
      if (value !== undefined) {
        if (resolvedName !== undefined && resolvedName !== value) {
          this.#error(named.location, `${owner} has two different qualifiers: '${resolvedName}' and '${value}'`, [
            'Keep a single qualifier',
          ])
        } else {
          resolvedName = value
        }
      }
    }
    const primaryDecorator = this.#single(decorators, CoreDecorator.Primary)
    if (primaryDecorator && primary === false) {
      this.#error(primaryDecorator.location, `${owner} is declared with primary: false and @Primary()`)
    }
    return { name: resolvedName, primary: primaryDecorator !== undefined || primary === true }
  }

  /** Static non-empty string argument of `@Inject` / `@Named`. */
  #stringArg(decorator: DecoratorInfo): string | undefined {
    const arg = decorator.args[0]
    if (!arg) {
      this.#error(decorator.location, `@${decorator.name} requires a name: @${decorator.name}('name')`)
      return undefined
    }
    if (!arg.evaluated) {
      return undefined
    }
    if (typeof arg.value !== 'string' || arg.value === '') {
      this.#error(arg.location, `The argument of @${decorator.name} must be a non-empty string (got ${arg.text})`)
      return undefined
    }
    return arg.value
  }

  #constructorSite(param: ParameterInfo, cls: ClassInfo): ParameterSite {
    const inherited = cls.ctor.declaredBy !== undefined && cls.ctor.declaredBy !== cls.identity
    const label = `parameter '${param.name}' of ${cls.displayName}${inherited ? ` (inherited from ${displayNameOf(cls.ctor.declaredBy as string)})` : ''}`
    return this.#parameterSite(param, label, cls)
  }

  #methodSite(param: ParameterInfo, where: string): ParameterSite {
    return this.#parameterSite(param, `parameter '${param.name}' of ${where}`, undefined)
  }

  #parameterSite(param: ParameterInfo, label: string, cls: ClassInfo | undefined): ParameterSite {
    const inject = this.#single(param.decorators, CoreDecorator.Inject)
    const optional = param.decorators.some(decorator => decorator.identity === CoreDecorator.Optional)
    const qualifier = inject ? this.#stringArg(inject) : undefined
    const location = cls ? this.#visible(param.typeLocation, cls) : param.typeLocation
    return {
      spec: { type: param.type, qualifier, optional: optional || param.optional || param.hasDefault },
      label,
      subject: label.charAt(0).toUpperCase() + label.slice(1),
      location,
      rest: param.rest,
    }
  }

  #requestSite(request: InjectionRequest, index: number, cls: ClassInfo, extension: string): ParameterSite {
    const type: TypeInfo =
      typeof request.type === 'string' ? referenceType(request.type, displayNameOf(request.type), []) : request.type
    const label = request.label ?? `dependency #${index + 1} of ${cls.displayName} (${extension})`
    return {
      spec: { type, qualifier: request.qualifier, optional: request.optional === true },
      label,
      subject: label.charAt(0).toUpperCase() + label.slice(1),
      location: request.location ?? cls.location,
      rest: false,
    }
  }

  /** Interceptor chains of a class and its analysable bases (the most derived declaration of a method wins). */
  #interceptors(cls: ClassInfo): InterceptedMethodDraft[] {
    const seen = new Set<string>()
    const result: InterceptedMethodDraft[] = []
    const visited = new Set<string>()
    let current: ClassInfo | undefined = cls
    while (current && !visited.has(current.identity)) {
      visited.add(current.identity)
      for (const method of current.methods) {
        if (!method.static) {
          if (seen.has(method.name)) {
            continue
          }
          seen.add(method.name)
        }
        const chain = this.#chain(current, method)
        if (chain.length > 0) {
          result.push({ method, chain })
        }
      }
      current = this.#analyzer.baseOf(current)
    }
    return result.sort((a, b) => compareStrings(a.method.name, b.method.name))
  }

  #chain(cls: ClassInfo, method: MethodInfo): InterceptorLinkDraft[] {
    const chain: InterceptorLinkDraft[] = []
    for (const decorator of method.decorators) {
      if (decorator.identity === CoreDecorator.Intercept) {
        const [target, options] = decorator.args
        if (!target) {
          this.#error(decorator.location, '@Intercept requires an interceptor class: @Intercept(MyInterceptor)')
          continue
        }
        const ref = this.classRef(target, 'interceptor', decorator.name)
        if (ref) {
          chain.push(link(ref.token, decorator, options))
        }
      } else if (decorator.owner === MANIFEST_OWNER && decorator.identity !== undefined) {
        const interceptor = this.#catalog.get(decorator.identity, undefined)?.interceptor
        if (interceptor) {
          const ref = this.classRefOfIdentity(interceptor.interceptorIdentity, decorator.location, 'interceptor')
          chain.push(link(ref.token, decorator, decorator.args[0]))
        }
      }
    }
    if (chain.length === 0) {
      return chain
    }
    const where = `${cls.displayName}.${method.name}`
    const first = chain[0]?.decorator.location ?? method.location
    if (method.static) {
      this.#error(first, `Static method ${where} cannot be intercepted`, ['Interceptors apply to instance methods'])
      return []
    }
    if (method.privateName) {
      this.#error(first, `#private method ${where} cannot be intercepted`, [
        'Use a TypeScript `private` method instead of a #private name',
      ])
      return []
    }
    if (method.kind !== 'method' || method.computed) {
      this.#error(first, `${where} cannot be intercepted: interceptors apply to methods with a plain name`)
      return []
    }
    return chain
  }

  /** A location inside the scanned sources: inherited members of package classes point to the class. */
  #visible(location: Location, cls: ClassInfo): Location {
    return this.#project.isScanned(location.file) ? location : cls.location
  }

  #error(location: Location, message: string, hints?: readonly string[]): void {
    this.#report({
      code: ErrorCode.InvalidDecorator,
      severity: 'error',
      message,
      location,
      ...(hints ? { hints } : {}),
    })
  }
}

function link(token: Token, decorator: DecoratorInfo, options: ArgInfo | undefined): InterceptorLinkDraft {
  if (!options) {
    return { token, hasOptions: false, options: undefined, decorator }
  }
  return { token, hasOptions: true, options: options.evaluated ? options.value : options.ref, decorator }
}

/** `UserService`, or a description of an anonymous default-exported class. */
function describeClass(cls: ClassInfo): string {
  return cls.declaration.anonymous
    ? `The anonymous class exported by default from ${cls.relativeFile}`
    : cls.displayName
}

function whyNotPublic(method: MethodInfo): string {
  if (method.static) {
    return 'static'
  }
  if (method.privateName) {
    return 'a #private method'
  }
  return method.computed ? 'a computed member' : method.visibility
}

/** A concrete provided type: not `void`/`undefined`/`never`/`any`/`unknown`, no unbound type parameter. */
function isConcrete(type: TypeInfo): boolean {
  if (type.kind === 'primitive') {
    return !['void', 'undefined', 'null', 'never', 'any', 'unknown'].includes(type.name)
  }
  if (type.kind === 'typeParameter') {
    return false
  }
  if (type.kind === 'opaque') {
    return type.reason !== 'missing-annotation' && type.reason !== 'unresolved'
  }
  return true
}
