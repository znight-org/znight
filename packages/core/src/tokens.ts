import type { ProviderClass, Token } from './metadata.ts'

declare const tokenType: unique symbol

/**
 * A {@link Token} carrying the type of the value it identifies. It is a plain string at runtime;
 * the type parameter only exists for the type checker:
 *
 * ```ts
 * export const ClockToken: TypedToken<Clock> = token<Clock>('@acme/time#Clock')
 * container.registerValue(ClockToken, systemClock) // value checked against Clock
 * const clock = container.get(ClockToken) // Clock
 * ```
 */
export type TypedToken<T> = Token & { readonly [tokenType]?: T }

/**
 * A class used as a lookup key, matched through its `prototype` (accepts classes with private or
 * protected constructors, which are not assignable to {@link ProviderClass}).
 */
export interface ClassKey<T = unknown> {
  readonly prototype: T
}

/** Anything the container accepts to look a provider up: a token, an alias, a display name or a class. */
export type ProviderKey<T = unknown> = TypedToken<T> | ProviderClass<T> | ClassKey<T>

/** Declares a {@link TypedToken}. Zero runtime cost: returns `id` unchanged. */
export function token<T>(id: string): TypedToken<T> {
  return id
}

/** Tokens under which `@znight/core` exposes its own objects to the container. */
export const CoreTokens: {
  /** The {@link Container} itself. */
  readonly Container: Token
  /** The running `Application` (registered by `Application.create`). */
  readonly Application: Token
  /** The application `Hooks` (registered by `Application.create`). */
  readonly Hooks: Token
  /** The live application `CoreLogger` (registered by `Application.create`). */
  readonly Logger: Token
} = Object.freeze({
  Container: '@znight/core#Container',
  Application: '@znight/core#Application',
  Hooks: '@znight/core#Hooks',
  Logger: '@znight/core#CoreLogger',
})

/**
 * Human readable name of a token: the part after the last `#`
 * (`src/users/user.service.ts#UserService` → `UserService`, `src/db.ts#DbFactory.createPool` →
 * `DbFactory.createPool`). Tokens without `#` are returned unchanged.
 */
export function displayName(token: Token): string {
  const index = token.lastIndexOf('#')
  return index === -1 ? token : token.slice(index + 1)
}

/** Formats a dependency path with display names: `UserController -> UserService -> Database`. */
export function formatPath(tokens: readonly Token[]): string {
  return tokens.map(displayName).join(' -> ')
}

/** `UserService (src/users/user.service.ts#UserService)`, or just the token when it has no `#`. */
export function describeToken(token: Token): string {
  const name = displayName(token)
  return name === token ? token : `${name} (${token})`
}

/** Describes any provider key for error messages. */
export function describeKey(key: unknown): string {
  if (typeof key === 'string') return describeToken(key)
  if (typeof key === 'function') return `class ${key.name || '<anonymous>'}`
  return String(key)
}
