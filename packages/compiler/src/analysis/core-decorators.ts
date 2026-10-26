/**
 * Canonical identities of the `@znight/core` decorators and type helpers (§5), and their argument
 * specifications.
 */
import type { DecoratorSpec } from '../extensions/api.ts'

/** Name of the core package (owner of the built-in decorators). */
export const CORE_PACKAGE = '@znight/core'

/** Identities of the built-in decorators. */
export const CoreDecorator: {
  readonly Injectable: string
  readonly Factory: string
  readonly Provides: string
  readonly Inject: string
  readonly Optional: string
  readonly Named: string
  readonly Primary: string
  readonly Intercept: string
} = Object.freeze({
  Injectable: '@znight/core#Injectable',
  Factory: '@znight/core#Factory',
  Provides: '@znight/core#Provides',
  Inject: '@znight/core#Inject',
  Optional: '@znight/core#Optional',
  Named: '@znight/core#Named',
  Primary: '@znight/core#Primary',
  Intercept: '@znight/core#Intercept',
})

/** Identity of `Lazy<T>`. */
export const LAZY_IDENTITY = '@znight/core#Lazy'

/** Owner of the built-in decorators in `DecoratorInfo.owner`. */
export const CORE_OWNER = 'core'

/** Owner of manifest interceptor decorators (`@Logged`) in `DecoratorInfo.owner`. */
export const MANIFEST_OWNER = 'manifest'

/** Argument specifications of the built-in decorators. */
export const CORE_DECORATOR_SPECS: ReadonlyMap<string, DecoratorSpec> = new Map<string, DecoratorSpec>([
  [CoreDecorator.Injectable, { targets: ['class'], params: ['static'] }],
  [CoreDecorator.Factory, { targets: ['class'], params: [] }],
  [CoreDecorator.Provides, { targets: ['method'], params: ['static'] }],
  [CoreDecorator.Inject, { targets: ['constructorParameter', 'parameter'], params: ['static'] }],
  [CoreDecorator.Optional, { targets: ['constructorParameter', 'parameter'], params: [] }],
  [CoreDecorator.Named, { targets: ['class', 'method'], params: ['static'] }],
  [CoreDecorator.Primary, { targets: ['class', 'method'], params: [] }],
  [CoreDecorator.Intercept, { targets: ['method'], params: ['value', 'value'] }],
])

/** Specification of the interceptor decorators declared in manifests (`@Logged(options?)`). */
export const INTERCEPTOR_DECORATOR_SPEC: DecoratorSpec = Object.freeze<DecoratorSpec>({
  targets: ['method'],
  params: ['value'],
})

/** Lifecycle member names → hook. */
export const LIFECYCLE_MEMBERS: ReadonlyMap<string, 'onStart' | 'onReady' | 'onStop' | 'asyncDispose' | 'dispose'> =
  new Map([
    ['onStart', 'onStart'],
    ['onReady', 'onReady'],
    ['onStop', 'onStop'],
    ['[Symbol.asyncDispose]', 'asyncDispose'],
    ['[Symbol.dispose]', 'dispose'],
  ])

/** Human readable target names (messages). */
export const TARGET_NAMES: Readonly<Record<string, string>> = {
  class: 'a class',
  method: 'a method',
  property: 'a property',
  parameter: 'a method parameter',
  constructorParameter: 'a constructor parameter',
}
