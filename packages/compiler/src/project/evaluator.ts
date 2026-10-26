/**
 * Static evaluator (§4.6).
 *
 * Accepted grammar: literals (strings, numbers, booleans, `null`, bigints, `undefined`, `NaN`,
 * `Infinity`), unary `-` `+` `!` `~` `void`, binary arithmetic (`+ - * / % **`), bitwise and shift
 * operators, comparisons, string concatenation, `??` `||` `&&`, `a ? b : c`, template literals,
 * property/element access (also optional chaining) on evaluated objects, arrays and strings, array
 * and object literals with spreads and computed keys, `as`, `as const`, `satisfies`, `<T>x`, `x!`,
 * parentheses, and references to `const` bindings and enums across files and packages
 * (cycle-guarded). In declaration files, `declare const X: <literal type>` is evaluated from its
 * type (`'a'`, `3`, `readonly ['a', 'b']`, `{ readonly a: 1 }`) so sources and `.d.ts` agree.
 *
 * A reference to a binding that cannot be evaluated (class, function, `let`, a `const` initialized
 * with a call...) yields a {@link ValueRef} instead of a value: at the top level of the expression
 * (default), also nested inside array/object literals (`refs: 'nested'`), or never (`refs: 'none'`,
 * for arguments that must be static).
 */
import type {
  ArrayExpression,
  PropertyKey as AstPropertyKey,
  Expression,
  ObjectExpression,
  TemplateLiteral,
  TSEnumDeclaration,
  TSEnumMemberName,
  TSType,
  VariableDeclarator,
} from 'oxc-parser'
import type { Declaration } from './facts.ts'
import type { ProjectHost } from './host.ts'
import type { IdentityResolver } from './identity.ts'
import type { Location, Span } from './location.ts'
import type { SourceFile } from './source-file.ts'
import type { StaticObject, StaticValue } from './static-value.ts'
import type { ScopeRef, SymbolResolution, SymbolResolver } from './symbols.ts'

import { applyBinary, applyUnary } from './operators.ts'
import { describeValue, ValueRef } from './static-value.ts'
import { declarationKey } from './symbols.ts'

/** Where references to non-evaluable bindings are accepted. */
export type RefMode = 'top' | 'nested' | 'none'

/** Options of {@link Evaluator.evaluate}. */
export interface EvaluateOptions {
  /** Default `'top'`. */
  readonly refs?: RefMode
}

/** Why an expression could not be evaluated. */
export interface EvaluationError {
  readonly message: string
  readonly location: Location
  readonly hint: string | undefined
}

/** Result of {@link Evaluator.evaluate}. `files` lists every file read (sorted), for invalidation. */
export type EvaluationResult =
  | { readonly kind: 'value'; readonly value: StaticValue; readonly files: readonly string[] }
  | { readonly kind: 'ref'; readonly ref: ValueRef; readonly files: readonly string[] }
  | { readonly kind: 'error'; readonly error: EvaluationError; readonly files: readonly string[] }

const EXTRACT_HINT = 'Extract the value to `export const X = ...` with a statically evaluable initializer'

class EvaluationFailure extends Error {
  readonly file: SourceFile
  readonly span: Span
  readonly hint: string | undefined
  readonly cycle: boolean

  constructor(message: string, file: SourceFile, span: Span, hint?: string, cycle = false) {
    super(message)
    this.file = file
    this.span = span
    this.hint = hint
    this.cycle = cycle
  }
}

/** Thrown when a reference to a non-evaluable binding is met. */
class RefSignal extends Error {
  readonly ref: ValueRef

  constructor(ref: ValueRef) {
    super(`'${ref.text}' is not statically evaluable`)
    this.ref = ref
  }
}

/** Thrown by `a?.b` when `a` is nullish: short-circuits the whole chain. */
class ShortCircuit extends Error {}

interface Context {
  readonly files: Set<string>
  readonly stack: Set<string>
  readonly refs: RefMode
  /** Names bound locally (enum members while evaluating an enum). */
  readonly locals: ReadonlyMap<string, StaticValue> | undefined
}

type Memo =
  | { readonly evaluable: true; readonly value: StaticValue; readonly files: readonly string[] }
  | {
      readonly evaluable: false
      readonly files: readonly string[]
    }

