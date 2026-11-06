/**
 * How the Yoga driver sends Yoga's responses on every adapter, on Bun (Yoga on the runtime's own
 * Fetch API). `node.test.ts` runs the same scenarios on Node.js (Yoga on the `@whatwg-node` ponyfills).
 */
import { describeYogaResponses } from '../support/yoga-responses.ts'
import { ADAPTERS } from './adapters.ts'
import { afterAll, beforeAll, describe, it } from 'bun:test'

describeYogaResponses({ describe, it, beforeAll, afterAll }, ADAPTERS)
