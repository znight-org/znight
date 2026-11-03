/**
 * Error formatting (RFC 0005 §5.10, §8.8): what clients see of the errors of a result.
 *
 * Execution errors, in order: a `GraphQLException` (or a `GraphQLError` thrown by user code) as is →
 * the error mappers, in order → an `HttpException` mapped by status (5xx masked) → anything else
 * masked as `Unexpected error.` with `INTERNAL_SERVER_ERROR`, logged once (unless `exposeErrors`).
 * Request errors (parse, validation, variables, limits) carry their code and are never logged
 * above `debug`.
 *
 * Kept apart from the import-free `errors.ts`, which the compiler side may reach.
 */
import type { Container, CoreLogger, Token } from '@znight/core'
import type {
  ASTNode,
  DocumentNode,
  FieldNode,
  FragmentDefinitionNode,
  GraphQLField,
  GraphQLFormattedError,
  GraphQLNamedType,
  GraphQLSchema,
  OperationDefinitionNode,
  SelectionSetNode,
} from 'graphql'
import type { GraphQLContext, GraphQLErrorMapper } from './types.ts'

import { isHttpException, ValidationException } from '@znight/http'
import { GraphQLError, getNamedType, isObjectType, Kind } from 'graphql'

import { GraphQLErrorCode, GraphQLException } from './errors.ts'

/** A provider resolved once (singleton, instance) or per use, in the current scope (token). */
export type Resolvable<T> = { readonly instance: T; readonly token?: undefined } | { readonly token: Token }

/** Resolves a {@link Resolvable} (in the current scope for scoped providers). */
export function resolveIn<T>(container: Container, resolvable: Resolvable<T>): T {
  return resolvable.token === undefined ? resolvable.instance : (container.get(resolvable.token) as T)
}

/** Message of masked errors. */
export const MASKED_MESSAGE = 'Unexpected error.'

/** `HttpException` status → `extensions.code` (other 4xx: `BAD_REQUEST`, 5xx: masked). */
const STATUS_CODES: ReadonlyMap<number, string> = new Map([
  [400, GraphQLErrorCode.BadUserInput],
  [401, GraphQLErrorCode.Unauthenticated],
  [403, GraphQLErrorCode.Forbidden],
  [404, GraphQLErrorCode.NotFound],
  [409, GraphQLErrorCode.Conflict],
  [429, GraphQLErrorCode.TooManyRequests],
])

/** Options of {@link ErrorFormatter}. */
export interface ErrorFormatterOptions {
  readonly container: Container
  readonly mappers: readonly Resolvable<GraphQLErrorMapper>[]
  readonly exposeErrors: boolean
  readonly logger: CoreLogger
  readonly schema: GraphQLSchema
}

/** Formats the errors of execution results. One per plugin, built at boot. */
export class ErrorFormatter {
  readonly #container: Container
  readonly #mappers: readonly Resolvable<GraphQLErrorMapper>[]
  readonly #expose: boolean
  readonly #logger: CoreLogger
  readonly #schema: GraphQLSchema

  constructor(options: ErrorFormatterOptions) {
    this.#container = options.container
    this.#mappers = options.mappers
    this.#expose = options.exposeErrors
    this.#logger = options.logger
    this.#schema = options.schema
  }

  /** Formats the errors of an executed operation (field errors). */
  format(errors: readonly GraphQLError[], ctx: GraphQLContext): GraphQLFormattedError[] {
    const result: GraphQLFormattedError[] = new Array(errors.length)
    // the same cause may fail several fields (a loader rejecting every key): logged once
    let logged: Set<unknown> | undefined
    for (let index = 0; index < errors.length; index++) {
      const error = errors[index] as GraphQLError
      const original = error.originalError
      if (original === undefined || original === null) {
        // produced by graphql-js during execution (non-null violation...): about the schema, shown as is
        result[index] = withCode(
          error,
          error.extensions['code'] === undefined ? GraphQLErrorCode.InternalServerError : undefined,
        )
        continue
      }
      const exposed = this.#exposed(original, ctx)
      if (exposed !== undefined) {
        result[index] = render(error, exposed)
        continue
      }
      if (original instanceof GraphQLError) {
        result[index] = { ...original.toJSON(), ...located(error) }
        continue
      }
      logged ??= new Set()
      if (!logged.has(original)) {
        logged.add(original)
        this.#log(error, original, ctx)
      }
      result[index] = {
        message: this.#expose && original instanceof Error ? original.message : MASKED_MESSAGE,
        ...located(error),
        extensions: { code: GraphQLErrorCode.InternalServerError },
      }
    }
    return result
  }

