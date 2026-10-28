import type { ProbeResult } from '../../src/monitors/monitor.js'

/** API keys used by the tests. */
export const ADMIN_KEY = 'test-admin-key'
export const READER_KEY = 'test-reader-key'

/** Request headers of the two roles. */
export const admin = { 'x-api-key': ADMIN_KEY }
export const reader = { 'x-api-key': READER_KEY }

/** What `T` looks like once sent as JSON: dates are ISO strings. */
export type Json<T> = T extends Date
  ? string
  : T extends readonly (infer U)[]
    ? Json<U>[]
    : T extends object
      ? { readonly [K in keyof T]: Json<T[K]> }
      : T

/** A monitored service (never contacted: the tests replace the prober). */
export const TARGET = 'https://status.example.com/health'

/** A probe result, for unit tests. */
export function aResult(fields: Partial<ProbeResult> = {}): ProbeResult {
  return {
    id: 1,
    monitorId: 1,
    scheduledAt: new Date('2027-01-04T09:00:00Z'),
    checkedAt: new Date('2027-01-04T09:00:00Z'),
    up: true,
    status: 200,
    latencyMs: 12,
    error: null,
    ...fields,
  }
}
