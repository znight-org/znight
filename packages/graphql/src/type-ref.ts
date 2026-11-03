/**
 * GraphQL type references as written in `metadata.extensions.graphql` (`'Book!'`, `'[Book!]!'`,
 * `'[[Int]]'`): parsing and printing.
 *
 * Import-free: shared by the compiler extension (which prints them) and the runtime (which parses
 * them once, at boot, to build the schema). The grammar is the canonical form graphql-js prints
 * (`String(type)`): no whitespace, no comments, names matching `/^[_A-Za-z][_0-9A-Za-z]*$/`.
 */

/** A parsed type reference. */
export type GraphQLTypeRef = NamedTypeRef | ListTypeRef

/** A named type (`Book`, `Book!`). */
export interface NamedTypeRef {
  readonly kind: 'named'
  readonly name: string
  readonly nonNull: boolean
}

/** A list type (`[Book]`, `[Book!]!`). */
export interface ListTypeRef {
  readonly kind: 'list'
  /** The item type. */
  readonly of: GraphQLTypeRef
  readonly nonNull: boolean
}

/** Result of one parsing step: the reference and the index after it. */
interface Step {
  readonly ref: GraphQLTypeRef
  readonly end: number
}

/**
 * Parses a type reference. Returns `undefined` when `text` is not a canonical reference, so that
 * callers validating hand-written metadata can collect every problem before failing.
 */
export function parseTypeRef(text: string): GraphQLTypeRef | undefined {
  const step = parseAt(text, 0)
  return step !== undefined && step.end === text.length ? step.ref : undefined
}

/** Prints a type reference in its canonical form (the form graphql-js prints). */
export function printTypeRef(ref: GraphQLTypeRef): string {
  const inner = ref.kind === 'named' ? ref.name : `[${printTypeRef(ref.of)}]`
  return ref.nonNull ? `${inner}!` : inner
}

/** The innermost type name of a reference (`'[Book!]!'` → `'Book'`), `undefined` when malformed. */
export function namedTypeOf(ref: string | GraphQLTypeRef): string | undefined {
  let current = typeof ref === 'string' ? parseTypeRef(ref) : ref
  while (current !== undefined && current.kind === 'list') current = current.of
  return current?.name
}

const OPEN_BRACKET = 0x5b // [
const CLOSE_BRACKET = 0x5d // ]
const BANG = 0x21 // !

function parseAt(text: string, start: number): Step | undefined {
  let ref: GraphQLTypeRef
  let index: number
  if (text.charCodeAt(start) === OPEN_BRACKET) {
    const item = parseAt(text, start + 1)
    if (item === undefined || text.charCodeAt(item.end) !== CLOSE_BRACKET) return undefined
    index = item.end + 1
    ref = { kind: 'list', of: item.ref, nonNull: false }
  } else {
    index = start
    if (!isNameStart(text.charCodeAt(index))) return undefined
    index++
    while (isNameContinue(text.charCodeAt(index))) index++
    ref = { kind: 'named', name: text.slice(start, index), nonNull: false }
  }
  if (text.charCodeAt(index) === BANG) {
    return { ref: { ...ref, nonNull: true }, end: index + 1 }
  }
  return { ref, end: index }
}

/** `[_A-Za-z]`. `NaN` (past the end) is never a name character. */
function isNameStart(code: number): boolean {
  return code === 0x5f || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)
}

/** `[_0-9A-Za-z]`. */
function isNameContinue(code: number): boolean {
  return isNameStart(code) || (code >= 0x30 && code <= 0x39)
}
