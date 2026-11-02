/**
 * Non-gating micro-benchmark of the per-operation overhead of the plugin (RFC 0005 §8.12): a cached
 * 50-field query (10 resolver-backed root fields, 4 plain fields each) through
 * `GraphQLPlugin.execute()`, against graphql-js `execute()` on the same schema with a pre-parsed
 * document. Target: overhead under 10 %.
 *
 * Run with `bun test/bench/execute.bench.ts` or
 * `node --conditions=@znight/source test/bench/execute.bench.ts` (from packages/graphql).
 */
import type { GraphQLTypeDefinition } from '../../src/index.ts'

import { execute, parse } from 'graphql'

import { executorOf } from '../../src/plugin.ts'
import { bind, boot, field, graphqlMetadata } from '../support/app.ts'

const ROOT_FIELDS = 10
const BOOK = { id: '1', title: 'Dune', year: 1965, rating: 4.5 }

class Books {
  book(): typeof BOOK {
    return BOOK
  }
}

const types: GraphQLTypeDefinition[] = [
  {
    kind: 'object',
    name: 'Book',
    fields: [
      { name: 'id', type: 'ID!' },
      { name: 'title', type: 'String!' },
      { name: 'year', type: 'Int' },
      { name: 'rating', type: 'Float' },
    ],
  },
  {
    kind: 'object',
    name: 'Query',
    fields: Array.from({ length: ROOT_FIELDS }, (_, index) =>
      field(`b${index}`, 'Book', bind(Books, 'book', { invoke: (r: Books) => r.book() })),
    ),
  },
]

const query = `{ ${Array.from({ length: ROOT_FIELDS }, (_, index) => `b${index} { id title year rating }`).join(' ')} }`

await using booted = await boot(graphqlMetadata({ providers: [Books], types }))
const plugin = booted.plugin
const schema = plugin.schema
const document = parse(query)
const executor = executorOf(plugin)

type Case = readonly [name: string, run: () => unknown]

const bare = (): unknown => execute({ schema, document, contextValue: {} })
const cases: Case[] = [
  ['graphql-js execute (pre-parsed)', bare],
  ['plugin.execute()', () => plugin.execute({ query })],
  ['executor.execute() (transport API)', () => executor.execute({ query })],
  // what passing HttpContext.signal costs: an AbortController and a graphql-js abort listener per operation
  ['executor.execute() with a new signal', () => executor.execute({ query }, { signal: new AbortController().signal })],
]

// sanity: same data, synchronous
const expected = JSON.stringify(bare())
for (const [name, run] of cases) {
  const result = run() as { data?: unknown; result?: { data?: unknown } }
  if (result instanceof Promise) throw new Error(`${name} is not synchronous`)
  const data = JSON.stringify('result' in result ? result.result : result)
  if (data !== expected) throw new Error(`${name} returned ${data}`)
}

function measure(run: () => unknown, iterations: number): number {
  const start = performance.now()
  for (let index = 0; index < iterations; index++) run()
  return ((performance.now() - start) * 1e6) / iterations
}

const ITERATIONS = 20_000
const ROUNDS = 7
for (const [, run] of cases) measure(run, ITERATIONS)

const median = (values: readonly number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0

/** Interleaved rounds (the same machine noise for every case), median per case. */
function run(list: readonly Case[]): Map<string, number> {
  for (const [, fn] of list) measure(fn, ITERATIONS)
  const samples = new Map<string, number[]>(list.map(([name]) => [name, []]))
  for (let round = 0; round < ROUNDS; round++) {
    for (const [name, fn] of list) samples.get(name)?.push(measure(fn, ITERATIONS))
  }
  return new Map([...samples].map(([name, values]) => [name, median(values)]))
}

function report(title: string, results: ReadonlyMap<string, number>): void {
  const baseline = results.get(cases[0]?.[0] ?? '') ?? 0
  console.log(title)
  for (const [name, ns] of results) {
    const overhead = ((ns - baseline) / baseline) * 100
    console.log(
      `  ${name.padEnd(42)} ${(ns / 1000).toFixed(2).padStart(7)} µs/op  ${overhead >= 0 ? '+' : ''}${overhead.toFixed(1)} %`,
    )
  }
}

const runtime = typeof Bun === 'undefined' ? `Node.js ${process.version}` : `Bun ${Bun.version}`
console.log(`${runtime}, ${ROOT_FIELDS * 5}-field query, median of ${ROUNDS} x ${ITERATIONS} operations`)
report('outside of a request scope (direct executions: the plugin opens one)', run(cases))
// what GraphQL over HTTP does: the request scope exists already
const scoped = await booted.app.container.runInScope(() => run(cases))
report('inside a request scope (GraphQL over HTTP, a controller calling execute())', scoped)
