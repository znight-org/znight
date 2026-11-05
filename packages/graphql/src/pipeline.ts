/**
 * The resolver pipeline (RFC 0005 §5.9, §7.3, §8.5): the resolve function of every resolver-backed
 * field, decided once at boot.
 *
 * 1. the resolver instance: the singleton resolved at boot, or `container.get(token)` in the
 *    current scope (request-scoped and transient resolvers);
 * 2. guards: global ones (on root fields, and on field resolvers carrying their own metadata), class
 *    `@UseGuard`, method `@UseGuard`; `false` fails the field with `FORBIDDEN`;
 * 3. null handling of arguments (`nullAsUndefined`), only where a flag is reachable;
 * 4. `invoke(resolver, parent, args, context, info)`.
 *
 * A field without guards nor normaliser calls `invoke` from the closure graphql-js needs anyway:
 * no extra wrapper, no promise, no `await`. Plain property fields keep graphql-js' default resolver.
 * A field that carries results (RFC 0008, `results.ts`) gets one wrapper around the whole pipeline,
 * catching its errors to turn them into values; no other field does.
 */
import type { Container, Token } from '@znight/core'
import type { GraphQLFieldResolver, GraphQLResolveInfo } from 'graphql'
import type { OperationContext } from './context.ts'
import type { Resolvable } from './format.ts'
import type {
  GraphQLArgumentDefinition,
  GraphQLFieldDefinition,
  GraphQLInputTypeDefinition,
  GraphQLObjectTypeDefinition,
  GraphQLResolverBinding,
} from './metadata.ts'
import type { Recover } from './results.ts'
import type { FieldFunctions, FieldFunctionsFactory } from './schema.ts'
import type { GraphQLTypeRef } from './type-ref.ts'
import type { GraphQLArgs, GraphQLContext, GraphQLGuard, ResolverContext } from './types.ts'

import { isThenable } from '@znight/http'

import { GraphQLErrorCode, GraphQLException } from './errors.ts'
import { resolveIn } from './format.ts'
import { parseTypeRef } from './type-ref.ts'

/** What the pipeline needs, resolved at boot. */
export interface PipelineOptions {
  readonly container: Container
  /** Global guards (plugin option), in order. */
  readonly globalGuards: readonly Resolvable<GraphQLGuard>[]
  /** The guard provider of a `@UseGuard` token (memoised by the caller). */
  readonly guard: (token: Token, coordinate: string) => Resolvable<GraphQLGuard>
  /** The resolver provider of a binding (memoised by the caller). */
  readonly resolver: (binding: GraphQLResolverBinding, coordinate: string) => Resolvable<object>
  /** The provider of a custom parameter resolver class (RFC 0010; memoised by the caller). */
  readonly paramResolver?: (token: Token, coordinate: string) => Resolvable<object>
  /** Input object types by name (null handling of nested input values). */
  readonly inputs: ReadonlyMap<string, GraphQLInputTypeDefinition>
  /** The {@link Recover} function of a field that carries results (RFC 0008), `undefined` for the others. */
  readonly results?: (field: GraphQLFieldDefinition, coordinate: string) => Recover | undefined
}

/** The generated invoker of a binding. */
type Invoke = (
  resolver: object,
  parent: unknown,
  args: GraphQLArgs,
  context: GraphQLContext,
  info: GraphQLResolveInfo,
  field?: ResolverContext,
  resolvers?: readonly object[],
) => unknown

/** Mutates a coerced argument or input value in place: `null` → `undefined` where flagged. */
type Normalize = (value: unknown) => void

/** Whether global guards run on a field: root fields always, field resolvers when they carry metadata (§5.9). */
export function globalGuardsApply(binding: GraphQLResolverBinding): boolean {
  return binding.operation !== 'field' || Object.keys(binding.meta).length > 0
}

