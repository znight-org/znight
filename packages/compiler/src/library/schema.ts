/**
 * `znight.providers.json` (§6.4): the compiled metadata of a provider library, emitted in library
 * mode (`library: true`) and merged into the application graph before binding.
 *
 * Identities are package identities (`@acme/auth#JwtService`): the library's own declarations are
 * translated to the public exports of its package. Values that JSON cannot represent are encoded
 * with a `$znight` tag (see {@link EncodedValue}).
 */
import type { Scope } from '@znight/core'

/** Version of the `znight.providers.json` format. */
export const PROVIDERS_SCHEMA_VERSION = 1

/** File name of the compiled providers fragment (in `dist/`). */
export const PROVIDERS_FILE = 'znight.providers.json'

/**
 * A JSON-encoded value. JSON primitives and arrays are themselves; other values are tagged objects:
 * `{ $znight: 'undefined' }`, `{ $znight: 'number', value: 'NaN' | 'Infinity' | '-Infinity' | '-0' }`,
 * `{ $znight: 'bigint', value }`, `{ $znight: 'regexp', source, flags }`, `{ $znight: 'date', value }`,
 * `{ $znight: 'ref', identity }` (exported binding), `{ $znight: 'class', identity }` (`ClassInfo`),
 * `{ $znight: 'binding', id }` (`bindInjection` handle), `{ $znight: 'location', file, ... }` (file
 * relative to the package), `{ $znight: 'object', value }` (an object with a `$znight` key).
 */
export type EncodedValue =
  | string
  | number
  | boolean
  | null
  | readonly EncodedValue[]
  | { readonly [key: string]: EncodedValue }

/** An injection point (§4.7 inputs). */
export interface LibraryInjection {
  /** Encoded `TypeInfo` (identities translated). */
  readonly type: EncodedValue
  readonly qualifier?: string
  readonly optional?: true
  /** `parameter 'x' of JwtService` (messages). */
  readonly label: string
}

/** One interceptor of a method chain. */
export interface LibraryInterceptorLink {
  readonly token: string
  /** Identity of the decorator (`@znight/core#Intercept`, `@znight/observability#Logged`). */
  readonly decorator: string
  /** Present when the decorator has an options argument. */
  readonly options?: EncodedValue
}

/** Interceptors of one method. */
export interface LibraryInterceptedMethod {
  readonly method: string
  readonly async: boolean
  readonly chain: readonly LibraryInterceptorLink[]
}

/** An import route (package specifier + public export). */
export interface LibraryImportRoute {
  readonly specifier: string
  readonly exportName: string
  readonly members: readonly string[]
}

/** A provider of the library. */
export interface LibraryProvider {
  readonly token: string
  readonly kind: 'class' | 'provides'
  /** Provider class (`class`) or `@Factory` class (`provides`) identity. */
  readonly class: string
  /** Import route of {@link class}. */
  readonly importRoute: LibraryImportRoute
  /** `provides`: the method name. */
  readonly method?: string
  /** Encoded provided `TypeInfo`. */
  readonly providedType: EncodedValue
  /** Encoded heritage closure (`ReferenceType[]`). */
  readonly heritage: EncodedValue
  readonly scope: Scope
  readonly name?: string
  readonly primary?: true
  readonly async?: true
  readonly dispose?: string
  /** `'core'`, `'auto'` or the extension that registered it. */
  readonly registeredBy: string
  /** Lifecycle members (`onStart`, `[Symbol.asyncDispose]`...). */
  readonly lifecycle: readonly string[]
  readonly params: readonly LibraryInjection[]
  readonly interceptors: readonly LibraryInterceptedMethod[]
}

/** A runtime dependency declared by an extension (`addDependency`, `resolveClassRef({ from })`). */
export interface LibraryEdge {
  readonly from: string
  readonly to: string
  readonly reason: string
}

/** A `bindInjection` request, re-bound by the application. */
export interface LibraryBinding extends LibraryInjection {
  readonly id: number
  readonly from?: string
}

/** The whole fragment. */
export interface ProvidersFile {
  readonly schemaVersion: number
  /** Package name. */
  readonly package: string
  /** `@znight/compiler` version that produced it. */
  readonly compiler: string
  readonly providers: readonly LibraryProvider[]
  readonly edges: readonly LibraryEdge[]
  readonly bindings: readonly LibraryBinding[]
  /** Data stored by compiler extensions (`ctx.store()`), by extension name. */
  readonly extensions: Readonly<Record<string, readonly EncodedValue[]>>
}

/** Hooks of {@link encodeValue} for the values that need the project. */
export interface EncodeHooks {
  /** `ValueRef` → translated identity (`undefined`: not encodable). */
  ref(value: object): string | undefined
  /** `ClassInfo` → translated identity, `undefined` when `value` is not a `ClassInfo`. */
  classInfo(value: object): string | undefined
  /** Binding handle → id, `undefined` when `value` is not a handle. */
  binding(value: object): number | undefined
  /** `Location` → file relative to the package (`undefined` when `value` is not a location). */
  location(value: object): string | undefined
}

