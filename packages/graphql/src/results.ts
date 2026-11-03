/**
 * Errors as data (RFC 0008): result mappers turn the error of a field into a value of its union.
 *
 * Decided at boot, per resolver-backed field: a field carries results when its type, without its
 * non-null wrapper, is a union (not a list) holding an object type declared by a result mapper
 * (`static types`). Only those fields get a wrapper (`pipeline.ts`); the others keep their resolve
 * function. On an error, the applicable mappers run in order; the first value resolving to a member
 * of the union is the field's value, otherwise the error is thrown back, to `errors[]`.
 */
import type { Container, CoreLogger } from '@znight/core'
import type { GraphQLResolveInfo } from 'graphql'
import type { Resolvable } from './format.ts'
import type { GraphQLFieldDefinition, GraphQLTypeDefinition } from './metadata.ts'
import type { GraphQLResultMapper, ResolverContext } from './types.ts'

import { ErrorCode, ZnightError } from '@znight/core'
import { isThenable } from '@znight/http'

import { resolveIn } from './format.ts'
import { typeResolver } from './schema.ts'
import { parseTypeRef } from './type-ref.ts'

/** A result mapper resolved at boot. */
export interface ResultMapperEntry {
  readonly resolvable: Resolvable<GraphQLResultMapper>
  /** For logs: the class name. */
  readonly name: string
  /** Declared object types, checked by {@link checkResultTypes}. */
  readonly types: readonly string[]
}

/** The value of a field for an error, or the error thrown back. */
export type Recover = (error: unknown, ctx: ResolverContext) => unknown

/** The object types a result mapper ref declares: `static types` of a class; for an instance, its `types` property or its class's. */
export function declaredTypes(ref: unknown): unknown {
  try {
    if (typeof ref === 'function') return (ref as { types?: unknown }).types
    const own = (ref as { types?: unknown }).types
    if (own !== undefined) return own
    return ((ref as { constructor?: unknown }).constructor as { types?: unknown } | undefined)?.types
  } catch {
    // a throwing getter: reported as no types
    return undefined
  }
}

/**
 * Checks the declared types of the result mappers against the schema's types: a non-empty array of
 * names of object types. Every problem in one ZNIGHT066 error.
 */
export function checkResultTypes(
  mappers: readonly { readonly name: string; readonly types: unknown }[],
  types: readonly GraphQLTypeDefinition[],
): void {
  if (mappers.length === 0) return
  const kinds = new Map(types.map(type => [type?.name, type?.kind]))
  const problems: string[] = []
  for (const mapper of mappers) {
    const declared = mapper.types
    if (!Array.isArray(declared) || declared.length === 0) {
      problems.push(
        `the result mapper ${mapper.name} declares no types (static readonly types = [...object type names])`,
      )
      continue
    }
    for (const name of declared as unknown[]) {
      if (typeof name !== 'string' || kinds.get(name) !== 'object') {
        problems.push(
          `the result mapper ${mapper.name} declares ${typeof name === 'string' ? name : String(name)}, which is not an object type of the schema`,
        )
      }
    }
  }
  if (problems.length === 0) return
  throw new ZnightError(ErrorCode.InvalidGraphQLSetup, `GraphQLPlugin: ${problems.join('; ')}`, {
    hints: [
      "A result mapper declares the object types its values may have: static readonly types = ['NotFoundRejection'] (RFC 0008)",
    ],
  })
}

/** The union of a field type and its members, by union name. */
interface Union {
  readonly name: string
  readonly members: ReadonlySet<string>
  readonly typeOf: (value: unknown) => string | undefined
}

/** Decides which fields carry results, and builds their {@link Recover} functions. */
export class ResultMappers {
  readonly #container: Container
  readonly #logger: CoreLogger
  readonly #mappers: readonly ResultMapperEntry[]
  readonly #types: readonly GraphQLTypeDefinition[]
  /** Built on the first field, once the schema construction checked the section's structure. */
  #index: { readonly objects: ReadonlySet<string>; readonly unions: ReadonlyMap<string, Union> } | undefined
  #fields = 0

