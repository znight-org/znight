import type { EvaluateOptions, EvaluationResult, StaticValue } from '../../src/project/index.ts'

import { normalizeOptions } from '../../src/options.ts'
import { containsRef, Project, ValueRef } from '../../src/project/index.ts'
import { APP, appProject, fileOf, initializerOf, tempDir } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

const project = appProject({ conditions: ['@znight/source'] })
const cases = fileOf(project, 'src/eval-cases.ts')

function evaluate(name: string, options?: EvaluateOptions): EvaluationResult {
  return project.evaluate(cases, initializerOf(cases, name), options)
}

function evaluated(name: string): StaticValue {
  const result = evaluate(name)
  if (result.kind !== 'value') {
    throw new Error(
      `${name}: expected a value, got ${result.kind === 'error' ? result.error.message : `ref ${result.ref.identity}`}`,
    )
  }
  return result.value
}

function refOf(name: string): ValueRef {
  const result = evaluate(name)
  if (result.kind !== 'ref') {
    throw new Error(`${name}: expected a reference, got ${result.kind}`)
  }
  return result.ref
}

function errorOf(
  name: string,
  options?: EvaluateOptions,
): { message: string; line: number; column: number; hint: string | undefined } {
  const result = evaluate(name, options)
  if (result.kind !== 'error') {
    throw new Error(`${name}: expected an error, got ${result.kind}`)
  }
  const { message, location, hint } = result.error
  return { message, line: location.line, column: location.column, hint }
}

describe('static evaluation: values', () => {
  it('literals and unary operators', () => {
    expect(evaluated('literals')).toEqual([
      1,
      'a',
      true,
      null,
      undefined,
      10n,
      -5,
      3,
      true,
      -2,
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ])
  })

  it('arithmetic with constants', () => {
    expect(evaluated('arithmetic')).toEqual({ add: 3, sub: 2, mul: 6, div: 3.5, mod: 1, pow: 1024, neg: -3000 })
  })

  it('bitwise, shifts, bigints and comparisons', () => {
    expect(evaluated('bitwise')).toEqual([16, -4, 15, 2, 7, 5, 2n ** 64n])
    expect(evaluated('comparisons')).toEqual([true, false, true, true, true, true])
  })

  it('string concatenation and template literals', () => {
    expect(evaluated('strings')).toBe('a1truenull')
    expect(evaluated('template')).toBe('3000-debug-10')
  })

  it('logical operators short-circuit (the unused side may be non-evaluable)', () => {
    expect(evaluated('logical')).toEqual({ nullish: 'x', or: 'y', and: 'z', short: false })
    expect(evaluated('conditional')).toBe('big')
  })

  it('property and element access on evaluated values, namespaces and default imports', () => {
    expect(evaluated('access')).toEqual(['/api/users', '/api/admin', 'user', 2, 'b', 8080, undefined])
    expect(evaluated('optional')).toBeUndefined()
  })

  it('enums (auto-increment, explicit values, strings, through namespace imports)', () => {
    expect(evaluated('enums')).toEqual([0, 5, 6, 'info', 6])
  })

  it('spreads and computed keys', () => {
    expect(evaluated('spreads')).toEqual({
      users: '/api/users',
      admin: { root: '/api/admin' },
      list: ['admin', 'user', 'x'],
      chars: ['a', 'b'],
    })
    expect(evaluated('computedKey')).toEqual({ debug: 1, k1: 2, 3: 'three', 'quoted-key': 4 })
  })

  it('constants of packages (sources)', () => {
    expect(evaluated('packageConsts')).toEqual([3000, 'admin', 'token-a'])
  })

  it('type wrappers are transparent', () => {
    expect(evaluated('wrappers')).toEqual([3000, 3000, 3000, { a: 1 }])
  })

  it('evaluated arrays and objects are frozen', () => {
    const value = evaluated('spreads') as { list: string[] }
    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.isFrozen(value.list)).toBe(true)
  })

  it('records every file read by the evaluation', () => {
    const result = evaluate('access')
    expect(result.files).toEqual([
      `${APP}/src/config/constants.ts`,
      `${APP}/src/defaults/expr.ts`,
      `${APP}/src/eval-cases.ts`,
    ])
    expect(evaluate('packageConsts').files).toEqual([
      `${APP}/node_modules/@fixture/lib/src/constants.ts`,
      `${APP}/node_modules/@fixture/lib/src/index.ts`,
      `${APP}/node_modules/@fixture/lib/src/tokens.ts`,
      `${APP}/src/eval-cases.ts`,
    ])
  })
})

