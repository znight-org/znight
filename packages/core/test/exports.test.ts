import * as entry from '../src/index.ts'
import { describe, expect, it } from 'bun:test'

describe('public entry', () => {
  it('exposes the runtime API', () => {
    const expected = [
      'Application',
      'Container',
      'Hooks',
      'DelegatingLogger',
      'ZnightError',
      'ZnightAggregateError',
      'InstantiationError',
      'ErrorCode',
      'ERROR_DESCRIPTIONS',
      'METADATA_VERSION',
      'CoreTokens',
      'Injectable',
      'Factory',
      'Provides',
      'Inject',
      'Optional',
      'Named',
      'Primary',
      'Intercept',
      'applyInterceptors',
      'interceptMethod',
      'callLifecycleHook',
      'hasLifecycleHook',
      'disposeInstance',
      'isDisposable',
      'createConsoleLogger',
      'silentLogger',
      'resolveOptions',
      'getSuppressedErrors',
      'isProviderDefinition',
      'displayName',
      'describeToken',
      'formatPath',
      'token',
    ]
    for (const name of expected) expect(entry).toHaveProperty(name)
  })

  it('does not leak internals', () => {
    for (const name of ['Slot', 'RequestScope', 'bindBuiltin', 'setRegistrationOrigin', 'runWithTimeout']) {
      expect(entry).not.toHaveProperty(name)
    }
  })

  it('describes every error code', () => {
    for (const code of Object.values(entry.ErrorCode)) expect(entry.ERROR_DESCRIPTIONS[code]).toBeString()
  })
})