  constructor(
    container: Container,
    logger: CoreLogger,
    mappers: readonly ResultMapperEntry[],
    types: readonly GraphQLTypeDefinition[],
  ) {
    this.#container = container
    this.#logger = logger
    this.#mappers = mappers
    this.#types = types
  }

  /** Fields that carry results so far. */
  get fields(): number {
    return this.#fields
  }

  /** The {@link Recover} function of `field`, `undefined` when it carries no result. */
  recover(field: GraphQLFieldDefinition, coordinate: string): Recover | undefined {
    if (this.#mappers.length === 0) return undefined
    const ref = parseTypeRef(field.type)
    if (ref?.kind !== 'named') return undefined
    this.#index ??= index(this.#types)
    const objects = this.#index.objects
    const union = this.#index.unions.get(ref.name)
    if (union === undefined) return undefined
    const applicable = this.#mappers.filter(mapper => mapper.types.some(type => union.members.has(type)))
    if (applicable.length === 0) return undefined
    this.#fields++
    const container = this.#container
    const logger = this.#logger
    return (error, ctx) => {
      for (const mapper of applicable) {
        let value: unknown
        let type: string | undefined
        try {
          value = resolveIn(container, mapper.resolvable).toResult(error, ctx)
          if (value === undefined || value === null) continue
          if (isThenable(value)) {
            // not awaited: the field cannot wait for a mapper, and its rejection must not go unhandled
            Promise.resolve(value).catch(noop)
            logger.error(
              `GraphQLPlugin: the result mapper ${mapper.name} returned a promise: toResult() must be synchronous`,
              details(ctx, coordinate, error),
            )
            continue
          }
          // the discriminator reads the value (a getter, a class check): a failure is the mapper's
          type = union.typeOf(value)
        } catch (failure) {
          logger.error(`GraphQLPlugin: the result mapper ${mapper.name} failed`, details(ctx, coordinate, failure))
          continue
        }
        if (type !== undefined && union.members.has(type)) {
          // the business path: no request id (it may be minted on first read) nor path built for a debug line
          logger.debug(`GraphQL: error resolved as ${type} in ${coordinate}`, { coordinate, type })
          return value
        }
        if (type !== undefined && objects.has(type)) {
          logger.debug(
            `GraphQLPlugin: the result mapper ${mapper.name} returned a value of ${type}, not a member of ${union.name} (${coordinate}): skipped`,
            details(ctx, coordinate, error),
          )
        } else {
          logger.warn(
            `GraphQLPlugin: the result mapper ${mapper.name} returned a value of no type of the schema (${coordinate}): skipped`,
            details(ctx, coordinate, error),
          )
        }
      }
      throw error
    }
  }
}

function index(types: readonly GraphQLTypeDefinition[]): {
  readonly objects: ReadonlySet<string>
  readonly unions: ReadonlyMap<string, Union>
} {
  const objects = new Set<string>()
  const unions = new Map<string, Union>()
  for (const type of types) {
    if (type.kind === 'object') objects.add(type.name)
    else if (type.kind === 'union') {
      unions.set(type.name, {
        name: type.name,
        members: new Set(type.members),
        typeOf: typeResolver(type.discriminator),
      })
    }
  }
  return { objects, unions }
}

function noop(): void {}

function details(ctx: ResolverContext, coordinate: string, err: unknown): Record<string, unknown> {
  return { err, requestId: ctx.operation.requestId, coordinate, path: pathOf(ctx.info).join('.') }
}

function pathOf(info: GraphQLResolveInfo): (string | number)[] {
  const path: (string | number)[] = []
  for (let step: GraphQLResolveInfo['path'] | undefined = info.path; step !== undefined; step = step.prev) {
    path.push(step.key)
  }
  return path.reverse()
}
