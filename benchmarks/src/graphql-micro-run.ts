/**
 * One in-process GraphQL measurement, in a fresh process of the runtime under test (no HTTP), the
 * informative targets of RFC 0005 §8.12. Prints its result as JSON on the last line of stdout.
 *
 * - `print`: the SDL of the generated 200-type schema, as Znight builds it;
 * - `schema-znight`: `Application.create()` with `GraphQLPlugin` (`http: false`) on the generated
 *   metadata (the metadata checked, the schema built from data, the resolvers wired), in ms;
 * - `schema-sdl <file>`: graphql-js `buildSchema()` of that SDL, in ms;
 * - `execute <rounds> <iterations>`: a cached 50-field query (10 resolver-backed root fields of 5
 *   fields each) through graphql-js `execute()` on the plugin's schema with a pre-parsed document,
 *   through `GraphQLPlugin.execute()` (document cache, context, formatting) and through
 *   `GraphQLEngine.execute()` (what drivers call), outside any scope and inside a request scope;
 *   median nanoseconds per operation of interleaved rounds.
 *
 * The metadata is written by hand in the shape the compiler generates (`metadata.extensions.graphql`,
 * specification §3.3 and RFC 0005 §7): the measurement starts from what a built application loads.
 */
import type { CoreLogger, ExternalDefinition, ZnightMetadata } from '@znight/core'
import type {
  GraphQLFieldDefinition,
  GraphQLMetadata,
  GraphQLResolverBinding,
  GraphQLTypeDefinition,
} from '@znight/graphql'
import type { DocumentNode } from 'graphql'

import { readFileSync } from 'node:fs'
import { Application } from '@znight/core'
import { GRAPHQL_METADATA_VERSION, GraphQLPlugin } from '@znight/graphql'
import { buildSchema, execute, parse } from 'graphql'

/** Object types of the generated schema (plus `Query`). */
const SCHEMA_TYPES = 200
/** Root fields of the executed query; each selects 5 fields (itself and 4 scalars): 50 fields. */
const ROOT_FIELDS = 10
const QUERY_FIELDS = ROOT_FIELDS * 5

const TOKEN = 'bench#Root'
const EXTERNALS: readonly ExternalDefinition[] = [
  { token: '@znight/graphql#GraphQLContext', scope: 'request', providedBy: 'GraphQLPlugin' },
  { token: '@znight/graphql#PubSub', providedBy: 'GraphQLPlugin' },
  { token: '@znight/graphql#GraphQLPlugin', providedBy: 'GraphQLPlugin' },
]
const silent: CoreLogger = { debug() {}, info() {}, warn() {}, error() {} }

const ITEM = { id: '1', name: 'Item', count: 7, score: 4.5, active: true }
const BOOK = { id: '1', title: 'Dune', year: 1965, rating: 4.5 }

class Root {
  item(): typeof ITEM {
    return ITEM
  }
  book(): typeof BOOK {
    return BOOK
  }
}

function binding(method: 'item' | 'book'): GraphQLResolverBinding {
  return {
    token: TOKEN,
    method,
    operation: 'query',
    guards: [],
    meta: {},
    invoke: (resolver: Root) => resolver[method](),
  }
}

function metadata(types: readonly GraphQLTypeDefinition[]): ZnightMetadata {
  const section: GraphQLMetadata = {
    version: GRAPHQL_METADATA_VERSION,
    schemaHash: '0123456789abcdef',
    roots: { query: 'Query' },
    types: types.toSorted((a, b) => (a.name < b.name ? -1 : 1)),
  }
  return {
    version: 1,
    providers: { [TOKEN]: { scope: 'singleton', class: Root, deps: [], factory: () => new Root() } },
    resolutionOrder: [TOKEN],
    externals: EXTERNALS,
    extensions: { graphql: section },
  }
}

const typeName = (index: number): string => `Type${String(index).padStart(3, '0')}`

/** 200 object types of 6 fields, each linked to the next, and one root field per type. */
function schemaTypes(): GraphQLTypeDefinition[] {
  const types: GraphQLTypeDefinition[] = Array.from({ length: SCHEMA_TYPES }, (_, index) => ({
    kind: 'object',
    name: typeName(index),
    fields: [
      { name: 'id', type: 'ID!' },
      { name: 'name', type: 'String!' },
      { name: 'count', type: 'Int!' },
      { name: 'score', type: 'Float' },
      { name: 'active', type: 'Boolean!' },
      { name: 'next', type: typeName((index + 1) % SCHEMA_TYPES) },
    ],
  }))
  const roots: GraphQLFieldDefinition[] = Array.from({ length: SCHEMA_TYPES }, (_, index) => ({
    name: `type${String(index).padStart(3, '0')}`,
    type: typeName(index),
    args: [{ name: 'id', type: 'ID!' }],
    resolver: binding('item'),
  }))
  return [...types, { kind: 'object', name: 'Query', fields: roots }]
}