/** The {@link FieldFunctionsFactory} of the plugin. */
export function pipelineFactory(options: PipelineOptions): FieldFunctionsFactory {
  const normalizers = new NormalizerBuilder(options.inputs)
  return (binding, coordinate, field, parent) =>
    fieldFunctions(options, normalizers, binding, coordinate, field, parent)
}

function fieldFunctions(
  options: PipelineOptions,
  normalizers: NormalizerBuilder,
  binding: GraphQLResolverBinding,
  coordinate: string,
  field: GraphQLFieldDefinition,
  parent: GraphQLObjectTypeDefinition,
): FieldFunctions {
  const container = options.container
  const target = options.resolver(binding, coordinate)
  const guards: Resolvable<GraphQLGuard>[] = [
    ...(globalGuardsApply(binding) ? options.globalGuards : []),
    ...binding.guards.map(token => options.guard(token, coordinate)),
  ]
  const normalize = field.args === undefined ? undefined : normalizers.args(field.args)
  const recover = options.results?.(field, coordinate)
  const custom = binding.context === true
  const route =
    guards.length === 0 && recover === undefined && !custom
      ? undefined
      : Object.freeze({ meta: binding.meta, coordinate })
  const parentType = parent.name
  const fieldName = field.name
  const invoke: Invoke = custom
    ? customInvoke(options, binding, coordinate, route as ResolverContext['route'], parentType, fieldName)
    : (binding.invoke as Invoke)

  let resolve: GraphQLFieldResolver<unknown, unknown>
  if (guards.length === 0) {
    // the common case: one closure, invoke called directly (no promise, no await)
    if (target.token === undefined) {
      const instance = target.instance
      resolve =
        normalize === undefined
          ? (p, a, c, i) => invoke(instance, p, a as GraphQLArgs, c as GraphQLContext, i)
          : (p, a, c, i) => {
              normalize(a)
              return invoke(instance, p, a as GraphQLArgs, c as GraphQLContext, i)
            }
    } else {
      const token = target.token
      resolve =
        normalize === undefined
          ? (p, a, c, i) => invoke(container.get(token), p, a as GraphQLArgs, c as GraphQLContext, i)
          : (p, a, c, i) => {
              normalize(a)
              return invoke(container.get(token), p, a as GraphQLArgs, c as GraphQLContext, i)
            }
    }
  } else {
    const forbidden = (): never => {
      throw new GraphQLException(`Not allowed to resolve ${coordinate}`, { code: GraphQLErrorCode.Forbidden })
    }
    resolve = (p, a, c, i) => {
      const operation = c as OperationContext
      const args = a as GraphQLArgs
      const fieldContext = new FieldContext(
        route as ResolverContext['route'],
        operation,
        parentType,
        fieldName,
        args,
        p,
        i,
      )
      const allowed = runGuards(container, guards, fieldContext)
      // §8.5: guards (they see the coerced arguments), then null handling, then invoke (custom
      // parameters share the guards' ResolverContext)
      const call = (): unknown => {
        if (normalize !== undefined) normalize(args)
        return invoke(resolveIn(container, target), p, args, operation, i, fieldContext)
      }
      if (allowed === true) return call()
      if (allowed === false) return forbidden()
      return allowed.then(ok => (ok ? call() : forbidden()))
    }
  }
  const subscription = binding.operation === 'subscription'
  if (recover !== undefined) {
    resolve = withResults(resolve, recover, route as ResolverContext['route'], parentType, fieldName, subscription)
  }
  if (subscription) {
    // the method gives the source event stream; each event is the field value
    return { subscribe: resolve, resolve: identity }
  }
  return { resolve }
}

function identity(payload: unknown): unknown {
  return payload
}

/**
 * The invoke of a method with custom parameters (RFC 0010): the generated `invoke` receives the
 * field's `ResolverContext` (the guards' one when the field has guards, else a new one) and the
 * instances of its parameter resolvers: one frozen array resolved at boot when they are all
 * singletons, otherwise resolved in the operation scope on every call.
 */
