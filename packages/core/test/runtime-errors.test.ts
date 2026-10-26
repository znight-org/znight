import {
  Container,
  ErrorCode,
  getSuppressedErrors,
  InstantiationError,
  isProviderDefinition,
  resolveOptions,
  ZnightAggregateError,
  ZnightError,
} from '../src/index.ts'
import { runWithTimeout, StepTimeoutError } from '../src/process.ts'
import { addSuppressedErrors, lifecycleError } from '../src/runtime-errors.ts'
import { caught, caughtSync, meta, sleep } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

describe('InstantiationError', () => {
  it('formats token, source and path, and keeps the cause', () => {
    const cause = new Error('boom')
    const error = new InstantiationError('src/a.ts#A', ['src/root.ts#Root', 'src/a.ts#A'], cause, {
      file: 'src/a.ts',
      line: 3,
      column: 14,
    })
    expect(error.name).toBe('ZnightError')
    expect(error.code).toBe(ErrorCode.InstantiationFailed)
    expect(error.message).toBe(
      'ZNIGHT015: Failed to instantiate A: boom\n  token: src/a.ts#A\n  at: src/a.ts:3:14\n  dependency path: Root -> A',
    )
    expect(error.cause).toBe(cause)
  })

  it('omits the path when the failing provider was requested directly', () => {
    const error = new InstantiationError('src/a.ts#A', ['src/a.ts#A'], 'string cause')
    expect(error.message).not.toContain('dependency path')
    expect(error.message).toContain('string cause')
    expect(error.source).toBeUndefined()
  })

  it('withParents() prefixes the path and keeps suppressed errors', () => {
    const error = new InstantiationError('src/a.ts#A', ['src/a.ts#A'], new Error('x'))
    addSuppressedErrors(error, ['cleanup'])
    const wrapped = error.withParents(['src/b.ts#B'])
    expect(wrapped.path).toEqual(['src/b.ts#B', 'src/a.ts#A'])
    expect(wrapped.message).toContain('B -> A')
    expect(getSuppressedErrors(wrapped)).toEqual(['cleanup'])
    expect(error.withParents([])).toBe(error)
  })
})

describe('ZnightAggregateError', () => {
  it('lists the aggregated errors in its message and exposes them', () => {
    const errors = [new Error('first'), 'second']
    const error = new ZnightAggregateError(ErrorCode.LifecycleFailed, 'Shutdown failed', errors)
    expect(error).toBeInstanceOf(ZnightError)
    expect(error.errors).toBe(errors)
    expect(error.message).toBe('ZNIGHT021: Shutdown failed\n  1. first\n  2. second')
  })
})

describe('suppressed errors', () => {
  it('accumulates on objects and ignores primitives and frozen objects', () => {
    const error = new Error('primary')
    addSuppressedErrors(error, [1])
    addSuppressedErrors(error, [2])
    addSuppressedErrors(error, [])
    expect(getSuppressedErrors(error)).toEqual([1, 2])
    expect(getSuppressedErrors('text')).toEqual([])
    expect(getSuppressedErrors(null)).toEqual([])
    expect(() => addSuppressedErrors('text', [1])).not.toThrow()
    const frozen = Object.freeze(new Error('frozen'))
    expect(() => addSuppressedErrors(frozen, [1])).not.toThrow()
    expect(getSuppressedErrors(frozen)).toEqual([])
  })
})

describe('lifecycleError', () => {
  it('wraps foreign errors in ZNIGHT021 and keeps Znight errors', () => {
    const foreign = new TypeError('bad')
    const wrapped = lifecycleError('Plugin "x" onStart()', foreign)
    expect(wrapped.code).toBe(ErrorCode.LifecycleFailed)
    expect(wrapped.message).toBe('ZNIGHT021: Plugin "x" onStart() failed: bad')
    expect(wrapped.cause).toBe(foreign)
    const own = new ZnightError(ErrorCode.MissingConfig, 'missing')
    expect(lifecycleError('step', own)).toBe(own)
  })
})

describe('runWithTimeout', () => {
  it('resolves synchronous steps immediately, even with a zero budget', async () => {
    let ran = false
    await runWithTimeout(
      'sync',
      () => {
        ran = true
      },
      0,
    )
    expect(ran).toBe(true)
    await runWithTimeout('resolved', () => Promise.resolve(), 0)
  })

  it('rejects with the step error', async () => {
    const failure = new Error('failed')
    expect(
      await caught(() =>
        runWithTimeout(
          'throws',
          () => {
            throw failure
          },
          10,
        ),
      ),
    ).toBe(failure)
    expect(await caught(() => runWithTimeout('rejects', () => Promise.reject(failure), 10))).toBe(failure)
  })

  it('rejects with a StepTimeoutError (ZNIGHT021) and ignores late results', async () => {
    const error = (await caught(() => runWithTimeout('slow step', () => sleep(50), 5))) as StepTimeoutError
    expect(error).toBeInstanceOf(StepTimeoutError)
    expect(error.code).toBe(ErrorCode.LifecycleFailed)
    expect(error.message).toContain('slow step timed out after 5ms')
    const late = (await caught(() =>
      runWithTimeout('late failure', () => sleep(20).then(() => Promise.reject(new Error('late'))), 1),
    )) as Error
    expect(late).toBeInstanceOf(StepTimeoutError)
    await sleep(30)
  })
})

describe('misc helpers', () => {
  it('resolveOptions() calls the function form with the container', () => {
    const container = Container.create(meta({}))
    expect(resolveOptions({ port: 1 }, container)).toEqual({ port: 1 })
    expect(resolveOptions(c => ({ same: c === container }), container)).toEqual({ same: true })
  })

  it('isProviderDefinition() recognises definitions only', () => {
    expect(isProviderDefinition({ scope: 'singleton', deps: [], factory: () => 1 })).toBe(true)
    expect(isProviderDefinition({ scope: 'session', deps: [], factory: () => 1 })).toBe(false)
    expect(isProviderDefinition({ scope: 'singleton', deps: {}, factory: () => 1 })).toBe(false)
    expect(isProviderDefinition({ scope: 'singleton', deps: [] })).toBe(false)
    expect(isProviderDefinition(null)).toBe(false)
    expect(isProviderDefinition('singleton')).toBe(false)
  })

  it('Container.create() rejects metadata without a resolution order', () => {
    const error = caughtSync(() =>
      Container.create({ version: 1, providers: {} } as unknown as Parameters<typeof Container.create>[0]),
    ) as ZnightError
    expect(error.code).toBe(ErrorCode.VersionMismatch)
  })
})
