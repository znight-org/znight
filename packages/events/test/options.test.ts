/** Validation and defaults of `EventsPlugin.configure()` options. */
import { DEFAULT_DRAIN_TIMEOUT_MS, resolveEventsOptions } from '../src/options.ts'
import { describe, expect, test as it } from 'bun:test'

/** Default `shutdown.hookTimeoutMs` of `Application.create()` (the budget of each shutdown step). */
const CORE_DEFAULT_HOOK_TIMEOUT_MS = 5_000

describe('resolveEventsOptions', () => {
  it('drains within the default per-step shutdown budget of the application', () => {
    expect(DEFAULT_DRAIN_TIMEOUT_MS).toBe(4_000)
    expect(DEFAULT_DRAIN_TIMEOUT_MS).toBeLessThan(CORE_DEFAULT_HOOK_TIMEOUT_MS)
    expect(resolveEventsOptions(undefined).drainTimeoutMs).toBe(DEFAULT_DRAIN_TIMEOUT_MS)
    expect(resolveEventsOptions({}).drainTimeoutMs).toBe(DEFAULT_DRAIN_TIMEOUT_MS)
  })
})
