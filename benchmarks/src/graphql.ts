/**
 * GraphQL throughput and latency under load, with the method of the HTTP suite: autocannon run by
 * Node.js in its own process (`graphql-load.ts`); for each round, each application is started, its
 * three operations checked once, then each operation warmed up and measured, and the application
 * stopped. Every response of a load test is checked (`200`, no `errors`, the expected data): one
 * failure fails the run.
 */
import type { GraphqlOperation } from './graphql-operations.ts'
import type { GraphqlVariant } from './graphql-variants.ts'
import type { GraphqlResult, GraphqlSkipped, HttpRound, HttpSettings, Suite } from './results.ts'
import type { Runtime } from './variants.ts'

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

import { rotate } from './boot.ts'
import { environment, GRAPHQL_PACKAGES, packageDir } from './environment.ts'
import { OPERATION_SPECS } from './graphql-operations.ts'
import { GRAPHQL_ENDPOINT, unsupportedReason } from './graphql-variants.ts'
import { runtimeBinary, start, stop } from './process.ts'
import { round, summarize } from './stats.ts'

const LOAD = join(import.meta.dir, 'graphql-load.ts')
const BENCHMARKS = join(import.meta.dir, '..')

export interface GraphqlOptions {
  readonly variants: readonly GraphqlVariant[]
  readonly runtimes: readonly Runtime[]
  readonly operations: readonly GraphqlOperation[]
  readonly connections: number
  readonly warmupSeconds: number
  readonly durationSeconds: number
  readonly rounds: number
  readonly log: (message: string) => void
}

const JSON_HEADERS = { 'content-type': 'application/json' } as const

interface LoadResult {
  readonly requests: { readonly average: number }
  readonly latency: { readonly p99: number }
  readonly errors: number
  readonly timeouts: number
  readonly non2xx: number
  readonly mismatches: number
  /** The first body that failed the check. */
  readonly rejected?: string
}

async function load(
  port: number,
  operation: GraphqlOperation,
  seconds: number,
  connections: number,
): Promise<LoadResult> {
  const url = `http://127.0.0.1:${port}${GRAPHQL_ENDPOINT}`
  const child = Bun.spawn([runtimeBinary('node'), LOAD, url, operation, String(seconds), String(connections)], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`graphql-load exited with code ${code}:\n${stderr}`)
  return JSON.parse(stdout) as LoadResult
}

