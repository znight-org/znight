import type { Token, ZnightMetadata } from '@znight/core'

import { displayName } from '@znight/core'

import { resolveLoggedOptions } from '../interceptors/logged.ts'
import { resolveMetricOptions } from '../interceptors/metric.ts'
import { resolveTracedOptions } from '../interceptors/traced.ts'
import { ObservabilityTokens } from '../tokens.ts'

type Validator = readonly [decorator: string, validate: (options: unknown, where: string) => unknown]

const VALIDATORS: ReadonlyMap<Token, Validator> = new Map<Token, Validator>([
  [ObservabilityTokens.LoggedInterceptor, ['@Logged()', resolveLoggedOptions]],
  [ObservabilityTokens.TracedInterceptor, ['@Traced()', resolveTracedOptions]],
  [ObservabilityTokens.MetricInterceptor, ['@Metric()', resolveMetricOptions]],
])

/**
 * Validates the options of every `@Logged()` / `@Traced()` / `@Metric()` binding of the compiled
 * metadata, so that a misconfigured decorator fails `Application.create()` instead of the first call
 * of the method.
 *
 * @throws ZnightError (ZNIGHT005) naming the decorator, the provider and the method.
 */
export function validateInterceptorOptions(metadata: ZnightMetadata): void {
  for (const [token, definition] of Object.entries(metadata.providers)) {
    if (definition.interceptors === undefined) continue
    for (const [method, interception] of Object.entries(definition.interceptors)) {
      for (const binding of interception.chain) {
        const dependency = definition.deps[binding.dep]
        const validator = typeof dependency === 'string' ? VALIDATORS.get(dependency) : undefined
        if (validator === undefined) continue
        const [decorator, validate] = validator
        validate(binding.options, `${decorator} on ${displayName(token)}.${method}()`)
      }
    }
  }
}
