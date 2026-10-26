/**
 * Evaluation of decorator arguments (§4.6): `static` arguments MUST evaluate, `value` arguments are
 * evaluated when possible and otherwise MUST be references to exported bindings (also nested in
 * objects/arrays). Every failure is a ZNIGHT005 error with a fix-it.
 */
import type { Argument, Expression } from 'oxc-parser'
import type { ArgInfo, ArgKind } from '../extensions/api.ts'
import type { Diagnostic, Project, ScopeRef, StaticValue, ValueRef } from '../project/index.ts'

import { ErrorCode } from '@znight/core'

import { ValueRef as ValueRefClass } from '../project/index.ts'

/** Reports a diagnostic. */
export type Reporter = (diagnostic: Diagnostic) => void

/** Evaluates the arguments of a call expression according to their declared kinds. */
export function evaluateArguments(
  project: Project,
  scope: ScopeRef,
  args: readonly Argument[],
  kinds: { readonly params: readonly ArgKind[]; readonly rest?: ArgKind | undefined },
  decoratorName: string,
  report: Reporter,
): ArgInfo[] {
  const result: ArgInfo[] = []
  for (const argument of args) {
    const position = result.length
    const kind = position < kinds.params.length ? kinds.params[position] : kinds.rest
    if (argument.type === 'SpreadElement') {
      result.push(...evaluateSpread(project, scope, argument.argument, kind, decoratorName, position, report))
      continue
    }
    if (kind === undefined) {
      const maximum = kinds.params.length
      report({
        code: ErrorCode.InvalidDecorator,
        severity: 'error',
        message: `@${decoratorName} takes ${maximum === 0 ? 'no arguments' : `at most ${maximum} argument${maximum === 1 ? '' : 's'}`}`,
        location: scope.file.location(argument),
        hints: ['Remove the extra arguments'],
      })
      result.push(unevaluated(scope, argument, undefined, 'unexpected argument'))
      continue
    }
    result.push(
      evaluateArgument(project, scope, argument, kind, `argument ${position + 1} of @${decoratorName}`, report),
    )
  }
  return result
}

/** Evaluates one expression as a `static` or `value` argument. `what` names it in messages. */
export function evaluateArgument(
  project: Project,
  scope: ScopeRef,
  expression: Expression,
  kind: ArgKind,
  what: string,
  report: Reporter | undefined,
): ArgInfo {
  const location = scope.file.location(expression)
  const text = scope.file.textOf(expression)
  const evaluation = project.evaluate(scope, expression, { refs: kind === 'static' ? 'none' : 'nested' })
  switch (evaluation.kind) {
    case 'value': {
      const invalid = kind === 'value' ? firstUnexportedRef(project, evaluation.value, what, report) : undefined
      return invalid === undefined
        ? { kind, evaluated: true, value: evaluation.value, location, text, node: expression }
        : { kind, evaluated: false, error: invalid, location, text, node: expression }
    }
    case 'ref': {
      const invalid = checkRef(project, evaluation.ref, what, report)
      return invalid === undefined
        ? { kind, evaluated: false, ref: evaluation.ref, location, text, node: expression }
        : { kind, evaluated: false, error: invalid, location, text, node: expression }
    }
    case 'error': {
      const { error } = evaluation
      const message =
        kind === 'static'
          ? `Invalid ${what}: it must be statically evaluable (${error.message})`
          : `Invalid ${what}: ${error.message}`
      report?.({
        code: ErrorCode.InvalidDecorator,
        severity: 'error',
        message,
        location: error.location,
        hints: [
          error.hint ??
            (kind === 'static'
              ? 'Use a literal, or a `const` initialized with a statically evaluable expression'
              : 'Extract the value to `export const X = ...` and reference it'),
        ],
      })
      return { kind, evaluated: false, error: error.message, location, text, node: expression }
    }
  }
}

function evaluateSpread(
  project: Project,
  scope: ScopeRef,
  expression: Expression,
  kind: ArgKind | undefined,
  decoratorName: string,
  position: number,
  report: Reporter,
): ArgInfo[] {
  const evaluation = project.evaluate(scope, expression, { refs: kind === 'value' ? 'nested' : 'none' })
  const location = scope.file.location(expression)
  const text = scope.file.textOf(expression)
  if (evaluation.kind !== 'value' || !Array.isArray(evaluation.value)) {
    report({
      code: ErrorCode.InvalidDecorator,
      severity: 'error',
      message: `Invalid spread argument of @${decoratorName}: it must be a statically evaluable array`,
      location,
      hints: ['Pass the arguments explicitly, or spread an `export const X = [...] as const`'],
    })
    return [unevaluated(scope, expression, kind, 'invalid spread argument')]
  }
  return (evaluation.value as readonly StaticValue[]).map((value, index) => {
    const what = `argument ${position + index + 1} of @${decoratorName}`
    if (value instanceof ValueRefClass) {
      const invalid = checkRef(project, value, what, report)
      return invalid === undefined
        ? { kind, evaluated: false, ref: value, location, text, node: expression }
        : { kind, evaluated: false, error: invalid, location, text, node: expression }
    }
    return { kind, evaluated: true, value, location, text, node: expression }
  })
}

function unevaluated(
  scope: ScopeRef,
  expression: Expression,
  kind: ArgKind | undefined,
  error: string | undefined,
): ArgInfo {
  return {
    kind,
    evaluated: false,
    ...(error === undefined ? {} : { error }),
    location: scope.file.location(expression),
    text: scope.file.textOf(expression),
    node: expression,
  }
}

/** An argument of a decorator that is not evaluated (decorators owned by nobody). */
export function rawArgument(scope: ScopeRef, argument: Argument): ArgInfo {
  const expression = argument.type === 'SpreadElement' ? argument.argument : argument
  return {
    kind: undefined,
    evaluated: false,
    location: scope.file.location(argument),
    text: scope.file.textOf(argument),
    node: expression,
  }
}

/** Checks that a reference can be imported by the generated module; returns the error message otherwise. */
function checkRef(project: Project, ref: ValueRef, what: string, report: Reporter | undefined): string | undefined {
  const route = project.importRoute(ref.symbol)
  if (route.ok) {
    return undefined
  }
  const message = `Invalid ${what}: '${ref.text}' cannot be imported by the generated module (${route.error.message})`
  report?.({
    code: ErrorCode.InvalidDecorator,
    severity: 'error',
    message,
    location: ref.location,
    hints: route.error.hints.length > 0 ? route.error.hints : ['Export it from its module'],
  })
  return message
}

function firstUnexportedRef(
  project: Project,
  value: StaticValue,
  what: string,
  report: Reporter | undefined,
): string | undefined {
  let first: string | undefined
  const visit = (current: StaticValue): void => {
    if (current instanceof ValueRefClass) {
      const invalid = checkRef(project, current, what, report)
      first ??= invalid
      return
    }
    if (Array.isArray(current)) {
      for (const item of current) {
        visit(item)
      }
    } else if (typeof current === 'object' && current !== null) {
      for (const item of Object.values(current)) {
        visit(item)
      }
    }
  }
  visit(value)
  return first
}