describe('static evaluation: references', () => {
  it.each([
    ['classRef', 'src/config/constants.ts#Guard', 'Guard'],
    ['functionRef', 'src/config/constants.ts#helper', 'helper'],
    ['letRef', 'src/config/constants.ts#mutable', 'mutable'],
    ['callRef', 'src/config/constants.ts#computed', 'computed'],
    ['listRef', 'src/config/constants.ts#LIST', 'LIST'],
    ['namespaceRef', 'src/config/constants.ts#Guard', 'C.Guard'],
    ['packageClassRef', '@fixture/lib#Logger', 'Logger'],
    ['builtinRef', 'node:events#EventEmitter', 'EventEmitter'],
    ['untypedRef', 'cjs-only#Thing', 'cjs.Thing'],
  ])('%s → ref %s', (name, identity, text) => {
    const ref = refOf(name)
    expect(ref).toBeInstanceOf(ValueRef)
    expect(ref.identity).toBe(identity)
    expect(ref.text).toBe(text)
    expect(ref.location.file).toBe(cases.path)
    expect(project.importRoute(ref.symbol).ok).toBe(true)
  })

  it('refs: "nested" keeps references inside literals', () => {
    const result = evaluate('nestedRefs', { refs: 'nested' })
    expect(result.kind).toBe('value')
    const value = result.kind === 'value' ? (result.value as Record<string, StaticValue>) : {}
    expect(value.guard).toBeInstanceOf(ValueRef)
    expect((value.list as StaticValue[])[0]).toMatchObject({ identity: '@fixture/lib#Logger' })
    expect(value.value).toBe(3000)
    expect(containsRef(result.kind === 'value' ? result.value : null)).toBe(true)
    expect(containsRef({ a: [1, { b: 'x' }] })).toBe(false)
  })

  it('by default, nested references are errors', () => {
    expect(errorOf('nestedRefs')).toMatchObject({
      message: "'Guard' is not statically evaluable",
      line: 33,
      column: 36,
    })
  })

  it('refs: "none" turns top-level references into errors', () => {
    expect(errorOf('classRef', { refs: 'none' })).toMatchObject({
      message: "'Guard' is not statically evaluable",
      hint: 'Use a literal, or a `const` initialized with a statically evaluable expression',
    })
  })
})

describe('static evaluation: errors', () => {
  const hint = 'Extract the value to `export const X = ...` with a statically evaluable initializer'

  it.each([
    ['call', 'A function call is not statically evaluable', hint],
    ['arrow', 'A function is not statically evaluable', hint],
    ['unknownName', "'notDeclared' is not declared or imported in this file", undefined],
    ['typeAsValue', "'User' is a type and cannot be used as a value", undefined],
    ['propertyOfRef', "Cannot statically read a property of 'Guard' (not statically evaluable)", hint],
    ['badBinary', "Operator '+' cannot be applied to number and bigint", undefined],
    ['regexp', 'Regular expressions are not statically evaluable', hint],
    ['hole', 'Array holes are not statically evaluable', undefined],
    ['method', 'Methods and accessors are not statically evaluable', undefined],
    ['proto', "The '__proto__' key is not supported", undefined],
    ['cycle', "Circular reference while evaluating 'CYCLE_A'", undefined],
    ['missingExport', 'has no exported member', undefined],
    ['nullAccess', 'Cannot read a property of null', undefined],
    ['divisionByZero', 'Division by zero', undefined],
    ['wholeNamespace', 'A namespace import cannot be evaluated as a whole, access one of its exports', undefined],
  ])('%s: %s', (name, message, expectedHint) => {
    const error = errorOf(name)
    expect(error.message).toContain(message)
    expect(error.hint).toBe(expectedHint)
  })

  it('errors are located at the faulty node (1-based line/column)', () => {
    expect(errorOf('call')).toMatchObject({ line: 34, column: 21 })
    expect(errorOf('unknownName')).toMatchObject({ line: 36, column: 28 })
  })
})

describe('static evaluation of declaration files', () => {
  const dir = tempDir({
    'package.json': '{ "name": "decl-app" }',
    'src/consts.d.ts': [
      "export declare const STRING: 'a'",
      'export declare const NEGATIVE: -1',
      'export declare const BIG: 10n',
      "export declare const TUPLE: readonly ['x', 1, true]",
      "export declare const OBJECT: { readonly a: 1; readonly 'b-c': { readonly d: null } }",
      'export declare const UNDEFINED: undefined',
      'export declare const TEMPLATE: `t`',
      'export declare const INITIALIZED = 3e3',
      'export declare const WIDE: string',
      'export declare const OPTIONAL_TUPLE: [1?]',
      'export declare const METHOD: { m(): void }',
    ].join('\n'),
    'src/use.ts': [
      "import * as d from './consts.js'",
      'export const values = [d.STRING, d.NEGATIVE, d.BIG, d.TUPLE, d.OBJECT, d.UNDEFINED, d.TEMPLATE, d.INITIALIZED]',
      'export const wide = d.WIDE',
      'export const optionalTuple = d.OPTIONAL_TUPLE',
      'export const method = d.METHOD',
    ].join('\n'),
  })
  afterAll(() => dir.cleanup())
  const temp = new Project(normalizeOptions({ root: dir.root }))
  temp.refresh()
  const use = fileOf(temp, 'src/use.ts')

  it('`declare const X: <literal type>` evaluates from its type', () => {
    expect(temp.evaluate(use, initializerOf(use, 'values'))).toMatchObject({
      kind: 'value',
      value: ['a', -1, 10n, ['x', 1, true], { a: 1, 'b-c': { d: null } }, undefined, 't', 3000],
    })
  })

  it('declarations with non-literal types are references', () => {
    for (const name of ['wide', 'optionalTuple', 'method']) {
      expect(temp.evaluate(use, initializerOf(use, name)).kind).toBe('ref')
    }
  })
})
