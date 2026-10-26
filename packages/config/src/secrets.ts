/**
 * Masking of `@Secret` properties: a config instance prints and serialises with `[REDACTED]` in place
 * of its secret values, while the properties themselves keep their real values.
 */
import { inspect } from 'node:util'

import { SECRET_MASK } from './conventions.ts'

const INSPECT: unique symbol = Symbol.for('nodejs.util.inspect.custom')

type InspectFn = (value: unknown, options?: object) => string

/** A copy of the own enumerable properties of `instance` with the secret values masked. */
export function maskedView(instance: object, secrets: ReadonlySet<string>): Record<string, unknown> {
  const view: Record<string, unknown> = {}
  for (const [property, value] of Object.entries(instance)) {
    view[property] = secrets.has(property) && value !== undefined && value !== null ? SECRET_MASK : value
  }
  return view
}

function define(instance: object, key: PropertyKey, value: unknown): void {
  Object.defineProperty(instance, key, { value, writable: true, enumerable: false, configurable: true })
}

/**
 * Installs non-enumerable `toJSON`, `toString` and `util.inspect.custom` methods on `instance` that
 * mask the `secrets` properties. Methods the class defines itself are kept (the class then owns
 * its serialisation).
 */
export function maskSecrets(instance: object, secrets: Iterable<string>): void {
  const masked = new Set(secrets)
  if (masked.size === 0) return
  const target = instance as Record<PropertyKey, unknown>
  const className = instance.constructor?.name || 'Config'

  if (target.toJSON === undefined) {
    define(instance, 'toJSON', function maskedToJSON(this: object): Record<string, unknown> {
      return maskedView(this, masked)
    })
  }
  if (target.toString === Object.prototype.toString) {
    define(instance, 'toString', function maskedToString(this: object): string {
      return `${className} ${JSON.stringify(maskedView(this, masked))}`
    })
  }
  if (target[INSPECT] === undefined) {
    define(
      instance,
      INSPECT,
      function maskedInspect(this: object, _depth: number, options: object, fn?: InspectFn): string {
        // same prototype so the class name is printed, but without this method: no recursion
        const view = Object.assign(
          Object.create(Object.getPrototypeOf(this) as object | null) as object,
          maskedView(this, masked),
        )
        return (fn ?? inspect)(view, options)
      },
    )
  }
}