function executeTypes(): GraphQLTypeDefinition[] {
  return [
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
      fields: Array.from({ length: ROOT_FIELDS }, (_, index) => ({
        name: `b${index}`,
        type: 'Book',
        resolver: binding('book'),
      })),
    },
  ]
}

async function boot(types: readonly GraphQLTypeDefinition[]): Promise<{ app: Application; plugin: GraphQLPlugin }> {
  const plugin = GraphQLPlugin.configure({ http: false })
  const app = await Application.create({
    metadata: metadata(types),
    plugins: [plugin],
    logger: silent,
    shutdown: { signals: false },
  })
  return { app, plugin }
}

const print = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

async function schemaZnight(): Promise<void> {
  const types = schemaTypes()
  const started = performance.now()
  const { app } = await boot(types)
  const ms = performance.now() - started
  await app.stop()
  print({ ms, types: SCHEMA_TYPES })
}

function schemaSdl(file: string): void {
  const sdl = readFileSync(file, 'utf8')
  const started = performance.now()
  const schema = buildSchema(sdl)
  const ms = performance.now() - started
  if (Object.keys(schema.getTypeMap()).filter(name => name.startsWith('Type')).length !== SCHEMA_TYPES) {
    throw new Error('buildSchema() did not build every type')
  }
  print({ ms, types: SCHEMA_TYPES })
}

async function printSdl(): Promise<void> {
  const { app, plugin } = await boot(schemaTypes())
  const sdl = plugin.printSchema()
  await app.stop()
  print({ sdl })
}

type Case = readonly [name: 'graphql-js' | 'plugin' | 'engine', run: () => unknown]

function measure(run: () => unknown, iterations: number): number {
  const started = performance.now()
  for (let index = 0; index < iterations; index++) run()
  return ((performance.now() - started) * 1e6) / iterations
}

const median = (values: readonly number[]): number =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN

/** Interleaved rounds (the same noise for every case), then the median of each case. */
function rounds(cases: readonly Case[], count: number, iterations: number): Record<string, number> {
  for (const [, run] of cases) measure(run, iterations)
  const samples = new Map<string, number[]>(cases.map(([name]) => [name, []]))
  for (let index = 0; index < count; index++) {
    for (const [name, run] of cases) samples.get(name)?.push(measure(run, iterations))
  }
  return Object.fromEntries([...samples].map(([name, values]) => [name, median(values)]))
}

async function executeOverhead(count: number, iterations: number): Promise<void> {
  const { app, plugin } = await boot(executeTypes())
  const query = `{ ${Array.from({ length: ROOT_FIELDS }, (_, index) => `b${index} { id title year rating }`).join(' ')} }`
  const schema = plugin.schema
  const parsed: DocumentNode = parse(query)
  const engine = plugin.engine
  const document = engine.parse(query)
  const invalid = engine.validate(engine.schema, document)
  if (invalid.length > 0) throw new Error(`Invalid query: ${invalid.map(error => error.message).join(', ')}`)

  const cases: Case[] = [
    ['graphql-js', () => execute({ schema, document: parsed, contextValue: {} })],
    ['plugin', () => plugin.execute({ query })],
    ['engine', () => engine.execute({ schema: engine.schema, document })],
  ]
  // the same data from every path, synchronously: a promise would make the loop measure nothing
  const check = (): void => {
    const expected = JSON.stringify(
      (execute({ schema, document: parsed, contextValue: {} }) as { data?: unknown }).data,
    )
    for (const [name, run] of cases) {
      const result = run()
      if (result instanceof Promise) throw new Error(`${name} is not synchronous`)
      const data = JSON.stringify((result as { data?: unknown; errors?: unknown }).data)
      if (data !== expected || (result as { errors?: unknown }).errors !== undefined) {
        throw new Error(`${name} returned ${JSON.stringify(result)}`)
      }
    }
  }
  check()
  const direct = rounds(cases, count, iterations)
  // what GraphQL over HTTP does: the request scope exists already
  const request = await app.container.runInScope(() => {
    check()
    return rounds(cases, count, iterations)
  })
  await app.stop()
  print({ fields: QUERY_FIELDS, direct, request })
}

const [mode, first, second] = process.argv.slice(2)
switch (mode) {
  case 'print':
    await printSdl()
    break
  case 'schema-znight':
    await schemaZnight()
    break
  case 'schema-sdl':
    if (first === undefined) throw new Error('Usage: graphql-micro-run.ts schema-sdl <file>')
    schemaSdl(first)
    break
  case 'execute':
    await executeOverhead(Number(first ?? 7), Number(second ?? 20_000))
    break
  default:
    throw new Error(`Unknown mode '${mode}': print, schema-znight, schema-sdl or execute`)
}