/** Thrown when a value cannot be encoded (functions, class instances...). */
export class EncodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EncodeError'
  }
}

const TAG = '$znight'

/** Encodes a value for `znight.providers.json`. */
export function encodeValue(value: unknown, hooks: EncodeHooks, stack: Set<object> = new Set()): EncodedValue {
  switch (typeof value) {
    case 'undefined':
      return { [TAG]: 'undefined' }
    case 'string':
    case 'boolean':
      return value
    case 'number':
      if (Number.isNaN(value)) {
        return { [TAG]: 'number', value: 'NaN' }
      }
      if (value === Number.POSITIVE_INFINITY || value === Number.NEGATIVE_INFINITY) {
        return { [TAG]: 'number', value: value > 0 ? 'Infinity' : '-Infinity' }
      }
      return Object.is(value, -0) ? { [TAG]: 'number', value: '-0' } : value
    case 'bigint':
      return { [TAG]: 'bigint', value: String(value) }
    case 'object': {
      if (value === null) {
        return null
      }
      if (value instanceof RegExp) {
        return { [TAG]: 'regexp', source: value.source, flags: value.flags }
      }
      if (value instanceof Date) {
        return { [TAG]: 'date', value: encodeValue(value.getTime(), hooks) }
      }
      if (stack.has(value)) {
        throw new EncodeError('cyclic values cannot be stored in a compiled provider library')
      }
      if ((value as { kind?: unknown }).kind === 'ref' && 'symbol' in value) {
        const identity = hooks.ref(value)
        if (identity === undefined) {
          throw new EncodeError(`the reference '${(value as { text?: string }).text}' has no public identity`)
        }
        return { [TAG]: 'ref', identity }
      }
      const classIdentity = hooks.classInfo(value)
      if (classIdentity !== undefined) {
        return { [TAG]: 'class', identity: classIdentity }
      }
      const binding = hooks.binding(value)
      if (binding !== undefined) {
        return { [TAG]: 'binding', id: binding }
      }
      const file = hooks.location(value)
      if (file !== undefined) {
        const location = value as Record<string, number>
        return {
          [TAG]: 'location',
          file,
          line: location['line'] as number,
          column: location['column'] as number,
          endLine: location['endLine'] as number,
          endColumn: location['endColumn'] as number,
          start: location['start'] as number,
          end: location['end'] as number,
        }
      }
      stack.add(value)
      try {
        if (Array.isArray(value)) {
          return value.map(item => encodeValue(item, hooks, stack))
        }
        const prototype = Object.getPrototypeOf(value)
        if (prototype !== Object.prototype && prototype !== null) {
          const name = (value as { constructor?: { name?: string } }).constructor?.name
          throw new EncodeError(`${name ? `an instance of ${name}` : 'an object'} cannot be stored`)
        }
        const record: Record<string, EncodedValue> = {}
        for (const [key, entry] of Object.entries(value)) {
          record[key] = encodeValue(entry, hooks, stack)
        }
        return Object.hasOwn(record, TAG) ? { [TAG]: 'object', value: record } : record
      } finally {
        stack.delete(value)
      }
    }
    default:
      throw new EncodeError(`${typeof value === 'function' ? 'functions' : 'symbols'} cannot be stored`)
  }
}

/** Hooks of {@link decodeValue}. */
export interface DecodeHooks {
  ref(identity: string): unknown
  classInfo(identity: string): unknown
  binding(id: number): unknown
  location(encoded: Readonly<Record<string, unknown>>): unknown
}

/** Decodes a value of `znight.providers.json`. */
export function decodeValue(value: EncodedValue, hooks: DecodeHooks): unknown {
  if (value === null || typeof value !== 'object') {
    return value
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map(item => decodeValue(item, hooks)))
  }
  const record = value as Readonly<Record<string, EncodedValue>>
  const tag = record[TAG]
  if (tag === undefined) {
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(record)) {
      result[key] = decodeValue(entry, hooks)
    }
    return Object.freeze(result)
  }
  switch (tag) {
    case 'undefined':
      return undefined
    case 'number':
      return record['value'] === '-0' ? -0 : Number(record['value'])
    case 'bigint':
      return BigInt(String(record['value']))
    case 'regexp':
      return new RegExp(String(record['source']), String(record['flags']))
    case 'date':
      return new Date(decodeValue(record['value'] as EncodedValue, hooks) as number)
    case 'ref':
      return hooks.ref(String(record['identity']))
    case 'class':
      return hooks.classInfo(String(record['identity']))
    case 'binding':
      return hooks.binding(Number(record['id']))
    case 'location':
      return hooks.location(record)
    case 'object': {
      const inner = record['value'] as Readonly<Record<string, EncodedValue>>
      const result: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(inner)) {
        result[key] = decodeValue(entry, hooks)
      }
      return Object.freeze(result)
    }
    default:
      throw new EncodeError(`unknown encoded value tag ${JSON.stringify(tag)}`)
  }
}