/** One request of each operation: `200`, `application/json` and the expected data, before any load. */
async function check(
  variant: GraphqlVariant,
  runtime: Runtime,
  port: number,
  operation: GraphqlOperation,
): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}${GRAPHQL_ENDPOINT}`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: OPERATION_SPECS[operation].body,
  })
  const body = await response.text()
  const type = response.headers.get('content-type') ?? ''
  if (response.status !== 200 || !type.startsWith('application/json') || !OPERATION_SPECS[operation].verify(body)) {
    throw new Error(`${variant.id} on ${runtime}, ${operation}: ${response.status} ${type}\n${body.slice(0, 500)}`)
  }
}

interface Manifest {
  readonly dependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
}

const manifestOf = (dir: string): Manifest => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest

/**
 * Every copy of `graphql` that code in `root` can load: `root` and each package of its dependency
 * tree (dependencies and installed peers, followed through their real directories, as Node.js and
 * Bun resolve them) that depends on `graphql` resolve it from where they are. Maps each copy to the
 * packages that load it.
 */
function graphqlCopies(root: string): Map<string, Set<string>> {
  const copies = new Map<string, Set<string>>()
  const seen = new Set<string>()
  const queue: [dir: string, label: string][] = [[realpathSync(root), root]]
  for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
    const [dir, label] = item
    if (seen.has(dir)) continue
    seen.add(dir)
    const manifest = manifestOf(dir)
    const names = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ])
    for (const name of names) {
      let found: string
      try {
        found = packageDir(name, dir)
      } catch {
        continue // an optional peer that is not installed
      }
      if (name === 'graphql') {
        copies.set(found, (copies.get(found) ?? new Set()).add(label))
      } else {
        queue.push([found, name])
      }
    }
  }
  return copies
}

/**
 * Every application, every package they load, and the in-process suite load the same copy of
 * graphql-js, and the workspace installs only one.
 */
export function checkGraphqlCopies(variants: readonly GraphqlVariant[]): string {
  const copies = new Map<string, Set<string>>()
  for (const dir of new Set([BENCHMARKS, ...variants.map(v => v.dir)])) {
    for (const [copy, users] of graphqlCopies(dir)) copies.set(copy, new Set([...(copies.get(copy) ?? []), ...users]))
  }
  const store = join(BENCHMARKS, '..', 'node_modules', '.bun')
  const installed = existsSync(store) ? readdirSync(store).filter(entry => entry.startsWith('graphql@')) : []
  if (copies.size !== 1 || installed.length > 1) {
    const lines = [...copies].map(([copy, users]) => `${copy}: ${[...users].join(', ')}`)
    throw new Error(
      `The applications load different copies of graphql:\n${lines.join('\n')}\ninstalled: ${installed.join(', ')}`,
    )
  }
  const [copy] = copies.keys()
  return copy ?? ''
}

/**
 * The batching invariant of the contract, checked once per application and runtime, outside the
 * measured runs: started with `BENCH_COUNT_FIND_MANY=1`, the users repository writes one stderr
 * line per `findMany()` call, and one `books` request makes exactly one.
 */
async function checkBatching(variant: GraphqlVariant, runtime: Runtime): Promise<void> {
  const { child, port } = await start({
    runtime,
    cwd: variant.dir,
    entry: variant.entry,
    env: { ...variant.env, BENCH_COUNT_FIND_MANY: '1' },
    probe: GRAPHQL_ENDPOINT,
    probeRequest: { method: 'POST', headers: JSON_HEADERS, body: OPERATION_SPECS.user.body },
  })
  let stderr = ''
  try {
    await check(variant, runtime, port, 'books')
  } finally {
    await stop(child)
    stderr = await new Response(child.stderr).text()
  }
  const calls = stderr.split('\n').filter(line => line === 'findMany').length
  if (calls !== 1) {
    throw new Error(`${variant.id} on ${runtime}: one books request made ${calls} users.findMany() calls, not 1`)
  }
}

export async function graphqlSuite(
  options: GraphqlOptions,
): Promise<Suite<HttpSettings, GraphqlResult> & { skipped: GraphqlSkipped[] }> {
  checkGraphqlCopies(options.variants)
  const skipped: GraphqlSkipped[] = []
  for (const runtime of options.runtimes) {
    for (const variant of options.variants) {
      const reason = unsupportedReason(variant, runtime)
      if (reason === undefined) {
        await checkBatching(variant, runtime)
      } else {
        skipped.push({ variant: variant.id, runtime, reason })
      }
    }
  }

  const rounds = new Map<string, HttpRound[]>()
  const key = (variant: GraphqlVariant, runtime: Runtime, operation: GraphqlOperation): string =>
    `${variant.id}@${runtime}#${operation}`

  for (let index = 0; index < options.rounds; index++) {
    for (const runtime of rotate(options.runtimes, index)) {
      for (const variant of rotate(options.variants, index)) {
        if (unsupportedReason(variant, runtime) !== undefined) continue
        const { child, port } = await start({
          runtime,
          cwd: variant.dir,
          entry: variant.entry,
          env: variant.env,
          probe: GRAPHQL_ENDPOINT,
          probeRequest: { method: 'POST', headers: JSON_HEADERS, body: OPERATION_SPECS.user.body },
        })
        try {
          for (const operation of options.operations) await check(variant, runtime, port, operation)
          for (const operation of options.operations) {
            await load(port, operation, options.warmupSeconds, options.connections)
            const result = await load(port, operation, options.durationSeconds, options.connections)
            const failures = result.errors + result.timeouts + result.non2xx + result.mismatches
            if (failures > 0) {
              throw new Error(
                `${variant.id} on ${runtime}, ${operation}: ${result.errors} errors, ${result.timeouts} timeouts, ${result.non2xx} non-2xx responses, ${result.mismatches} unexpected bodies${result.rejected === undefined ? '' : `\nfirst one: ${result.rejected}`}`,
              )
            }
            const list = rounds.get(key(variant, runtime, operation)) ?? []
            list.push({ requestsPerSecond: round(result.requests.average, 0), latencyP99Ms: result.latency.p99 })
            rounds.set(key(variant, runtime, operation), list)
            options.log(
              `graphql: round ${index + 1}/${options.rounds} ${variant.id} on ${runtime}, ${operation}: ${Math.round(result.requests.average)} req/s`,
            )
          }
        } finally {
          await stop(child)
        }
      }
    }
  }

  const results: GraphqlResult[] = []
  for (const runtime of options.runtimes) {
    for (const variant of options.variants) {
      if (unsupportedReason(variant, runtime) !== undefined) continue
      for (const operation of options.operations) {
        const list = rounds.get(key(variant, runtime, operation)) ?? []
        results.push({
          variant: variant.id,
          framework: variant.framework,
          runtime,
          operation,
          rounds: list,
          requestsPerSecond: summarize(
            list.map(r => r.requestsPerSecond),
            0,
          ),
          latencyP99Ms: summarize(list.map(r => r.latencyP99Ms)),
        })
      }
    }
  }
  return {
    environment: environment(GRAPHQL_PACKAGES),
    settings: {
      tool: 'autocannon',
      connections: options.connections,
      pipelining: 1,
      warmupSeconds: options.warmupSeconds,
      durationSeconds: options.durationSeconds,
      rounds: options.rounds,
    },
    results,
    skipped,
  }
}
