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
  /** Input object types by name (null handling of nested input values). */
  readonly inputs: ReadonlyMap<string, GraphQLInputTypeDefinition>
}

/** The generated invoker of a binding. */
type Invoke = GraphQLResolverBinding['invoke']

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
  const invoke: Invoke = binding.invoke
  const target = options.resolver(binding, coordinate)
  const guards: Resolvable<GraphQLGuard>[] = [
    ...(globalGuardsApply(binding) ? options.globalGuards : []),
    ...binding.guards.map(token => options.guard(token, coordinate)),
  ]
  const normalize = field.args === undefined ? undefined : normalizers.args(field.args)

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
    const route = Object.freeze({ meta: binding.meta, coordinate })
    const parentType = parent.name
    const fieldName = field.name
    const forbidden = (): never => {
      throw new GraphQLException(`Not allowed to resolve ${coordinate}`, { code: GraphQLErrorCode.Forbidden })
    }
    resolve = (p, a, c, i) => {
      const operation = c as OperationContext
      const args = a as GraphQLArgs
      const allowed = runGuards(
        container,
        guards,
        new FieldContext(route, operation, parentType, fieldName, args, p, i),
      )
      // §8.5: guards (they see the coerced arguments), then null handling, then invoke
      const call = (): unknown => {
        if (normalize !== undefined) normalize(args)
        return invoke(resolveIn(container, target), p, args, operation, i)
      }
      if (allowed === true) return call()
      if (allowed === false) return forbidden()
      return allowed.then(ok => (ok ? call() : forbidden()))
    }
  }
  if (binding.operation === 'subscription') {
    // the method gives the source event stream; each event is the field value
    return { subscribe: resolve, resolve: identity }
  }
  return { resolve }
}

function identity(payload: unknown): unknown {
  return payload
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
