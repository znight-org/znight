/**
 * One autocannon load test of a GraphQL operation, run by Node.js in its own process (like the
 * autocannon CLI of the HTTP suite): `node src/graphql-load.ts <url> <operation> <seconds> <connections>`.
 * Prints autocannon's result as JSON, with the first rejected body if any.
 *
 * Every response body goes through the operation's check (`verifyBody`): a body without the
 * expected data, or with an `errors` key, counts in `mismatches`, and the runner fails the run. The
 * first body is parsed and checked in full; the next ones are compared with it as strings (the
 * operation's `same`), and only a body that differs is parsed: the check costs the client almost
 * nothing, so it does not limit the fastest servers.
 */
import { createRequire } from 'node:module'

import { isGraphqlOperation, OPERATION_SPECS } from './graphql-operations.ts'

type Autocannon = (options: Readonly<Record<string, unknown>>) => Promise<Readonly<Record<string, unknown>>>

// autocannon is CommonJS and ships no types
const autocannon = createRequire(import.meta.url)('autocannon') as Autocannon

const [url, operation, seconds, connections] = process.argv.slice(2)
if (url === undefined || !isGraphqlOperation(operation) || seconds === undefined || connections === undefined) {
  throw new Error('Usage: node src/graphql-load.ts <url> <user|books|createUser> <seconds> <connections>')
}

const spec = OPERATION_SPECS[operation]
let rejected: string | undefined
let same: ((body: string) => boolean) | undefined
const result = await autocannon({
  url,
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: spec.body,
  connections: Number(connections),
  duration: Number(seconds),
  pipelining: 1,
  verifyBody: (body: string): boolean => {
    if (same?.(body) === true) return true
    if (spec.verify(body)) {
      same ??= spec.same(body)
      return true
    }
    rejected ??= body.slice(0, 500)
    return false
  },
})
process.stdout.write(`${JSON.stringify({ ...result, rejected })}\n`)
