/**
 * Lexical helpers of the code generator: JavaScript identifiers, reserved names and the single
 * string quoting function used for every string literal of the generated module.
 *
 * Everything here is pure and independent of the host (no `globalThis` inspection), so the
 * generated module is byte-identical on every runtime and OS.
 */

const IDENTIFIER_NAME = /^[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*$/u
const ASCII_IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/**
 * Reserved words (ES2024 strict mode + module code), plus `arguments`/`eval` that cannot be bound
 * in strict mode, and the TypeScript type keywords that cannot name an imported type.
 */
export const RESERVED_WORDS: ReadonlySet<string> = new Set([
  'arguments',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'eval',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
])

/** TypeScript keywords that cannot be used as type names (`import type { string }` is invalid). */
const TYPE_KEYWORDS: ReadonlySet<string> = new Set([
  'any',
  'bigint',
  'boolean',
  'never',
  'number',
  'object',
  'string',
  'symbol',
  'undefined',
  'unknown',
])

/**
 * Global names the generated code (or extension `code` templates) may reference. Imported
 * bindings never shadow them: a user class named `Date` is imported as `Date$1`. The list is fixed
 * (not read from `globalThis`) so that the output does not depend on the runtime.
 */
export const RESERVED_GLOBALS: ReadonlySet<string> = new Set([
  'AbortController',
  'AbortSignal',
  'AggregateError',
  'Array',
  'ArrayBuffer',
  'Atomics',
  'BigInt',
  'BigInt64Array',
  'BigUint64Array',
  'Blob',
  'Boolean',
  'Buffer',
  'Bun',
  'DataView',
  'Date',
  'Deno',
  'Error',
  'EvalError',
  'FinalizationRegistry',
  'Float32Array',
  'Float64Array',
  'FormData',
  'Function',
  'Headers',
  'Infinity',
  'Int16Array',
  'Int32Array',
  'Int8Array',
  'Intl',
  'Iterator',
  'JSON',
  'Map',
  'Math',
  'NaN',
  'Number',
  'Object',
  'Promise',
  'Proxy',
  'RangeError',
  'ReadableStream',
  'ReferenceError',
  'Reflect',
  'RegExp',
  'Request',
  'Response',
  'Set',
  'SharedArrayBuffer',
  'String',
  'Symbol',
  'SyntaxError',
  'TextDecoder',
  'TextEncoder',
  'TypeError',
  'URIError',
  'URL',
  'URLSearchParams',
  'Uint16Array',
  'Uint32Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'WeakMap',
  'WeakRef',
  'WeakSet',
  '__dirname',
  '__filename',
  'clearInterval',
  'clearTimeout',
  'console',
  'crypto',
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
  'exports',
  'fetch',
  'globalThis',
  'isFinite',
  'isNaN',
  'module',
  'parseFloat',
  'parseInt',
  'performance',
  'process',
  'queueMicrotask',
  'require',
  'setInterval',
  'setTimeout',
  'structuredClone',
  'undefined',
])

/** `true` for an ECMAScript IdentifierName (reserved words included): valid after `.`. */
export function isIdentifierName(name: string): boolean {
  return IDENTIFIER_NAME.test(name)
}

/** `true` for an ASCII identifier that is not a reserved word (arrow parameters, hoisted constants). */
export function isSafeIdentifier(name: string): boolean {
  return ASCII_IDENTIFIER.test(name) && !RESERVED_WORDS.has(name)
}

/** `true` when `name` can be the local name of an import or a module-level `const`. */
export function isBindableName(name: string): boolean {
  return (
    IDENTIFIER_NAME.test(name) && !RESERVED_WORDS.has(name) && !TYPE_KEYWORDS.has(name) && !RESERVED_GLOBALS.has(name)
  )
}

/** Turns any string into an identifier-like name (`legacy-ns` → `legacyNs`, `1x` → `_1x`). */
export function toIdentifier(value: string): string {
  const words = value.split(/[^\p{ID_Continue}$]+/u).filter(word => word !== '')
  let name = words.map((word, index) => (index === 0 ? word : (word[0] ?? '').toUpperCase() + word.slice(1))).join('')
  if (name === '') {
    name = '_'
  }
  return IDENTIFIER_NAME.test(name) ? name : `_${name}`
}

/**
 * Single-quoted JavaScript string literal. Escapes quotes, backslashes, control characters, line
 * and paragraph separators and lone surrogates; other characters are kept as is (UTF-8 output).
 */
export function quote(value: string): string {
  let result = "'"
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    const char = value[index] as string
    switch (char) {
      case "'":
        result += "\\'"
        continue
      case '\\':
        result += '\\\\'
        continue
      case '\n':
        result += '\\n'
        continue
      case '\r':
        result += '\\r'
        continue
      case '\t':
        result += '\\t'
        continue
      case '\b':
        result += '\\b'
        continue
      case '\f':
        result += '\\f'
        continue
      case '\v':
        result += '\\v'
        continue
      default:
    }
    if (code < 0x20 || code === 0x7f) {
      result += `\\x${code.toString(16).padStart(2, '0')}`
    } else if (code === 0x2028 || code === 0x2029) {
      result += `\\u${code.toString(16)}`
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += char + (value[index + 1] as string)
        index++
      } else {
        result += `\\u${code.toString(16)}`
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      result += `\\u${code.toString(16)}`
    } else {
      result += char
    }
  }
  return `${result}'`
}
