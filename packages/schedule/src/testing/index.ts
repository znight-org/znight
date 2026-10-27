/**
 * `@znight/schedule/testing`: a virtual clock, job contexts for unit tests, and the conformance
 * scenarios of lock stores (RFC 0004 §4.8).
 */
export { createTestClock, type TestClock } from './clock.ts'
export { createJobContext, type JobContextInit, type TestJobContext } from './context.ts'
export { type LockStoreScenario, lockStoreScenarios } from './scenarios.ts'
