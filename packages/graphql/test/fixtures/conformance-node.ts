/**
 * Run by `drivers/node.test.ts` with `node --test` on Node.js 24: the driver conformance suite with
 * `node:test`'s `describe` / `it` / `before` / `after`, for the built-in transport and the Yoga
 * driver, on every adapter.
 */
import { after, before, describe, it } from 'node:test'

import { describeDriverConformance } from '../../src/testing.ts'
import { yogaDriver } from '../../src/yoga.ts'
import { ADAPTERS } from '../drivers/adapters.ts'

const test = { describe, it, beforeAll: before, afterAll: after }

describeDriverConformance({ driver: () => undefined, test, adapters: ADAPTERS })
describeDriverConformance({ driver: () => yogaDriver(), test, adapters: ADAPTERS })
