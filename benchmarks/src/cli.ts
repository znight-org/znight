/**
 * The benchmark runner: `bun src/cli.ts <build | boot | http | di | graphql | all> [options]`.
 *
 * - `build`: builds the applications (the `@znight/*` packages must be built: `bun run build`).
 * - `boot`, `http`, `di`, `graphql`: runs a suite and stores it in `results/results.json` (other
 *   suites kept). `graphql` runs the GraphQL load tests, then the in-process GraphQL measurements.
 * - `all`: builds, then runs every suite.
 *
 * Options: `--runtimes node,bun`, `--variants znight-fastify,nestjs-fastify` (ids of
 * `src/variants.ts` for `boot` and `http`, of `src/graphql-variants.ts` for `graphql`), `--quick`
 * (a few short runs, to check the setup; results are written to `results/quick.json`).
 */
import type { GraphqlVariant } from './graphql-variants.ts'
import type { Endpoint, Results } from './results.ts'
import type { Runtime, Variant } from './variants.ts'

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { bootSuite } from './boot.ts'
import { diSuite } from './di.ts'
import { graphqlSuite } from './graphql.ts'
import { graphqlMicroSuite } from './graphql-micro.ts'
import { GRAPHQL_OPERATIONS } from './graphql-operations.ts'
import { GRAPHQL_VARIANTS } from './graphql-variants.ts'
import { httpSuite } from './http.ts'
import { RESULTS_FILE, readResults, writeResults } from './results.ts'
import { VARIANTS } from './variants.ts'

const ROOT = join(import.meta.dir, '../..')

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    runtimes: { type: 'string', default: 'node,bun' },
    variants: { type: 'string' },
    quick: { type: 'boolean', default: false },
  },
})

const command = positionals[0] ?? 'all'
const quick = values.quick
const runtimes = values.runtimes.split(',') as Runtime[]
const selected = values.variants?.split(',')
const variants: readonly Variant[] = selected === undefined ? VARIANTS : VARIANTS.filter(v => selected.includes(v.id))
const graphqlVariants: readonly GraphqlVariant[] =
  selected === undefined ? GRAPHQL_VARIANTS : GRAPHQL_VARIANTS.filter(v => selected.includes(v.id))
const file = quick ? join(import.meta.dir, '../results/quick.json') : RESULTS_FILE
const log = (message: string): void => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`)

const APPS = ['znight', 'nestjs', 'baseline'] as const
const GRAPHQL_APPS = ['baseline-graphql', 'znight-graphql', 'nestjs-graphql'] as const

function build(apps: readonly string[] = [...APPS, ...GRAPHQL_APPS]): void {
  for (const dist of ['packages/http/dist/index.mjs', 'packages/graphql/dist/index.mjs']) {
    if (!existsSync(join(ROOT, dist))) {
      throw new Error('Build the @znight/* packages first: bun run build (at the repository root)')
    }
  }
  for (const app of apps) {
    log(`build: apps/${app}`)
    execFileSync('bun', ['run', 'build'], { cwd: join(import.meta.dir, '../apps', app), stdio: 'inherit' })
  }
}

function save(update: (results: Results) => Results): void {
  writeResults(update(readResults(file) ?? { version: 1 }), file)
  log(`saved ${file}`)
}

async function boot(): Promise<void> {
  const suite = await bootSuite({ variants, runtimes, runs: quick ? 3 : 30, idleMs: quick ? 100 : 500, log })
  save(results => ({ ...results, boot: suite }))
}

async function http(): Promise<void> {
  const endpoints: readonly Endpoint[] = ['get', 'post']
  const suite = await httpSuite({
    variants,
    runtimes,
    endpoints,
    connections: 100,
    warmupSeconds: quick ? 1 : 3,
    durationSeconds: quick ? 2 : 10,
    rounds: quick ? 1 : 3,
    log,
  })
  save(results => ({ ...results, http: suite }))
}

async function di(): Promise<void> {
  const suite = await diSuite({
    runtimes,
    sizes: [100, 1000],
    runs: quick ? 3 : 30,
    compileRuns: quick ? 2 : 10,
    log,
  })
  save(results => ({ ...results, di: suite }))
}

async function graphql(): Promise<void> {
  const suite = await graphqlSuite({
    variants: graphqlVariants,
    runtimes,
    operations: GRAPHQL_OPERATIONS,
    connections: 100,
    warmupSeconds: quick ? 1 : 3,
    durationSeconds: quick ? 2 : 10,
    rounds: quick ? 1 : 3,
    log,
  })
  const micro = await graphqlMicroSuite({
    runtimes,
    schemaRuns: quick ? 3 : 30,
    executeRuns: quick ? 1 : 5,
    rounds: quick ? 3 : 7,
    iterations: quick ? 2_000 : 20_000,
    log,
  })
  save(results => ({ ...results, graphql: { ...suite, micro } }))
}

switch (command) {
  case 'build':
    build()
    break
  case 'boot':
    await boot()
    break
  case 'http':
    await http()
    break
  case 'di':
    await di()
    break
  case 'graphql':
    await graphql()
    break
  case 'all':
    build()
    await boot()
    await di()
    await http()
    await graphql()
    break
  default:
    throw new Error(`Unknown command '${command}': build, boot, http, di, graphql or all`)
}
