/**
 * Type-based coercion of raw request values (route parameters, query values, headers) to the
 * declared type of a handler parameter (README, "Compiler contract" → `coerce.X` by declared type).
 */
import type { AnalyzeContext, ClassInfo, MethodInfo, ParameterInfo, TypeInfo } from '@znight/compiler'
import type { CoercionPlan, HttpControllerData, ParamCoercion, ScalarCoercion } from './model.ts'

import { child, defaultValueOf, isNode, unwrap } from './ast.ts'

type Context = AnalyzeContext<HttpControllerData>
type Project = Context['project']
type ExpressionInput = Parameters<Project['evaluate']>[1]
type ScopeInput = Parameters<Project['evaluate']>[0]
type EnumValue = string | number | boolean

const DATE_IDENTITY = 'globalThis#Date'
const STRING: TypeInfo = { kind: 'primitive', name: 'string' }
const NUMBER: TypeInfo = { kind: 'primitive', name: 'number' }
const BOOLEAN: TypeInfo = { kind: 'primitive', name: 'boolean' }
const BIGINT: TypeInfo = { kind: 'primitive', name: 'bigint' }
const DATE: TypeInfo = { kind: 'reference', identity: DATE_IDENTITY, name: 'Date', typeArgs: [] }

/** The type of a handler parameter: its annotation, or the type of its default value. */
export interface ParameterType {
  /** `undefined` when the parameter has no annotation and its default value tells nothing. */
  readonly type: TypeInfo | undefined
  /** `?`, default value, `| undefined` or `| null`. */
  readonly optional: boolean
}

/** Result of {@link planCoercion}. */
export type CoercionResult =
  | { readonly ok: true; readonly coercion: ParamCoercion }
  | { readonly ok: false; readonly reason: string; readonly hints: readonly string[] }

/** Annotated or inferred type of a parameter. */
export function parameterType(ctx: Context, cls: ClassInfo, method: MethodInfo, param: ParameterInfo): ParameterType {
  let type: TypeInfo | undefined = param.type
  if (param.type.kind === 'opaque' && param.type.reason === 'missing-annotation') {
    type = param.hasDefault ? inferFromDefault(ctx, cls, method, param) : undefined
  }
  const nullish = type !== undefined && hasNullish(type)
  return { type, optional: param.optional || param.hasDefault || nullish }
}

/**
 * Plans the coercion of a raw value to `type`. `required` is set for route parameters, which are
 * always present (no `coerce.optional`).
 */
export function planCoercion(
  ctx: Context,
  declared: ParameterType,
  param: ParameterInfo,
  required: boolean,
): CoercionResult {
  const type = declared.type
  if (type === undefined) {
    return {
      ok: false,
      reason: `the type of parameter '${param.name}' is unknown`,
      hints: [`Annotate the parameter: ${param.name}: string`],
    }
  }
  const { type: base } = ctx.types.stripNullish(type)
  const raw = isRaw(base)
  if (raw) {
    return { ok: true, coercion: { plan: { kind: 'raw' }, cast: false } }
  }
  const scalar = scalarPlan(ctx, base)
  let plan: CoercionPlan
  let cast: boolean
  if ('reason' in scalar) {
    if (base.kind !== 'array') {
      return failure(ctx, type, scalar.reason)
    }
    const item = scalarPlan(ctx, base.element)
    if ('reason' in item) {
      return failure(ctx, type, item.reason)
    }
    plan = { kind: 'array', item: item.plan }
    cast = item.cast
  } else {
    plan = scalar.plan
    cast = scalar.cast
  }
  if (!required && declared.optional) {
    plan = { kind: 'optional', item: plan }
    // `coerce.optional` returns `T | undefined`: `x: T | null` (without `?` / default) needs a cast
    cast ||= !(param.optional || param.hasDefault || acceptsUndefined(type))
  }
  return { ok: true, coercion: { plan, cast } }
}

/** `unknown` and `any`: the raw value is passed as is. */
export function isRaw(type: TypeInfo): boolean {
  return type.kind === 'primitive' && (type.name === 'unknown' || type.name === 'any')
}

type ScalarResult =
  | { readonly plan: CoercionPlan; readonly cast: boolean }
  | { readonly reason: string; readonly cast?: undefined }

