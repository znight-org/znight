/** The results file (`benchmarks/results/results.json`): what was measured, where, and with what. */
import type { Summary } from './stats.ts'
import type { Adapter, Framework, Runtime } from './variants.ts'

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const RESULTS_FILE: string = join(import.meta.dir, '../results/results.json')

export interface Environment {
  readonly date: string
  readonly commit: string
  readonly machine: string
  readonly cpus: number
  readonly memoryGiB: number
  readonly os: string
  readonly runtimes: Readonly<Record<Runtime, string>>
  /** Versions of the frameworks and libraries under test. */
  readonly packages: Readonly<Record<string, string>>
}

export interface BootSettings {
  readonly runs: number
  /** Idle time between the first response and the memory sample. */
  readonly idleMs: number
}

export interface BootResult {
  readonly variant: string
  readonly framework: Framework
  readonly adapter: Adapter
  readonly runtime: Runtime
  /** Spawn to first `200` of `GET /users/1`, in milliseconds. */
  readonly readyMs: Summary
  /** Resident set size once idle, in MiB. */
  readonly rssMiB: Summary
}

export interface HttpSettings {
  readonly tool: string
  readonly connections: number
  readonly pipelining: number
  readonly warmupSeconds: number
  readonly durationSeconds: number
  readonly rounds: number
}

export type Endpoint = 'get' | 'post'

/**
 * One measured round. autocannon records latencies in whole milliseconds: below one millisecond its
 * mean and median say little, so only the 99th percentile is kept.
 */
export interface HttpRound {
  readonly requestsPerSecond: number
  readonly latencyP99Ms: number
}

export interface HttpResult {
  readonly variant: string
  readonly framework: Framework
  readonly adapter: Adapter
  readonly runtime: Runtime
  readonly endpoint: Endpoint
  readonly rounds: readonly HttpRound[]
  readonly requestsPerSecond: Summary
  readonly latencyP99Ms: Summary
}

export type DiFramework = 'znight' | 'nestjs' | 'tsyringe' | 'inversify'

export interface DiSettings {
  readonly runs: number
  readonly sizes: readonly number[]
  /** Layers of the generated graph; a provider depends on providers of the layer below. */
  readonly layers: number
  readonly dependenciesPerProvider: number
}

export interface DiResult {
  readonly framework: DiFramework
  readonly providers: number
  readonly runtime: Runtime
  /** Container created and every provider instantiated, after the imports (in-process). */
  readonly containerMs: Summary
  /** Imports of the framework and of the provider modules (in-process). */
  readonly importMs: Summary
  /** Spawn to exit of the whole process, in milliseconds. */
  readonly processMs: Summary
}

export interface CompileResult {
  readonly providers: number
  readonly runtime: Runtime
  /** `generate()`: scan, parse, analyse, bind, validate and write the container module. */
  readonly generateMs: Summary
}

/** A suite of measurements, run together on one machine. */
export interface Suite<Settings, Result> {
  readonly environment: Environment
  readonly settings: Settings
  readonly results: readonly Result[]
}

/** Each suite can be run (and updated) on its own: it records its own environment. */
export interface Results {
  readonly version: 1
  readonly boot?: Suite<BootSettings, BootResult>
  readonly http?: Suite<HttpSettings, HttpResult>
  readonly di?: Suite<DiSettings, DiResult> & { readonly compile: readonly CompileResult[] }
}

export function readResults(file: string = RESULTS_FILE): Results | undefined {
  if (!existsSync(file)) return undefined
  return JSON.parse(readFileSync(file, 'utf8')) as Results
}

/** JSON laid out like Biome formats it: two spaces, short arrays of numbers or strings on one line. */
export function toJson(value: unknown): string {
  const json = JSON.stringify(value, null, 2).replace(
    /\[\n\s*([^[\]{}]*?)\n\s*\]/g,
    (_, items: string) => `[${items.split(/,\n\s*/).join(', ')}]`,
  )
  return `${json}\n`
}

export function writeResults(results: Results, file: string = RESULTS_FILE): void {
  writeFileSync(file, toJson(results))
}