  /** The exception shown for `original`, `undefined` when it must be masked. */
  #exposed(original: unknown, ctx: GraphQLContext): GraphQLException | undefined {
    if (original instanceof GraphQLException) return original
    for (const resolvable of this.#mappers) {
      let mapped: GraphQLException | undefined
      try {
        mapped = resolveIn(this.#container, resolvable).map(original, ctx)
      } catch (error) {
        this.#logger.error('GraphQLPlugin: an error mapper failed', { err: error, requestId: ctx.requestId })
        continue
      }
      if (mapped !== undefined) return mapped
    }
    if (isHttpException(original)) {
      const status = original.status
      if (original instanceof ValidationException) {
        return new GraphQLException(original.message, {
          code: GraphQLErrorCode.BadUserInput,
          extensions: { issues: original.details },
        })
      }
      if (status >= 500) return undefined
      return new GraphQLException(original.message, {
        code: STATUS_CODES.get(status) ?? GraphQLErrorCode.BadRequest,
      })
    }
    return undefined
  }

  #log(error: GraphQLError, cause: unknown, ctx: GraphQLContext): void {
    const coordinate = coordinateOf(this.#schema, ctx.document, ctx.operationName, error.path)
    this.#logger.error(`GraphQL: unexpected error${coordinate === undefined ? '' : ` in ${coordinate}`}`, {
      err: cause,
      requestId: ctx.requestId,
      ...(coordinate === undefined ? {} : { coordinate }),
      ...(error.path === undefined ? {} : { path: error.path.join('.') }),
    })
  }
}

function located(error: GraphQLError): Pick<GraphQLFormattedError, 'locations' | 'path'> {
  return {
    ...(error.locations === undefined ? {} : { locations: error.locations }),
    ...(error.path === undefined ? {} : { path: error.path }),
  }
}

/** `{ message, locations, path, extensions: { ...extensions, code } }`. */
function render(error: GraphQLError, exception: GraphQLException): GraphQLFormattedError {
  return {
    message: exception.message,
    ...located(error),
    extensions: { ...exception.extensions, code: exception.code },
  }
}

/** A graphql-js error formatted with `extensions.code` set to `code` (kept as is without code). */
export function withCode(error: GraphQLError, code: string | undefined): GraphQLFormattedError {
  const formatted = error.toJSON()
  if (code === undefined) return formatted
  return { ...formatted, extensions: { ...formatted.extensions, code } }
}

/** A request error (no location): `{ message, extensions: { code } }`. */
export function requestError(
  message: string,
  code: string,
  nodes?: ASTNode | readonly ASTNode[],
): GraphQLFormattedError {
  return withCode(new GraphQLError(message, nodes === undefined ? {} : { nodes }), code)
}

/**
 * The schema coordinate (`Book.author`) of the field at `path`, found by walking the operation's
 * selections (aliases, fragments, inline fragments). Best effort, for logs: `undefined` when the
 * path crosses a union without a type condition.
 */
export function coordinateOf(
  schema: GraphQLSchema,
  document: DocumentNode,
  operationName: string | undefined,
  path: readonly (string | number)[] | undefined,
): string | undefined {
  if (path === undefined || path.length === 0) return undefined
  const fragments = new Map<string, FragmentDefinitionNode>()
  let operation: OperationDefinitionNode | undefined
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) fragments.set(definition.name.value, definition)
    else if (
      definition.kind === Kind.OPERATION_DEFINITION &&
      (operationName === undefined || definition.name?.value === operationName)
    ) {
      operation ??= definition
    }
  }
  if (operation === undefined) return undefined
  let type: GraphQLNamedType | undefined | null = schema.getRootType(operation.operation)
  let selections: SelectionSetNode[] = [operation.selectionSet]
  let coordinate: string | undefined
  for (const segment of path) {
    if (typeof segment === 'number') continue
    const found = findField(selections, segment, fragments, type?.name)
    if (found === undefined || type === undefined || type === null) return undefined
    const parent: GraphQLNamedType | undefined | null =
      found.typeCondition === undefined ? type : schema.getType(found.typeCondition)
    if (!isObjectType(parent)) return undefined
    const field: GraphQLField<unknown, unknown> | undefined = parent.getFields()[found.field.name.value]
    coordinate = `${parent.name}.${found.field.name.value}`
    if (field === undefined) return coordinate
    type = getNamedType(field.type)
    selections = found.field.selectionSet === undefined ? [] : [found.field.selectionSet]
  }
  return coordinate
}

function findField(
  sets: readonly SelectionSetNode[],
  key: string,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  typeCondition: string | undefined,
): { readonly field: FieldNode; readonly typeCondition: string | undefined } | undefined {
  for (const set of sets) {
    for (const selection of set.selections) {
      if (selection.kind === Kind.FIELD) {
        if ((selection.alias ?? selection.name).value === key) return { field: selection, typeCondition }
      } else {
        const nested = selection.kind === Kind.INLINE_FRAGMENT ? selection : fragments.get(selection.name.value)
        if (nested === undefined) continue
        const found = findField(
          [nested.selectionSet],
          key,
          fragments,
          nested.typeCondition?.name.value ?? typeCondition,
        )
        if (found !== undefined) return found
      }
    }
  }
  return undefined
}