/** Static evaluator; memoizes binding values for the lifetime of the instance (one compile). */
export class Evaluator {
  readonly #host: ProjectHost
  readonly #symbols: SymbolResolver
  readonly #identities: IdentityResolver
  readonly #memo = new Map<string, Memo>()

  constructor(host: ProjectHost, symbols: SymbolResolver, identities: IdentityResolver) {
    this.#host = host
    this.#symbols = symbols
    this.#identities = identities
  }

  /** Evaluates an expression appearing in `scope`. */
  evaluate(scope: ScopeRef, expression: Expression, options: EvaluateOptions = {}): EvaluationResult {
    const context: Context = {
      files: new Set([scope.file.path]),
      stack: new Set(),
      refs: options.refs ?? 'top',
      locals: undefined,
    }
    const files = (): readonly string[] => [...context.files].sort()
    try {
      return { kind: 'value', value: this.#eval(scope, expression, context), files: files() }
    } catch (error) {
      if (error instanceof RefSignal) {
        if (context.refs === 'none') {
          return {
            kind: 'error',
            error: {
              message: `'${error.ref.text}' is not statically evaluable`,
              location: error.ref.location,
              hint: 'Use a literal, or a `const` initialized with a statically evaluable expression',
            },
            files: files(),
          }
        }
        return { kind: 'ref', ref: error.ref, files: files() }
      }
      if (error instanceof ShortCircuit) {
        return { kind: 'value', value: undefined, files: files() }
      }
      if (error instanceof EvaluationFailure) {
        return {
          kind: 'error',
          error: { message: error.message, location: error.file.location(error.span), hint: error.hint },
          files: files(),
        }
      }
      throw error
    }
  }

  #eval(scope: ScopeRef, node: Expression, context: Context): StaticValue {
    switch (node.type) {
      case 'Literal':
        return this.#literal(scope, node)
      case 'TemplateLiteral':
        return this.#template(scope, node, context)
      case 'Identifier':
        return this.#identifier(scope, node, context)
      case 'ParenthesizedExpression':
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSTypeAssertion':
      case 'TSNonNullExpression':
        return this.#eval(scope, node.expression, context)
      case 'UnaryExpression':
        return this.#unary(scope, node, context)
      case 'BinaryExpression': {
        if (node.left.type === 'PrivateIdentifier') {
          return this.#fail(scope, node, 'Private names are not statically evaluable')
        }
        const left = this.#strict(scope, node.left, context)
        const right = this.#strict(scope, node.right, context)
        const result = applyBinary(node.operator, left, right)
        return result.ok ? result.value : this.#fail(scope, node, result.message)
      }
      case 'LogicalExpression': {
        const left = this.#strict(scope, node.left, context)
        switch (node.operator) {
          case '??':
            return left ?? this.#strict(scope, node.right, context)
          case '||':
            return left || this.#strict(scope, node.right, context)
          default:
            return left && this.#strict(scope, node.right, context)
        }
      }
      case 'ConditionalExpression':
        return this.#strict(scope, node.test, context)
          ? this.#eval(scope, node.consequent, context)
          : this.#eval(scope, node.alternate, context)
      case 'MemberExpression':
        return this.#member(scope, node, context)
      case 'ChainExpression':
        try {
          return this.#eval(scope, node.expression, context)
        } catch (error) {
          if (error instanceof ShortCircuit) {
            return undefined
          }
          throw error
        }
      case 'ArrayExpression':
        return this.#array(scope, node, context)
      case 'ObjectExpression':
        return this.#object(scope, node, context)
      default:
        return this.#fail(scope, node, `${describe(node.type)} is not statically evaluable`, EXTRACT_HINT)
    }
  }