function customInvoke(
  options: PipelineOptions,
  binding: GraphQLResolverBinding,
  coordinate: string,
  route: ResolverContext['route'],
  parentType: string,
  fieldName: string,
): Invoke {
  const generated = binding.invoke as Invoke
  const container = options.container
  const tokens = binding.paramResolvers ?? []
  const resolvers = tokens.map(token => {
    if (options.paramResolver === undefined) throw new TypeError(`No parameter resolver for ${coordinate}`)
    return options.paramResolver(token, coordinate)
  })
  const context = (p: unknown, a: GraphQLArgs, c: GraphQLContext, i: GraphQLResolveInfo, f?: ResolverContext) =>
    f ?? new FieldContext(route, c as OperationContext, parentType, fieldName, a, p, i)
  if (resolvers.length === 0) {
    return (r, p, a, c, i, f) => generated(r, p, a, c, i, context(p, a, c, i, f))
  }
  if (resolvers.every(resolver => resolver.token === undefined)) {
    const instances = Object.freeze(resolvers.map(resolver => resolveIn(container, resolver)))
    return (r, p, a, c, i, f) => generated(r, p, a, c, i, context(p, a, c, i, f), instances)
  }
  return (r, p, a, c, i, f) =>
    generated(
      r,
      p,
      a,
      c,
      i,
      context(p, a, c, i, f),
      resolvers.map(resolver => resolveIn(container, resolver)),
    )
}

/**
 * The resolve function of a field that carries results (RFC 0008): errors of the whole pipeline
 * (guards, null handling, `invoke`), thrown or rejected, go through `recover`. Synchronous results
 * stay synchronous; a promise gets one rejection handler. For a subscription, a value is a source
 * stream of that single event.
 */
function withResults(
  resolve: GraphQLFieldResolver<unknown, unknown>,
  recover: Recover,
  route: ResolverContext['route'],
  parentType: string,
  fieldName: string,
  subscription: boolean,
): GraphQLFieldResolver<unknown, unknown> {
  const fail = (error: unknown, p: unknown, a: unknown, c: unknown, i: GraphQLResolveInfo): unknown => {
    const value = recover(
      error,
      new FieldContext(route, c as OperationContext, parentType, fieldName, a as GraphQLArgs, p, i),
    )
    return subscription ? once(value) : value
  }
  // captures nothing per call: the rejection handler is created in recoverAsync, on the promise path only
  return (p, a, c, i) => {
    let result: unknown
    try {
      result = resolve(p, a, c, i)
    } catch (error) {
      return fail(error, p, a, c, i)
    }
    return isThenable(result) ? recoverAsync(result, fail, p, a, c, i) : result
  }
}

function recoverAsync(
  result: PromiseLike<unknown>,
  fail: (error: unknown, p: unknown, a: unknown, c: unknown, i: GraphQLResolveInfo) => unknown,
  p: unknown,
  a: unknown,
  c: unknown,
  i: GraphQLResolveInfo,
): Promise<unknown> {
  return Promise.resolve(result).then(undefined, error => fail(error, p, a, c, i))
}

/** A source event stream of one event. */
// biome-ignore lint/suspicious/useAwait: an async generator is the shortest AsyncIterable of one value
async function* once(value: unknown): AsyncGenerator<unknown> {
  yield value
}

/** Runs guards in order, synchronously until one returns a promise. */
function runGuards(
  container: Container,
  guards: readonly Resolvable<GraphQLGuard>[],
  ctx: ResolverContext,
  start = 0,
): boolean | Promise<boolean> {
  for (let index = start; index < guards.length; index++) {
    const result = resolveIn(container, guards[index] as Resolvable<GraphQLGuard>).canResolve(ctx)
    if (isThenable(result)) {
      return Promise.resolve(result).then(ok => (ok ? runGuards(container, guards, ctx, index + 1) : false))
    }
    if (!result) return false
  }
  return true
}

