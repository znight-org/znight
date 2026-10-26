import type { DependencyRef, ProviderDefinition, ProviderFactory, ProviderKey, Scope } from '@znight/core'

/** A typed `[key, value]` entry for `overrides` / `providers` / `provide`. */
export type OverrideEntry<T = unknown> = readonly [ProviderKey<T>, T]

/** A `[key, definition]` entry replacing a provider with a factory. */
export type OverrideDefinitionEntry<T = unknown> = readonly [ProviderKey<T>, ProviderDefinition<T>]

/**
 * A type-checked override: the value must match the type designated by the class or typed token.
 *
 * ```ts
 * await TestApp.create({ metadata, overrides: [override(UserRepository, new InMemoryUserRepository())] })
 * ```
 */
export function override<T>(key: ProviderKey<T>, value: NoInfer<T>): OverrideEntry<T> {
  return [key, value]
}

/** Options of {@link overrideFactory}. */
export interface OverrideFactoryOptions {
  /** Tokens resolved and passed to the factory, in order. Default: none. */
  readonly deps?: readonly DependencyRef[]
  /** Default: `'singleton'`. */
  readonly scope?: Scope
  /** Set when the factory returns a promise (singletons only). */
  readonly async?: boolean
  /** Method called when the instance is disposed. */
  readonly dispose?: string
}

/**
 * Replaces a provider with a factory whose dependencies are resolved by the container (or, in
 * `TestBed`, like the target's dependencies).
 *
 * ```ts
 * overrideFactory(UserRepository, ([db]) => new InMemoryUserRepository(db), { deps: ['src/db.ts#Database'] })
 * ```
 */
export function overrideFactory<T>(
  key: ProviderKey<T>,
  factory: ProviderFactory<NoInfer<T>>,
  options: OverrideFactoryOptions = {},
): OverrideDefinitionEntry<T> {
  if (typeof factory !== 'function') throw new TypeError('[znight] overrideFactory() expects a factory function')
  const definition: ProviderDefinition<T> = {
    scope: options.scope ?? 'singleton',
    deps: options.deps ?? [],
    factory,
    ...(options.async === undefined ? {} : { async: options.async }),
    ...(options.dispose === undefined ? {} : { dispose: options.dispose }),
  }
  return [key, definition]
}
