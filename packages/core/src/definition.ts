import type { ProviderDefinition, Token } from './metadata.ts'

import { ErrorCode, ZnightError } from './errors.ts'
import { describeToken } from './tokens.ts'

const SCOPES: ReadonlySet<string> = new Set(['singleton', 'request', 'transient'])

/** Whether `value` has the shape of a {@link ProviderDefinition} (`{ scope, deps, factory }`). */
export function isProviderDefinition(value: unknown): value is ProviderDefinition {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<ProviderDefinition>
  return (
    typeof candidate.factory === 'function' &&
    Array.isArray(candidate.deps) &&
    typeof candidate.scope === 'string' &&
    SCOPES.has(candidate.scope)
  )
}

/**
 * Checks the shape of a provider definition.
 *
 * @throws ZnightError ZNIGHT005 for a malformed definition, ZNIGHT014 for an async non-singleton.
 */
export function validateDefinition(token: Token, definition: ProviderDefinition): void {
  if (!isProviderDefinition(definition)) {
    throw new ZnightError(
      ErrorCode.InvalidDecorator,
      `Invalid provider definition for ${describeToken(token)}: expected { scope, deps, factory }`,
    )
  }
  if (definition.async === true && definition.scope !== 'singleton') {
    throw new ZnightError(
      ErrorCode.AsyncNonSingleton,
      `${describeToken(token)} has an async factory but is ${definition.scope}-scoped`,
      { hints: ['Only singletons may have async factories'] },
    )
  }
}