  /** Evaluates an operand that must be a value (a reference to a non-evaluable binding is an error). */
  #strict(scope: ScopeRef, node: Expression, context: Context): StaticValue {
    try {
      return this.#eval(scope, node, context)
    } catch (error) {
      if (error instanceof RefSignal) {
        throw new EvaluationFailure(
          `'${error.ref.text}' is not statically evaluable`,
          scope.file,
          { start: node.start, end: node.end },
          EXTRACT_HINT,
        )
      }
      throw error
    }
  }

  /** Evaluates an array element / property value, keeping references when `refs: 'nested'`. */
  #element(scope: ScopeRef, node: Expression, context: Context): StaticValue {
    if (context.refs !== 'nested') {
      return this.#strict(scope, node, context)
    }
    try {
      return this.#eval(scope, node, context)
    } catch (error) {
      if (error instanceof RefSignal) {
        return error.ref
      }
      throw error
    }
  }

  #literal(scope: ScopeRef, node: Extract<Expression, { type: 'Literal' }>): StaticValue {
    if ('regex' in node && node.regex) {
      return this.#fail(scope, node, 'Regular expressions are not statically evaluable', EXTRACT_HINT)
    }
    if ('bigint' in node && typeof node.bigint === 'string') {
      return BigInt(node.bigint)
    }
    const value = node.value
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
      return value
    }
    return this.#fail(scope, node, 'Unsupported literal')
  }

  #template(scope: ScopeRef, node: TemplateLiteral, context: Context): StaticValue {
    let result = ''
    for (const [index, quasi] of node.quasis.entries()) {
      if (quasi.value.cooked === null) {
        return this.#fail(scope, quasi, 'Invalid escape sequence in template literal')
      }
      result += quasi.value.cooked
      const expression = node.expressions[index]
      if (expression) {
        const value = this.#strict(scope, expression, context)
        if (typeof value === 'object' && value !== null) {
          return this.#fail(scope, expression, 'Only primitive values can be interpolated in a static template literal')
        }
        result += String(value)
      }
    }
    return result
  }

  #identifier(scope: ScopeRef, node: Extract<Expression, { type: 'Identifier' }>, context: Context): StaticValue {
    const local = context.locals?.get(node.name)
    if (local !== undefined || context.locals?.has(node.name)) {
      return local
    }
    const symbol = this.#symbols.resolveInScope(scope, node.name, 'value', context.files)
    if (symbol.kind === 'global') {
      switch (node.name) {
        case 'undefined':
          return undefined
        case 'NaN':
          return Number.NaN
        case 'Infinity':
          return Number.POSITIVE_INFINITY
        default:
          return this.#fail(scope, node, `'${node.name}' is not declared or imported in this file`)
      }
    }
    return this.#symbolValue(symbol, scope, node, context)
  }

  #symbolValue(symbol: SymbolResolution, scope: ScopeRef, use: Span, context: Context): StaticValue {
    switch (symbol.kind) {
      case 'declaration': {
        const declaration = symbol.declaration
        switch (declaration.kind) {
          case 'const':
          case 'enum':
            return this.#declarationValue(declaration, symbol, scope, use, context)
          case 'interface':
          case 'type':
            return this.#fail(scope, use, `'${declaration.name}' is a type and cannot be used as a value`)
          default:
            throw this.#ref(symbol, scope, use)
        }
      }
      case 'expression':
        return this.#defaultExpressionValue(symbol, scope, use, context)
      case 'external':
        throw this.#ref(symbol, scope, use)
      case 'module':
        return this.#fail(scope, use, 'A namespace import cannot be evaluated as a whole, access one of its exports')
      case 'global':
        return this.#fail(scope, use, `'${symbol.name}' is not statically evaluable`)
      case 'unresolved':
        return this.#fail(scope, use, symbol.message)
    }
  }

  #ref(symbol: SymbolResolution, scope: ScopeRef, use: Span): RefSignal {
    const info = this.#identities.identityOf(symbol)
    const text = scope.file.textOf(use)
    return new RefSignal(
      new ValueRef(info?.identity, info?.displayName ?? text, text, symbol, scope.file.location(use)),
    )
  }

  #declarationValue(
    declaration: Declaration,
    symbol: SymbolResolution,
    scope: ScopeRef,
    use: Span,
    context: Context,
  ): StaticValue {
    return this.#memoized(declarationKey(declaration), declaration.name, symbol, scope, use, context, inner => {
      const file = this.#host.getFile(declaration.file)
      if (!file) {
        throw new EvaluationFailure(`Cannot read ${declaration.file}`, scope.file, use)
      }
      const declarationScope: ScopeRef = { file, namespace: declaration.namespace }
      if (declaration.kind === 'enum') {
        return this.#enum(declarationScope, declaration, inner)
      }
      const declarator = declaration.node as VariableDeclarator
      if (declaration.destructured) {
        throw new EvaluationFailure(`'${declaration.name}' is bound by a destructuring pattern`, file, declaration.span)
      }
      if (declarator.init) {
        return this.#eval(declarationScope, declarator.init, inner)
      }
      const annotation = declarator.id.typeAnnotation?.typeAnnotation
      if (annotation) {
        return this.#valueFromType(file, annotation)
      }
      throw new EvaluationFailure(`'${declaration.name}' has no initializer`, file, declaration.span)
    })
  }

  #defaultExpressionValue(
    symbol: Extract<SymbolResolution, { kind: 'expression' }>,
    scope: ScopeRef,
    use: Span,
    context: Context,
  ): StaticValue {
    return this.#memoized(`${symbol.file}#default`, 'default', symbol, scope, use, context, inner => {
      const file = this.#host.getFile(symbol.file)
      if (!file) {
        throw new EvaluationFailure(`Cannot read ${symbol.file}`, scope.file, use)
      }
      return this.#eval({ file }, symbol.expression, inner)
    })
  }

  /**
   * Evaluates a binding once per compile. Bindings that cannot be evaluated become references at
   * the use site; circular references are errors (and are not memoized).
   */
  #memoized(
    key: string,
    name: string,
    symbol: SymbolResolution,
    scope: ScopeRef,
    use: Span,
    context: Context,
    compute: (context: Context) => StaticValue,
  ): StaticValue {
    const memo = this.#memo.get(key)
    if (memo) {
      for (const file of memo.files) {
        context.files.add(file)
      }
      if (memo.evaluable) {
        return memo.value
      }
      throw this.#ref(symbol, scope, use)
    }
    if (context.stack.has(key)) {
      throw new EvaluationFailure(`Circular reference while evaluating '${name}'`, scope.file, use, undefined, true)
    }
    const inner: Context = { files: new Set(), stack: context.stack, refs: 'none', locals: undefined }
    context.stack.add(key)
    try {
      const value = compute(inner)
      this.#memo.set(key, { evaluable: true, value, files: [...inner.files] })
      return value
    } catch (error) {
      if ((error instanceof EvaluationFailure && !error.cycle) || error instanceof RefSignal) {
        this.#memo.set(key, { evaluable: false, files: [...inner.files] })
        throw this.#ref(symbol, scope, use)
      }
      throw error
    } finally {
      context.stack.delete(key)
      for (const file of inner.files) {
        context.files.add(file)
      }
    }
  }

  #enum(scope: ScopeRef, declaration: Declaration, context: Context): StaticValue {
    const node = declaration.node as TSEnumDeclaration
    const members: Record<string, StaticValue> = {}
    const locals = new Map<string, StaticValue>([[declaration.localName, members]])
    const inner: Context = { ...context, locals }
    let next: number | undefined = 0
    for (const member of node.body.members) {
      const name = enumMemberName(member.id)
      let value: StaticValue
      if (member.initializer) {
        value = this.#strict(scope, member.initializer, inner)
        if (typeof value !== 'number' && typeof value !== 'string') {
          throw new EvaluationFailure(`Enum member '${name}' must be a number or a string`, scope.file, member)
        }
      } else if (next === undefined) {
        throw new EvaluationFailure(`Enum member '${name}' must be initialized`, scope.file, member)
      } else {
        value = next
      }
      members[name] = value
      locals.set(name, value)
      next = typeof value === 'number' ? value + 1 : undefined
    }
    return Object.freeze(members)
  }

  #unary(scope: ScopeRef, node: Extract<Expression, { type: 'UnaryExpression' }>, context: Context): StaticValue {
    // `void x` is `undefined` whatever `x` is; other operators need an evaluated operand.
    const operand = node.operator === 'void' ? undefined : this.#strict(scope, node.argument, context)
    const result = applyUnary(node.operator, operand)
    return result.ok ? result.value : this.#fail(scope, node, result.message)
  }

  #member(scope: ScopeRef, node: Extract<Expression, { type: 'MemberExpression' }>, context: Context): StaticValue {
    if (node.property.type === 'PrivateIdentifier') {
      return this.#fail(scope, node, 'Private fields are not statically evaluable')
    }
    if (!node.optional && isDottedChain(node)) {
      // Namespace imports, namespaces, packages, default imports: resolve the member symbolically.
      const symbol = this.#symbols.resolveEntity(scope, node, 'value', context.files)
      if (symbol.kind === 'declaration' || symbol.kind === 'expression' || symbol.kind === 'external') {
        return this.#symbolValue(symbol, scope, node, context)
      }
      if (
        symbol.kind === 'unresolved' &&
        symbol.reason !== 'not-a-namespace' &&
        symbol.reason !== 'unsupported-expression'
      ) {
        return this.#fail(scope, node, symbol.message)
      }
    }
    let object: StaticValue
    try {
      object = this.#eval(scope, node.object, context)
    } catch (error) {
      if (error instanceof RefSignal) {
        return this.#fail(
          scope,
          node,
          `Cannot statically read a property of '${error.ref.text}' (not statically evaluable)`,
          EXTRACT_HINT,
        )
      }
      throw error
    }
    if (object === null || object === undefined) {
      if (node.optional) {
        throw new ShortCircuit()
      }
      return this.#fail(scope, node, `Cannot read a property of ${String(object)}`)
    }
    let key: StaticValue
    if (node.computed) {
      key = this.#strict(scope, node.property, context)
      if (typeof key !== 'string' && typeof key !== 'number') {
        return this.#fail(
          scope,
          node.property,
          `A property key must be a string or a number, got ${describeValue(key)}`,
        )
      }
    } else {
      key = node.property.name
    }
    return this.#access(scope, node, object, String(key))
  }

  #access(scope: ScopeRef, node: Span, object: StaticValue, key: string): StaticValue {
    if (Array.isArray(object) || typeof object === 'string') {
      if (key === 'length') {
        return object.length
      }
      const index = Number(key)
      return Number.isInteger(index) && index >= 0 && String(index) === key ? object[index] : undefined
    }
    if (object instanceof ValueRef) {
      return this.#fail(scope, node, `Cannot statically read a property of '${object.text}'`, EXTRACT_HINT)
    }
    if (typeof object === 'object' && object !== null) {
      return Object.hasOwn(object, key) ? (object as StaticObject)[key] : undefined
    }
    return this.#fail(scope, node, `Cannot statically read property '${key}' of ${describeValue(object)}`)
  }

  #array(scope: ScopeRef, node: ArrayExpression, context: Context): StaticValue {
    const values: StaticValue[] = []
    for (const element of node.elements) {
      if (element === null) {
        return this.#fail(scope, node, 'Array holes are not statically evaluable')
      }
      if (element.type === 'SpreadElement') {
        const spread = this.#strict(scope, element.argument, context)
        if (Array.isArray(spread)) {
          values.push(...spread)
        } else if (typeof spread === 'string') {
          values.push(...spread)
        } else {
          return this.#fail(scope, element, `Cannot spread ${describeValue(spread)} into an array`)
        }
      } else {
        values.push(this.#element(scope, element, context))
      }
    }
    return Object.freeze(values)
  }

  #object(scope: ScopeRef, node: ObjectExpression, context: Context): StaticValue {
    const result: Record<string, StaticValue> = {}
    for (const property of node.properties) {
      if (property.type === 'SpreadElement') {
        const spread = this.#strict(scope, property.argument, context)
        if (spread === null || spread === undefined) {
          continue
        }
        if (typeof spread !== 'object' || Array.isArray(spread) || spread instanceof ValueRef) {
          return this.#fail(scope, property, `Cannot spread ${describeValue(spread)} into an object`)
        }
        for (const [key, value] of Object.entries(spread)) {
          define(result, key, value)
        }
        continue
      }
      if (property.kind !== 'init' || property.method) {
        return this.#fail(scope, property, 'Methods and accessors are not statically evaluable')
      }
      let key: string
      if (property.computed) {
        const computed = this.#strict(scope, property.key as Expression, context)
        if (typeof computed !== 'string' && typeof computed !== 'number') {
          return this.#fail(
            scope,
            property.key,
            `A property key must be a string or a number, got ${describeValue(computed)}`,
          )
        }
        key = String(computed)
      } else if (property.key.type === 'Identifier') {
        key = property.key.name
      } else if (property.key.type === 'Literal') {
        key = String(property.key.value)
      } else {
        return this.#fail(scope, property.key, 'Unsupported property key')
      }
      if (key === '__proto__') {
        return this.#fail(scope, property.key, "The '__proto__' key is not supported")
      }
      define(result, key, this.#element(scope, property.value, context))
    }
    return Object.freeze(result)
  }

  /** Value of an ambient `declare const X: <type>` from its literal type. */
  #valueFromType(file: SourceFile, node: TSType): StaticValue {
    switch (node.type) {
      case 'TSLiteralType': {
        const literal = node.literal
        if (literal.type === 'Literal') {
          if ('bigint' in literal && typeof literal.bigint === 'string') {
            return BigInt(literal.bigint)
          }
          if (
            typeof literal.value === 'string' ||
            typeof literal.value === 'number' ||
            typeof literal.value === 'boolean'
          ) {
            return literal.value
          }
        } else if (
          literal.type === 'UnaryExpression' &&
          literal.operator === '-' &&
          literal.argument.type === 'Literal'
        ) {
          const argument = literal.argument
          if ('bigint' in argument && typeof argument.bigint === 'string') {
            return -BigInt(argument.bigint)
          }
          if (typeof argument.value === 'number') {
            return -argument.value
          }
        } else if (literal.type === 'TemplateLiteral' && literal.expressions.length === 0) {
          return literal.quasis[0]?.value.cooked ?? ''
        }
        break
      }
      case 'TSTemplateLiteralType':
        if (node.types.length === 0) {
          return node.quasis[0]?.value.cooked ?? ''
        }
        break
      case 'TSUndefinedKeyword':
        return undefined
      case 'TSNullKeyword':
        return null
      case 'TSParenthesizedType':
        return this.#valueFromType(file, node.typeAnnotation)
      case 'TSTypeOperator':
        if (node.operator === 'readonly') {
          return this.#valueFromType(file, node.typeAnnotation)
        }
        break
      case 'TSTupleType': {
        const values: StaticValue[] = []
        for (const element of node.elementTypes) {
          if (
            element.type === 'TSOptionalType' ||
            element.type === 'TSRestType' ||
            element.type === 'TSNamedTupleMember'
          ) {
            throw new EvaluationFailure('Only tuples of literal types are statically evaluable', file, element)
          }
          values.push(this.#valueFromType(file, element))
        }
        return Object.freeze(values)
      }
      case 'TSTypeLiteral': {
        const result: Record<string, StaticValue> = {}
        for (const member of node.members) {
          if (member.type !== 'TSPropertySignature' || member.computed || member.optional || !member.typeAnnotation) {
            throw new EvaluationFailure(
              'Only object types with literal properties are statically evaluable',
              file,
              member,
            )
          }
          const key = member.key
          const name = propertyKeyName(key)
          if (name === undefined || name === '__proto__') {
            throw new EvaluationFailure('Unsupported property key', file, key)
          }
          define(result, name, this.#valueFromType(file, member.typeAnnotation.typeAnnotation))
        }
        return Object.freeze(result)
      }
      default:
        break
    }
    throw new EvaluationFailure('The declared type is not a literal type', file, node)
  }

  #fail(scope: ScopeRef, span: Span, message: string, hint?: string): never {
    throw new EvaluationFailure(message, scope.file, { start: span.start, end: span.end }, hint)
  }
}

