/**
 * The driver conformance suite (`describeDriverConformance()` of `@znight/graphql/testing`, RFC 0009
 * §12) for the built-in transport and the Yoga driver, on every adapter, on Bun. `node.test.ts`
 * runs the same suite with `node:test` on Node.js.
 */
import { describeDriverConformance } from '../../src/testing.ts'
import { yogaDriver } from '../../src/yoga.ts'
import { ADAPTERS } from './adapters.ts'
import { afterAll, beforeAll, describe, it } from 'bun:test'

const test = { describe, it, beforeAll, afterAll }

describeDriverConformance({ driver: () => undefined, test, adapters: ADAPTERS })
describeDriverConformance({ driver: () => yogaDriver(), test, adapters: ADAPTERS })