function scalarPlan(ctx: Context, type: TypeInfo): ScalarResult {
  switch (type.kind) {
    case 'primitive': {
      const kind = primitiveCoercion(type.name)
      return kind ? { plan: { kind }, cast: false } : { reason: `'${type.name}' values cannot be read from a request` }
    }
    case 'literal':
      return typeof type.value === 'bigint'
        ? { reason: 'bigint literal types are not supported' }
        : { plan: { kind: 'enum', values: [type.value] }, cast: false }
    case 'union': {
      const values: EnumValue[] = []
      for (const member of type.types) {
        if (member.kind === 'literal' && typeof member.value !== 'bigint') {
          values.push(member.value)
        } else if (member.kind === 'primitive' && member.name === 'boolean') {
          values.push(false, true)
        } else {
          return { reason: 'only unions of literal types can be coerced' }
        }
      }
      return { plan: { kind: 'enum', values }, cast: false }
    }
    case 'reference': {
      if (type.identity === DATE_IDENTITY) {
        return { plan: { kind: 'date' }, cast: false }
      }
      const values = enumValues(ctx, type.identity)
      if (values) {
        // enum members are nominal: the literal values are cast to the enum type
        return values.length === 0
          ? { reason: `the enum ${type.name} has no member` }
          : { plan: { kind: 'enum', values }, cast: true }
      }
      return { reason: 'objects cannot be read from a single request value' }
    }
    case 'intersection': {
      // branded primitives: `string & { readonly __brand: 'UserId' }`
      const primitives = type.types.filter(member => member.kind === 'primitive' || member.kind === 'literal')
      const [primitive] = primitives
      if (primitives.length === 1 && primitive !== undefined) {
        const inner = scalarPlan(ctx, primitive)
        return 'reason' in inner ? inner : { plan: inner.plan, cast: true }
      }
      return { reason: 'only branded primitives (`string & { ... }`) can be coerced' }
    }
    case 'array':
      return { reason: 'nested arrays cannot be coerced' }
    default:
      return { reason: 'this type cannot be read from a request value' }
  }
}

function primitiveCoercion(name: string): ScalarCoercion | undefined {
  switch (name) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'bigint':
      return name
    default:
      return undefined
  }
}

function failure(ctx: Context, type: TypeInfo, reason: string): CoercionResult {
  return {
    ok: false,
    reason: `type '${ctx.types.format(type)}' cannot be coerced (${reason})`,
    hints: [
      'Supported types: string, number, boolean, bigint, Date, literal unions, enums, branded primitives and arrays of them',
      'Or validate the value with a Standard Schema',
    ],
  }
}

/** Member values of a TypeScript enum, `undefined` when `identity` is not an evaluable enum. */
function enumValues(ctx: Context, identity: string): EnumValue[] | undefined {
  const symbol = ctx.project.lookupIdentity(identity)
  if (symbol.kind !== 'declaration' || symbol.declaration.kind !== 'enum') {
    return undefined
  }
  const declaration = symbol.declaration
  const node = declaration.node as unknown
  const id = isNode(node) ? child(node, 'id') : undefined
  const file = ctx.project.getFile(declaration.file)
  if (!id || !file) {
    return undefined
  }
  const scope = { file, namespace: declaration.namespace } as unknown as ScopeInput
  const result = ctx.project.evaluate(scope, id as unknown as ExpressionInput, { refs: 'none' })
  if (result.kind !== 'value' || typeof result.value !== 'object' || result.value === null) {
    return undefined
  }
  return Object.values(result.value).filter(
    (value): value is string | number => typeof value === 'string' || typeof value === 'number',
  )
}

function inferFromDefault(
  ctx: Context,
  cls: ClassInfo,
  method: MethodInfo,
  param: ParameterInfo,
): TypeInfo | undefined {
  const node = defaultValueOf(cls, method, param)
  if (!node) {
    return undefined
  }
  const inner = unwrap(node)
  if (inner.type === 'NewExpression') {
    const callee = child(inner, 'callee')
    if (callee?.type === 'Identifier') {
      const resolved = ctx.project.resolveIdentifier(
        cls.file,
        callee as unknown as Parameters<Project['resolveIdentifier']>[1],
        'value',
      )
      return resolved.identity?.identity === DATE_IDENTITY ? DATE : undefined
    }
    return undefined
  }
  const result = ctx.project.evaluate(cls.file, node as unknown as ExpressionInput, { refs: 'none' })
  return result.kind === 'value' ? typeOfValue(result.value) : undefined
}

function typeOfValue(value: unknown): TypeInfo | undefined {
  switch (typeof value) {
    case 'string':
      return STRING
    case 'number':
      return NUMBER
    case 'boolean':
      return BOOLEAN
    case 'bigint':
      return BIGINT
    default: {
      if (!Array.isArray(value) || value.length === 0) {
        return undefined
      }
      const items = value.map(typeOfValue)
      const [first] = items
      if (first === undefined || first.kind !== 'primitive' || items.some(item => item !== first)) {
        return undefined
      }
      return { kind: 'array', element: first }
    }
  }
}

function hasNullish(type: TypeInfo): boolean {
  return type.kind === 'union' && type.types.some(isNullish)
}

/** Whether a union accepts `undefined` (`T | undefined`, `T | void`). */
export function acceptsUndefined(type: TypeInfo): boolean {
  return (
    type.kind === 'union' &&
    type.types.some(member => member.kind === 'primitive' && (member.name === 'undefined' || member.name === 'void'))
  )
}

function isNullish(type: TypeInfo): boolean {
  return type.kind === 'primitive' && (type.name === 'undefined' || type.name === 'null' || type.name === 'void')
}
