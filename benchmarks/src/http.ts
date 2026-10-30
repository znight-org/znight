/**
 * Throughput and latency under load, with autocannon run by Node.js in its own process: for each
 * round, each application is started, warmed up, then measured on each endpoint, and stopped.
 */
import type { Endpoint, HttpResult, HttpRound, HttpSettings, Suite } from './results.ts'
import type { Runtime, Variant } from './variants.ts'

import { join } from 'node:path'

import { rotate } from './boot.ts'
import { environment } from './environment.ts'
import { runtimeBinary, start, stop } from './process.ts'
import { round, summarize } from './stats.ts'

const AUTOCANNON = join(import.meta.dir, '../node_modules/autocannon/autocannon.js')

export interface HttpOptions {
  readonly variants: readonly Variant[]
  readonly runtimes: readonly Runtime[]
  readonly endpoints: readonly Endpoint[]
  readonly connections: number
  readonly warmupSeconds: number
  readonly durationSeconds: number
  readonly rounds: number
  readonly log: (message: string) => void
}

const CREATE_BODY = JSON.stringify({ name: 'Ada Lovelace', email: 'ada@example.com' })

/** autocannon arguments of an endpoint. */
function requestArguments(endpoint: Endpoint, port: number): string[] {
  const base = `http://127.0.0.1:${port}`
  if (endpoint === 'get') return [`${base}/users/42`]
  return ['-m', 'POST', '-H', 'content-type=application/json', '-b', CREATE_BODY, `${base}/users`]
}

interface AutocannonResult {
  readonly requests: { readonly average: number }
  readonly latency: { readonly p99: number }
  readonly errors: number
  readonly timeouts: number
  readonly non2xx: number
}

async function autocannon(args: readonly string[], seconds: number, connections: number): Promise<AutocannonResult> {
  const child = Bun.spawn(
    [runtimeBinary('node'), AUTOCANNON, '-c', String(connections), '-d', String(seconds), '-j', ...args],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`autocannon exited with code ${code}:\n${stderr}`)
  return JSON.parse(stdout) as AutocannonResult
}

export async function httpSuite(options: HttpOptions): Promise<Suite<HttpSettings, HttpResult>> {
  const rounds = new Map<string, HttpRound[]>()
  const key = (variant: Variant, runtime: Runtime, endpoint: Endpoint): string => `${variant.id}@${runtime}#${endpoint}`

  for (let index = 0; index < options.rounds; index++) {
    for (const runtime of rotate(options.runtimes, index)) {
      for (const variant of rotate(options.variants, index)) {
        const { child, port } = await start({
          runtime,
          cwd: variant.dir,
          entry: variant.entry,
          env: variant.env,
          probe: '/users/1',
        })
        try {
          for (const endpoint of options.endpoints) {
            const args = requestArguments(endpoint, port)
            await autocannon(args, options.warmupSeconds, options.connections)
            const result = await autocannon(args, options.durationSeconds, options.connections)
            if (result.errors > 0 || result.timeouts > 0 || result.non2xx > 0) {
              throw new Error(
                `${variant.id} on ${runtime}, ${endpoint}: ${result.errors} errors, ${result.timeouts} timeouts, ${result.non2xx} non-2xx responses`,
              )
            }
            const list = rounds.get(key(variant, runtime, endpoint)) ?? []
            list.push({
              requestsPerSecond: round(result.requests.average, 0),
              latencyP99Ms: result.latency.p99,
            })
            rounds.set(key(variant, runtime, endpoint), list)
            options.log(
              `http: round ${index + 1}/${options.rounds} ${variant.id} on ${runtime}, ${endpoint}: ${Math.round(result.requests.average)} req/s`,
            )
          }
        } finally {
          await stop(child)
        }
      }
    }
  }

  const results: HttpResult[] = []
  for (const runtime of options.runtimes) {
    for (const variant of options.variants) {
      for (const endpoint of options.endpoints) {
        const list = rounds.get(key(variant, runtime, endpoint)) ?? []
        results.push({
          variant: variant.id,
          framework: variant.framework,
          adapter: variant.adapter,
          runtime,
          endpoint,
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
    environment: environment(),
    settings: {
      tool: 'autocannon',
      connections: options.connections,
      pipelining: 1,
      warmupSeconds: options.warmupSeconds,
      durationSeconds: options.durationSeconds,
      rounds: options.rounds,
    },
    results,
  }
}
