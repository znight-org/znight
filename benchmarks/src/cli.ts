/**
 * The benchmark runner: `bun src/cli.ts <build | boot | http | di | all> [options]`.
 *
 * - `build`: builds the applications (the `@znight/*` packages must be built: `bun run build`).
 * - `boot`, `http`, `di`: runs a suite and stores it in `results/results.json` (other suites kept).
 * - `all`: builds, then runs every suite.
 *
 * Options: `--runtimes node,bun`, `--variants znight-fastify,nestjs-fastify`, `--quick` (a few
 * short runs, to check the setup; results are written to `results/quick.json`).
 */
import type { Endpoint, Results } from './results.ts'
import type { Runtime, Variant } from './variants.ts'

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { bootSuite } from './boot.ts'
import { diSuite } from './di.ts'
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
const variants: readonly Variant[] =
  values.variants === undefined ? VARIANTS : VARIANTS.filter(v => values.variants?.split(',').includes(v.id))
const file = quick ? join(import.meta.dir, '../results/quick.json') : RESULTS_FILE
const log = (message: string): void => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`)

function build(): void {
  if (!existsSync(join(ROOT, 'packages/http/dist/index.mjs'))) {
    throw new Error('Build the @znight/* packages first: bun run build (at the repository root)')
  }
  for (const app of ['znight', 'nestjs', 'baseline']) {
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
  case 'all':
    build()
    await boot()
    await di()
    await http()
    break
  default:
    throw new Error(`Unknown command '${command}': build, boot, http, di or all`)
}
