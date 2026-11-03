/**
 * Non-gating micro-benchmark of result mappers (errors as data, RFC 0008): what a field pays for
 * them. A cached query of 10 resolver-backed root fields through `GraphQLPlugin.execute()` (each
 * execution opens its scope), on applications booted with and without `resultMappers`:
 *
 * - plain fields (`Book`) with result mappers configured: no wrapper, so the same cost as without;
 * - union fields (`BookResult = Book | NotFoundRejection`), synchronous and asynchronous resolvers,
 *   without error: the wrapper's cost (one call frame, one rejection handler for a promise);
 * - the same fields failing: the error as a value, against the error in `errors[]` without mappers.
 *
 * Run with `bun --conditions=@znight/source test/bench/results.bench.ts` or
 * `node --conditions=@znight/source test/bench/results.bench.ts` (from packages/graphql).
 */
import type { GraphQLPluginOptions, GraphQLResultMapper, GraphQLTypeDefinition } from '../../src/index.ts'

import { Application } from '@znight/core'

import { GraphQLPlugin } from '../../src/index.ts'
import { bind, field, graphqlMetadata } from '../support/app.ts'

const ROOT_FIELDS = 10
const BOOK = { __typename: 'Book', id: '1', title: 'Dune' }

class NotFound extends Error {}

class Books {
  book(): typeof BOOK {
    return BOOK
  }
  async bookAsync(): Promise<typeof BOOK> {
    await Promise.resolve()
    return BOOK
  }
  missing(): never {
    throw new NotFound('No book')
  }
}

class Rejections implements GraphQLResultMapper {
  static readonly types = ['NotFoundRejection']
  toResult(error: unknown): unknown {
    return error instanceof NotFound ? { __typename: 'NotFoundRejection', message: error.message } : undefined
  }
}

const fields = (prefix: string, type: string, method: keyof Books) =>
  Array.from({ length: ROOT_FIELDS }, (_, index) =>
    field(`${prefix}${index}`, type, bind(Books, method, { invoke: (r: Books) => r[method]() })),
  )

const types: GraphQLTypeDefinition[] = [
  {
    kind: 'object',
    name: 'Book',
    fields: [
      { name: 'id', type: 'ID!' },
      { name: 'title', type: 'String!' },
    ],
  },
  { kind: 'object', name: 'NotFoundRejection', fields: [{ name: 'message', type: 'String!' }] },
  {
    kind: 'union',
    name: 'BookResult',
    members: ['Book', 'NotFoundRejection'],
    discriminator: { by: 'typename' },
  },
  {
    kind: 'object',
    name: 'Query',
    fields: [
      ...fields('p', 'Book', 'book'),
      ...fields('u', 'BookResult', 'book'),
      ...fields('a', 'BookResult', 'bookAsync'),
      ...fields('m', 'BookResult', 'missing'),
    ],
  },
]

const selection = (prefix: string, inner: string): string =>
  `{ ${Array.from({ length: ROOT_FIELDS }, (_, index) => `${prefix}${index} { ${inner} }`).join(' ')} }`
const PLAIN = selection('p', 'id title')
const UNION = '__typename ... on Book { id title } ... on NotFoundRejection { message }'

/** The failing cases log every error: a logger that keeps nothing (the test one keeps every entry). */
const noop = (): void => {}
const logger = { debug: noop, info: noop, warn: noop, error: noop }

async function app(options: GraphQLPluginOptions) {
  const plugin = GraphQLPlugin.configure({ http: false, ...options })
  const application = await Application.create({
    metadata: graphqlMetadata({ providers: [Books, Rejections], types }),
    plugins: [plugin],
    logger,
    shutdown: { signals: false },
  })
  return { plugin, [Symbol.asyncDispose]: () => application.stop() }
}

await using without = await app({})
await using withMappers = await app({ resultMappers: [Rejections] })

type Case = readonly [name: string, run: () => unknown]
const execute = (booted: typeof without, query: string) => () => booted.plugin.execute({ query })

const syncCases: Case[] = [
  ['plain fields, no result mappers', execute(without, PLAIN)],
  ['plain fields, result mappers configured', execute(withMappers, PLAIN)],
  ['union fields, no result mappers', execute(without, selection('u', UNION))],
  ['union fields, result mappers (wrapped)', execute(withMappers, selection('u', UNION))],
  ['failing fields, errors[] (no mappers)', execute(without, selection('m', UNION))],
  ['failing fields, values (result mappers)', execute(withMappers, selection('m', UNION))],
]
const asyncCases: Case[] = [
  ['async union fields, no result mappers', execute(without, selection('a', UNION))],
  ['async union fields, result mappers (wrapped)', execute(withMappers, selection('a', UNION))],
]

// sanity: the failing fields are values with mappers, errors without; synchronous cases stay synchronous
const values = withMappers.plugin.execute({ query: selection('m', UNION) }) as { data?: Record<string, unknown> }
if (JSON.stringify(values.data?.['m0']) !== '{"__typename":"NotFoundRejection","message":"No book"}') {
  throw new Error(`unexpected result ${JSON.stringify(values)}`)
}
for (const [name, run] of syncCases) if (run() instanceof Promise) throw new Error(`${name} is not synchronous`)

function measureSync(run: () => unknown, iterations: number): number {
  const start = performance.now()
  for (let index = 0; index < iterations; index++) run()
  return ((performance.now() - start) * 1e6) / iterations
}

async function measureAsync(run: () => unknown, iterations: number): Promise<number> {
  const start = performance.now()
  for (let index = 0; index < iterations; index++) await run()
  return ((performance.now() - start) * 1e6) / iterations
}

const ITERATIONS = 5_000
const ROUNDS = 21

/**
 * Warm-up, then interleaved rounds: the fastest round per case, in ns (the round least disturbed by
 * the rest of the machine; the differences measured here are smaller than its noise).
 */
async function bench(list: readonly Case[], measure: (run: () => unknown, n: number) => number | Promise<number>) {
  for (const [, run] of list) await measure(run, ITERATIONS)
  const samples = new Map<string, number[]>(list.map(([name]) => [name, []]))
  for (let round = 0; round < ROUNDS; round++) {
    for (const [name, run] of list) samples.get(name)?.push(await measure(run, ITERATIONS))
  }
  return new Map([...samples].map(([name, values]) => [name, Math.min(...values)]))
}

const runtime = typeof Bun === 'undefined' ? `Node.js ${process.version}` : `Bun ${Bun.version}`
console.log(
  `${runtime}: ${ROOT_FIELDS} resolver-backed root fields per query, fastest of ${ROUNDS} rounds x ${ITERATIONS} operations`,
)
const results = [...(await bench(syncCases, measureSync)), ...(await bench(asyncCases, measureAsync))]
for (const [name, ns] of results) console.log(`  ${name.padEnd(46)} ${(ns / 1000).toFixed(2).padStart(7)} µs/op`)
