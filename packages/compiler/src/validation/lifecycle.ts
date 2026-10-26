/**
 * ZNIGHT009: invalid lifecycle hooks. Static hooks and hooks with required parameters are errors
 * (the runtime calls `instance.onStart()` without arguments); `onStart`/`onReady`/`onStop` on a
 * non-singleton and disposal hooks on a transient provider are warnings (never called).
 */
import type { Reporter } from '../analysis/arguments.ts'
import type { ProviderNode } from '../graph/types.ts'
import type { Location, Project } from '../project/index.ts'

import { ErrorCode } from '@znight/core'

import { displayNameOf } from '../project/index.ts'

/** Validates the lifecycle hooks of every provider. */
export function checkLifecycle(project: Project, providers: readonly ProviderNode[], report: Reporter): void {
  for (const provider of providers) {
    for (const hook of provider.lifecycle) {
      const where = `${displayNameOf(hook.declaredBy)}.${hook.member}`
      const location: Location = project.isScanned(hook.location.file) ? hook.location : provider.location
      if (hook.static) {
        report({
          code: ErrorCode.InvalidLifecycleHook,
          severity: 'error',
          message: `Lifecycle hook ${where} must not be static: hooks are called on the instance`,
          location,
          hints: ['Remove the `static` modifier'],
        })
        continue
      }
      if (hook.requiredParams > 0) {
        report({
          code: ErrorCode.InvalidLifecycleHook,
          severity: 'error',
          message: `Lifecycle hook ${where} must not have required parameters: it is called without arguments`,
          location,
          hints: ['Remove the parameters or make them optional'],
        })
      }
      const isDisposal = hook.hook === 'asyncDispose' || hook.hook === 'dispose'
      if (!isDisposal && provider.scope !== 'singleton') {
        report({
          code: ErrorCode.InvalidLifecycleHook,
          severity: 'warning',
          message: `${where} is never called: ${provider.displayName} is ${provider.scope}-scoped and only singletons receive lifecycle hooks`,
          location,
          hints: ['Make the provider a singleton, or use the request scope lifecycle (disposal) instead'],
        })
      }
      if (isDisposal && provider.scope === 'transient') {
        report({
          code: ErrorCode.InvalidLifecycleHook,
          severity: 'warning',
          message: `${where} is never called: ${provider.displayName} is transient and transient instances are not disposed by the container`,
          location,
          hints: ['Dispose the instance in the provider that owns it'],
        })
      }
    }
    if (provider.dispose !== undefined && provider.scope === 'transient') {
      report({
        code: ErrorCode.InvalidLifecycleHook,
        severity: 'warning',
        message: `dispose '${provider.dispose}' of ${provider.displayName} is never called: transient instances are not disposed by the container`,
        location: provider.location,
      })
    }
  }
}