function enumMemberName(id: TSEnumMemberName): string {
  if (id.type === 'Identifier') {
    return id.name
  }
  if (id.type === 'Literal') {
    return String(id.value)
  }
  return id.quasis[0]?.value.cooked ?? ''
}

function propertyKeyName(key: AstPropertyKey): string | undefined {
  if (key.type === 'Identifier') {
    return key.name
  }
  return key.type === 'Literal' ? String(key.value) : undefined
}

function define(target: Record<string, StaticValue>, key: string, value: StaticValue): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

function isDottedChain(node: Expression): boolean {
  switch (node.type) {
    case 'Identifier':
      return true
    case 'MemberExpression':
      return (
        !node.optional &&
        (node.computed
          ? node.property.type === 'Literal' && typeof node.property.value === 'string'
          : node.property.type === 'Identifier') &&
        isDottedChain(node.object)
      )
    default:
      return false
  }
}

const NODE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  CallExpression: 'A function call',
  NewExpression: 'A `new` expression',
  ArrowFunctionExpression: 'A function',
  FunctionExpression: 'A function',
  ClassExpression: 'A class expression',
  AwaitExpression: 'An `await` expression',
  AssignmentExpression: 'An assignment',
  UpdateExpression: 'An update expression',
  SequenceExpression: 'A comma expression',
  TaggedTemplateExpression: 'A tagged template',
  ThisExpression: '`this`',
  ImportExpression: 'A dynamic import',
  MetaProperty: '`import.meta`',
}

function describe(type: string): string {
  return NODE_DESCRIPTIONS[type] ?? `A ${type}`
}
