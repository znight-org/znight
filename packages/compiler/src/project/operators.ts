/**
 * JavaScript operator semantics for the static evaluator, restricted to primitives. Mixing
 * `number` and `bigint` (a `TypeError` in JavaScript) and operations on objects/arrays are errors;
 * `+` with a string operand concatenates. Operations that throw in JavaScript (`2n ** -1n`, bigint
 * division by zero) and bigint results above {@link MAX_BIGINT_BITS} are errors too: never thrown.
 */
import type { StaticPrimitive, StaticValue } from './static-value.ts'

import { describeValue, isStaticPrimitive } from './static-value.ts'

/** Result of an operator application. */
export type OperationResult =
  | { readonly ok: true; readonly value: StaticValue }
  | { readonly ok: false; readonly message: string }

type NumberOperation = (a: number, b: number) => number
type BigIntOperation = (a: bigint, b: bigint) => bigint

/** Operators applying to two numbers or two bigints (`>>>` has no bigint form). */
const NUMERIC: Readonly<Record<string, readonly [NumberOperation, BigIntOperation | undefined]>> = {
  '+': [(a, b) => a + b, (a, b) => a + b],
  '-': [(a, b) => a - b, (a, b) => a - b],
  '*': [(a, b) => a * b, (a, b) => a * b],
  '/': [(a, b) => a / b, (a, b) => a / b],
  '%': [(a, b) => a % b, (a, b) => a % b],
  '**': [(a, b) => a ** b, (a, b) => a ** b],
  '<<': [(a, b) => a << b, (a, b) => a << b],
  '>>': [(a, b) => a >> b, (a, b) => a >> b],
  '>>>': [(a, b) => a >>> b, undefined],
  '&': [(a, b) => a & b, (a, b) => a & b],
  '|': [(a, b) => a | b, (a, b) => a | b],
  '^': [(a, b) => a ^ b, (a, b) => a ^ b],
}

/** Largest bigint result (in bits) the evaluator computes: `1n << 10n ** 12n` is an error, not an out-of-memory. */
const MAX_BIGINT_BITS = 1_000_000

const ok = (value: StaticValue): OperationResult => ({ ok: true, value })

/** Applies a unary operator (`!`, `-`, `+`, `~`, `void`). */
export function applyUnary(operator: string, value: StaticValue): OperationResult {
  switch (operator) {
    case 'void':
      return ok(undefined)
    case '!':
      return ok(!value)
    case '-':
      if (typeof value === 'number' || typeof value === 'bigint') {
        return ok(-value)
      }
      break
    case '+':
      if (typeof value === 'number') {
        return ok(value)
      }
      break
    case '~':
      if (typeof value === 'number' || typeof value === 'bigint') {
        return ok(~value)
      }
      break
    default:
      return { ok: false, message: `The '${operator}' operator is not statically evaluable` }
  }
  return { ok: false, message: `Operator '${operator}' cannot be applied to ${describeValue(value)}` }
}

/** Applies a binary operator to two evaluated operands. */
export function applyBinary(operator: string, left: StaticValue, right: StaticValue): OperationResult {
  const mismatch: OperationResult = {
    ok: false,
    message: `Operator '${operator}' cannot be applied to ${describeValue(left)} and ${describeValue(right)}`,
  }
  if (!isStaticPrimitive(left) || !isStaticPrimitive(right)) {
    return mismatch
  }
  if (operator === '+' && (typeof left === 'string' || typeof right === 'string')) {
    return ok(String(left) + String(right))
  }
  const numeric = NUMERIC[operator]
  if (numeric) {
    if (typeof left === 'number' && typeof right === 'number') {
      return ok(numeric[0](left, right))
    }
    if (typeof left === 'bigint' && typeof right === 'bigint' && numeric[1]) {
      if ((operator === '/' || operator === '%') && right === 0n) {
        return { ok: false, message: 'Division by zero' }
      }
      const tooLarge = bigintTooLarge(operator, left, right)
      if (tooLarge) {
        return { ok: false, message: tooLarge }
      }
      return attempt(numeric[1], left, right)
    }
    return mismatch
  }
  switch (operator) {
    case '===':
      return ok(left === right)
    case '!==':
      return ok(left !== right)
    case '==':
      // biome-ignore lint/suspicious/noDoubleEquals: evaluating JavaScript loose equality on primitives
      return ok(left == right)
    case '!=':
      // biome-ignore lint/suspicious/noDoubleEquals: evaluating JavaScript loose inequality on primitives
      return ok(left != right)
    case '<':
    case '>':
    case '<=':
    case '>=': {
      const result = compare(operator, left, right)
      return result === undefined ? mismatch : ok(result)
    }
    default:
      return { ok: false, message: `Operator '${operator}' is not statically evaluable` }
  }
}

/** Applies a bigint operation, turning what JavaScript throws (`RangeError`) into an error result. */
function attempt(operation: BigIntOperation, left: bigint, right: bigint): OperationResult {
  try {
    return ok(operation(left, right))
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** Why a bigint `**` / `<<` / `>>` result would exceed {@link MAX_BIGINT_BITS} (`undefined` when it does not). */
function bigintTooLarge(operator: string, left: bigint, right: bigint): string | undefined {
  let bits: bigint
  if (operator === '**') {
    if (right < 0n || left === 0n || left === 1n || left === -1n) {
      return undefined
    }
    bits = BigInt(bitLength(left)) * right
  } else if (operator === '<<' || operator === '>>') {
    const shift = operator === '<<' ? right : -right
    if (shift <= 0n || left === 0n) {
      return undefined
    }
    bits = BigInt(bitLength(left)) + shift
  } else {
    return undefined
  }
  return bits > BigInt(MAX_BIGINT_BITS)
    ? `The result of '${operator}' is too large to be evaluated statically (more than ${MAX_BIGINT_BITS} bits)`
    : undefined
}

function bitLength(value: bigint): number {
  return (value < 0n ? -value : value).toString(2).length
}

function compare(
  operator: '<' | '>' | '<=' | '>=',
  left: StaticPrimitive,
  right: StaticPrimitive,
): boolean | undefined {
  const numeric =
    (typeof left === 'number' || typeof left === 'bigint') && (typeof right === 'number' || typeof right === 'bigint')
  if (!numeric && !(typeof left === 'string' && typeof right === 'string')) {
    return undefined
  }
  const a = left as number | bigint | string
  const b = right as number | bigint | string
  switch (operator) {
    case '<':
      return a < b
    case '>':
      return a > b
    case '<=':
      return a <= b
    default:
      return a >= b
  }
}
