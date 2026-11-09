/**
 * The deferred abort signal of the HTTP transport and the engine (RFC 0005 §8.3): it follows the
 * request's signal only while graphql-js listens, and wires up a listener registered after
 * `follow()` (an asynchronous `graphql:operation` wrapper delays the execution).
 */
import { getEventListeners } from 'node:events'

import { DeferredAbort } from '../src/transport/abort.ts'
import { describe, expect, it } from 'bun:test'

describe('DeferredAbort', () => {
  it('stops following the source once graphql-js removes its listener', () => {
    const controller = new AbortController()
    const abort = new DeferredAbort()
    const listener = (): void => {}
    abort.addEventListener('abort', listener)
    abort.follow(() => controller.signal)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1)
    abort.removeEventListener('abort', listener)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    controller.abort(new Error('late'))
    expect(abort.aborted).toBe(false)
  })

  it('aborts a listener registered after follow()', () => {
    const controller = new AbortController()
    const abort = new DeferredAbort()
    let read = 0
    abort.follow(() => {
      read++
      return controller.signal
    })
    // nothing listens yet: the source is not read
    expect(read).toBe(0)
    const calls: string[] = []
    abort.addEventListener('abort', () => calls.push('aborted'))
    expect(read).toBe(1)
    const reason = new Error('client gone')
    controller.abort(reason)
    expect(calls).toEqual(['aborted'])
    expect(abort.aborted).toBe(true)
    expect(abort.reason).toBe(reason)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('aborts at once when the followed signal is already aborted', () => {
    const abort = new DeferredAbort()
    abort.follow(() => AbortSignal.abort('gone'))
    const calls: string[] = []
    abort.addEventListener('abort', () => calls.push('aborted'))
    expect(calls).toEqual(['aborted'])
    expect(abort.reason).toBe('gone')
  })
})
