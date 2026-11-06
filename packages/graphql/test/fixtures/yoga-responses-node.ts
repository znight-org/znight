/**
 * Run by `drivers/node.test.ts` with `node --test` on Node.js 24: how the Yoga driver sends Yoga's
 * responses (made by the `@whatwg-node` ponyfills on Node.js) on every adapter.
 */
import { after, before, describe, it } from 'node:test'

import { ADAPTERS } from '../drivers/adapters.ts'
import { describeYogaResponses } from '../support/yoga-responses.ts'

describeYogaResponses({ describe, it, beforeAll: before, afterAll: after }, ADAPTERS)
