/**
 * Import table and name pool of the generated module.
 *
 * Every binding the module needs is registered while the module is built; local names are
 * assigned once everything is known ({@link NamePool.finalize}), by identity order, so that the
 * output never depends on generation order: `UserService` (`src/a.ts#UserService`) and
 * `UserService$1` (`src/b.ts#UserService`). Names never shadow a reserved word, a global used by
 * generated code, an arrow-function parameter or another binding.
 *
 * Usages are recorded per **context** (`'root'` for the metadata object, one context per
 * module-level constant): only the imports and constants reachable from the root are emitted, so
 * the module never declares an unused binding (`noUnusedLocals`).
 */
import type { Doc } from './doc.ts'

import { compareStrings } from '../project/compare.ts'
import { lazy } from './doc.ts'
import { isBindableName, isIdentifierName, quote, toIdentifier } from './syntax.ts'

/** The context of the metadata object itself. */
export const ROOT_CONTEXT = 'root'

/** A binding to import. */
export interface ImportRequest {
  /** Module specifier (bare or relative). */
  readonly specifier: string
  /** Export name, or `'default'`. */
  readonly exportName: string
  /** Used in type positions only (`import type`). */
  readonly typeOnly: boolean
  /** Determines the name assignment order (canonical identity of the imported entity). */
  readonly sortKey: string
  /** Preferred local name. */
  readonly hint: string
}

/** A binding that receives a local name. */
interface NamedEntry {
  order: string
  hint: string
  name: string | undefined
}

interface ImportEntry extends NamedEntry {
  readonly specifier: string
  readonly exportName: string
  /** Context → used as a value in that context. */
  readonly uses: Map<string, boolean>
  /** Emitted as a value import (computed by {@link NamePool.finalize}). */
  value: boolean
}

interface ConstantEntry extends NamedEntry {
  readonly context: string
}

/** Local names of imports and module-level constants. */
export class NamePool {
  readonly #imports = new Map<string, ImportEntry>()
  readonly #constants: ConstantEntry[] = []
  readonly #reserved = new Set<string>()
  #emitted: ImportEntry[] | undefined
  #reachable: ReadonlySet<string> | undefined

  /** Registers an import used in `context` and returns a doc printing its local name. */
  import(request: ImportRequest, context: string = ROOT_CONTEXT): Doc {
    const key = `${request.specifier}\0${request.exportName}`
    let entry = this.#imports.get(key)
    if (entry) {
      if (compareStrings(request.sortKey, entry.order) < 0) {
        entry.order = request.sortKey
        entry.hint = request.hint
      }
    } else {
      entry = {
        specifier: request.specifier,
        exportName: request.exportName,
        uses: new Map(),
        value: false,
        order: request.sortKey,
        hint: request.hint,
        name: undefined,
      }
      this.#imports.set(key, entry)
    }
    entry.uses.set(context, (entry.uses.get(context) ?? false) || !request.typeOnly)
    const target = entry
    return lazy(() => this.#nameOf(target))
  }

  /**
   * Registers a module-level constant whose value is printed in `context` (named after the
   * imports, in registration order).
   */
  constant(hint: string, context: string): Doc {
    const entry: ConstantEntry = { order: String(this.#constants.length), hint, name: undefined, context }
    this.#constants.push(entry)
    return lazy(() => this.#nameOf(entry))
  }

  /** A name nothing may be bound to (arrow parameters, `__ZNIGHT_METADATA__`). */
  reserve(name: string): void {
    this.#reserved.add(name)
  }

  /**
   * Assigns the local names of the bindings used by the `reachable` contexts (default: every
   * context). Only the first call has an effect: call it once the whole module is built.
   */
  finalize(reachable?: ReadonlySet<string>): void {
    if (this.#emitted) {
      return
    }
    this.#reachable = reachable
    const taken = new Set(this.#reserved)
    const assign = (entry: NamedEntry): void => {
      const base = isBindableName(entry.hint) ? entry.hint : toIdentifier(entry.hint)
      let name = base
      let counter = 0
      while (taken.has(name) || !isBindableName(name)) {
        counter++
        name = `${base}$${counter}`
      }
      taken.add(name)
      entry.name = name
    }
    const emitted: ImportEntry[] = []
    for (const entry of this.#imports.values()) {
      let used = false
      let value = false
      for (const [context, asValue] of entry.uses) {
        if (reachable === undefined || reachable.has(context)) {
          used = true
          value ||= asValue
        }
      }
      if (used) {
        entry.value = value
        emitted.push(entry)
      }
    }
    emitted.sort(
      (a, b) =>
        compareStrings(a.order, b.order) ||
        compareStrings(a.specifier, b.specifier) ||
        compareStrings(a.exportName, b.exportName),
    )
    emitted.forEach(assign)
    for (const entry of this.#constants) {
      if (this.isEmitted(entry.context)) {
        assign(entry)
      }
    }
    this.#emitted = emitted
  }

  /** `true` when the bindings of `context` are emitted. */
  isEmitted(context: string): boolean {
    return this.#reachable === undefined || this.#reachable.has(context)
  }

  /**
   * Import statements, sorted: `@znight/core`, other packages, then relative paths; `import type`
   * before values.
   */
  statements(): string[] {
    this.finalize()
    const bySpecifier = new Map<string, ImportEntry[]>()
    for (const entry of this.#emitted ?? []) {
      const list = bySpecifier.get(entry.specifier)
      if (list) {
        list.push(entry)
      } else {
        bySpecifier.set(entry.specifier, [entry])
      }
    }
    const specifiers = [...bySpecifier.keys()].sort((a, b) => rank(a) - rank(b) || compareStrings(a, b))
    const lines: string[] = []
    for (const specifier of specifiers) {
      const entries = (bySpecifier.get(specifier) as ImportEntry[]).sort((a, b) =>
        compareStrings(a.exportName, b.exportName),
      )
      const from = ` from ${quote(specifier)}`
      const typeDefault = entries.find(entry => !entry.value && entry.exportName === 'default')
      const typeNamed = entries.filter(entry => !entry.value && entry.exportName !== 'default')
      const valueDefault = entries.find(entry => entry.value && entry.exportName === 'default')
      const valueNamed = entries.filter(entry => entry.value && entry.exportName !== 'default')
      if (typeDefault) {
        lines.push(`import type ${typeDefault.name as string}${from}`)
      }
      if (typeNamed.length > 0) {
        lines.push(`import type { ${typeNamed.map(specifierText).join(', ')} }${from}`)
      }
      if (valueDefault || valueNamed.length > 0) {
        const parts: string[] = []
        if (valueDefault) {
          parts.push(valueDefault.name as string)
        }
        if (valueNamed.length > 0) {
          parts.push(`{ ${valueNamed.map(specifierText).join(', ')} }`)
        }
        lines.push(`import ${parts.join(', ')}${from}`)
      }
    }
    return lines
  }

  #nameOf(entry: NamedEntry): string {
    if (entry.name === undefined) {
      throw new Error('[znight] internal error: a local name was printed before the names were assigned')
    }
    return entry.name
  }
}

function specifierText(entry: ImportEntry): string {
  const local = entry.name as string
  if (entry.exportName === local) {
    return local
  }
  const imported = isIdentifierName(entry.exportName) ? entry.exportName : quote(entry.exportName)
  return `${imported} as ${local}`
}

/** Statement group of a specifier: `@znight/core`, packages, relative paths. */
function rank(specifier: string): number {
  if (specifier === '@znight/core') {
    return 0
  }
  return specifier.startsWith('.') || specifier.startsWith('/') ? 2 : 1
}
