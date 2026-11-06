/**
 * The in-process GraphQL measurements (RFC 0005 §8.12, informative targets), each in fresh
 * processes of `graphql-micro-run.ts` on Node.js and Bun:
 *
 * - schema build at boot: Znight from the metadata of a generated 200-type schema, against graphql-js
 *   `buildSchema()` of the same SDL (target: under 20 ms);
 * - per-operation overhead of the plugin on a cached 50-field query, against graphql-js `execute()`
 *   on the same schema (target: under 10%).
 */
import type {
  GraphqlExecutePath,
  GraphqlExecuteResult,
  GraphqlMicro,
  GraphqlSchemaResult,
  GraphqlScope,
} from './results.ts'
import type { Runtime } from './variants.ts'

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { rotate } from './boot.ts'
import { runtimeBinary } from './process.ts'
import { summarize } from './stats.ts'

const ROOT = join(import.meta.dir, '..')
const RUN = join(import.meta.dir, 'graphql-micro-run.ts')
const SDL = join(ROOT, '.work/graphql/schema.graphql')

const SCOPES: readonly GraphqlScope[] = ['direct', 'request']
const PATHS: readonly GraphqlExecutePath[] = ['graphql-js', 'plugin', 'engine']

export interface GraphqlMicroOptions {
  readonly runtimes: readonly Runtime[]
  readonly schemaRuns: number
  readonly executeRuns: number
  readonly rounds: number
  readonly iterations: number
  readonly log: (message: string) => void
}

/** Runs `graphql-micro-run.ts` in a fresh process; returns the JSON of its last line. */
async function run<T>(runtime: Runtime, args: readonly string[]): Promise<T> {
  const child = Bun.spawn([runtimeBinary(runtime), RUN, ...args], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'production' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`graphql-micro-run ${args.join(' ')} on ${runtime} exited with ${code}:\n${stderr}`)
  const last = stdout.trim().split('\n').at(-1) ?? ''
  return JSON.parse(last) as T
}

interface Timing {
  readonly ms: number
  readonly types: number
}

type Medians = Readonly<Record<GraphqlExecutePath, number>>

interface Overhead {
  readonly fields: number
  readonly direct: Medians
  readonly request: Medians
}

export async function graphqlMicroSuite(options: GraphqlMicroOptions): Promise<GraphqlMicro> {
  // the same SDL for graphql-js: the one Znight builds from the generated metadata
  const { sdl } = await run<{ sdl: string }>('node', ['print'])
  mkdirSync(join(ROOT, '.work/graphql'), { recursive: true })
  writeFileSync(SDL, sdl)

  const sides = [
    ['znight', ['schema-znight']],
    ['buildSchema', ['schema-sdl', SDL]],
  ] as const
  const schemaSamples = new Map<string, number[]>()
  let types = 0
  // one discarded process of each: the file system cache is warm for every measured run
  for (const runtime of options.runtimes) for (const [, args] of sides) await run<Timing>(runtime, args)
  for (let index = 0; index < options.schemaRuns; index++) {
    for (const runtime of rotate(options.runtimes, index)) {
      for (const [side, args] of rotate(sides, index)) {
        const timing = await run<Timing>(runtime, args)
        types = timing.types
        const key = `${side}@${runtime}`
        schemaSamples.set(key, [...(schemaSamples.get(key) ?? []), timing.ms])
      }
    }
    options.log(`graphql micro: schema run ${index + 1}/${options.schemaRuns}`)
  }
  const schema: GraphqlSchemaResult[] = options.runtimes.map(runtime => ({
    runtime,
    znightMs: summarize(schemaSamples.get(`znight@${runtime}`) ?? []),
    buildSchemaMs: summarize(schemaSamples.get(`buildSchema@${runtime}`) ?? []),
  }))

  const overheads = new Map<Runtime, Overhead[]>()
  let fields = 0
  for (let index = 0; index < options.executeRuns; index++) {
    for (const runtime of rotate(options.runtimes, index)) {
      const overhead = await run<Overhead>(runtime, ['execute', String(options.rounds), String(options.iterations)])
      fields = overhead.fields
      overheads.set(runtime, [...(overheads.get(runtime) ?? []), overhead])
    }
    options.log(`graphql micro: execute run ${index + 1}/${options.executeRuns}`)
  }
  const execute: GraphqlExecuteResult[] = []
  for (const runtime of options.runtimes) {
    const list = overheads.get(runtime) ?? []
    for (const scope of SCOPES) {
      for (const path of PATHS) {
        execute.push({
          runtime,
          scope,
          path,
          nsPerOp: summarize(
            list.map(o => o[scope][path]),
            0,
          ),
          overheadPercent: summarize(
            list.map(o => (o[scope][path] / o[scope]['graphql-js'] - 1) * 100),
            1,
          ),
        })
      }
    }
  }

  return {
    settings: {
      schemaRuns: options.schemaRuns,
      types,
      executeRuns: options.executeRuns,
      fields,
      rounds: options.rounds,
      iterations: options.iterations,
    },
    schema,
    execute,
  }
}