/** What a guard receives (§5.9): a `RouteMetaCarrier` with the field's effective metadata. */
class FieldContext implements ResolverContext {
  readonly route: ResolverContext['route']
  readonly operation: OperationContext
  readonly parentType: string
  readonly field: string
  readonly args: GraphQLArgs
  readonly parent: unknown
  readonly info: GraphQLResolveInfo

  constructor(
    route: ResolverContext['route'],
    operation: OperationContext,
    parentType: string,
    field: string,
    args: GraphQLArgs,
    parent: unknown,
    info: GraphQLResolveInfo,
  ) {
    this.route = route
    this.operation = operation
    this.parentType = parentType
    this.field = field
    this.args = args
    this.parent = parent
    this.info = info
  }

  get http(): ResolverContext['http'] {
    return this.operation.http
  }
}

/** One step of a normaliser: an argument or input field. */
interface Step {
  readonly name: string
  /** The value itself: `null` → `undefined`. */
  readonly own: boolean
  /** Nested input values. */
  readonly nested: Normalize | undefined
}

/**
 * Builds normalisers (§7.3) at boot. Values are mutated in place: graphql-js creates the argument
 * object of every call and the coerced input objects, and the flags of an input type are the same
 * wherever it is used, so a value shared through a variable is normalised the same way twice.
 */
class NormalizerBuilder {
  readonly #inputs: ReadonlyMap<string, GraphQLInputTypeDefinition>
  /** Input type → its normaliser (`null`: nothing to do), `PENDING` while being built (cycles). */
  readonly #types = new Map<string, Normalize | null | typeof PENDING>()

  constructor(inputs: ReadonlyMap<string, GraphQLInputTypeDefinition>) {
    this.#inputs = inputs
  }

  /** The normaliser of a field's arguments, `undefined` when no flag is reachable. */
  args(args: readonly GraphQLArgumentDefinition[]): ((args: unknown) => void) | undefined {
    const steps = this.#steps(args)
    return steps === undefined ? undefined : record => applySteps(record, steps)
  }

  #steps(values: readonly GraphQLArgumentDefinition[]): readonly Step[] | undefined {
    const steps: Step[] = []
    for (const value of values) {
      const own = value.nullAsUndefined === true
      const ref = parseTypeRef(value.type)
      const nested = ref === undefined ? undefined : this.#value(ref)
      if (own || nested !== undefined) steps.push({ name: value.name, own, nested })
    }
    return steps.length === 0 ? undefined : steps
  }

  #value(ref: GraphQLTypeRef): Normalize | undefined {
    if (ref.kind === 'list') {
      const item = this.#value(ref.of)
      return item === undefined
        ? undefined
        : value => {
            if (Array.isArray(value)) for (const entry of value) item(entry)
          }
    }
    return this.#input(ref.name)
  }

  #input(name: string): Normalize | undefined {
    const known = this.#types.get(name)
    if (known === PENDING) {
      // a cycle through this type: delegate to its normaliser once built
      return value => {
        const normalize = this.#types.get(name)
        if (typeof normalize === 'function') normalize(value)
      }
    }
    if (known !== undefined) return known ?? undefined
    const type = this.#inputs.get(name)
    if (type === undefined) return undefined
    this.#types.set(name, PENDING)
    const steps = this.#steps(type.fields)
    const normalize: Normalize | null = steps === undefined ? null : value => applySteps(value, steps)
    this.#types.set(name, normalize)
    return normalize ?? undefined
  }
}

const PENDING: unique symbol = Symbol('pending')

function applySteps(value: unknown, steps: readonly Step[]): void {
  if (value === null || typeof value !== 'object') return
  const record = value as Record<string, unknown>
  for (const step of steps) {
    const entry = record[step.name]
    if (entry === null) {
      if (step.own) record[step.name] = undefined
    } else if (entry !== undefined && step.nested !== undefined) {
      step.nested(entry)
    }
  }
}
