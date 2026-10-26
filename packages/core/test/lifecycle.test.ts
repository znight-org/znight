import {
  callLifecycleHook,
  disposeInstance,
  ErrorCode,
  hasLifecycleHook,
  isDisposable,
  type OnStart,
  type ZnightError,
} from '../src/index.ts'
import { caughtSync } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

describe('lifecycle duck typing', () => {
  it('detects hooks declared on the class or on a base class', () => {
    class Base implements OnStart {
      onStart(): void {}
    }
    class Child extends Base {}
    expect(hasLifecycleHook(new Child(), 'onStart')).toBe(true)
    expect(hasLifecycleHook(new Child(), 'onStop')).toBe(false)
    expect(hasLifecycleHook({ onReady: 1 }, 'onReady')).toBe(false)
    expect(hasLifecycleHook(null, 'onStart')).toBe(false)
    expect(hasLifecycleHook('text', 'onStart')).toBe(false)
  })

  it('calls hooks with the instance as this', async () => {
    class Service {
      started = false
      onStart(): Promise<void> {
        this.started = true
        return Promise.resolve()
      }
    }
    const service = new Service()
    await callLifecycleHook(service, 'onStart')
    expect(service.started).toBe(true)
    expect(callLifecycleHook({}, 'onStop')).toBeUndefined()
  })
})

describe('disposeInstance', () => {
  it('prefers the configured dispose method, then Symbol.asyncDispose, then Symbol.dispose', async () => {
    const log: string[] = []
    const all = {
      end: () => log.push('end'),
      [Symbol.asyncDispose]: async () => log.push('async'),
      [Symbol.dispose]: () => log.push('sync'),
    }
    await disposeInstance(all, 'end')
    await disposeInstance(all)
    disposeInstance({ [Symbol.dispose]: () => log.push('sync only') })
    expect(log).toEqual(['end', 'async', 'sync only'])
  })

  it('does nothing for non-disposable values', () => {
    expect(disposeInstance({})).toBeUndefined()
    expect(disposeInstance(undefined)).toBeUndefined()
    expect(disposeInstance(42)).toBeUndefined()
  })

  it('throws ZNIGHT021 when the configured method does not exist', () => {
    class Pool {}
    const error = caughtSync(() => disposeInstance(new Pool(), 'close')) as ZnightError
    expect(error.code).toBe(ErrorCode.LifecycleFailed)
    expect(error.message).toContain('an instance of Pool')
    expect(error.message).toContain('"close"')
  })

  it('isDisposable mirrors disposeInstance', () => {
    expect(isDisposable({}, 'close')).toBe(true)
    expect(isDisposable({ [Symbol.asyncDispose]: async () => {} })).toBe(true)
    expect(isDisposable({ [Symbol.dispose]: () => {} })).toBe(true)
    expect(isDisposable({ close: () => {} })).toBe(false)
    expect(isDisposable(null)).toBe(false)
  })
})
