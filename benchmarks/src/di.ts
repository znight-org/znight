/**
 * Dependency injection alone, without HTTP: N providers created by Znight (container generated at
 * build time), NestJS, tsyringe and InversifyJS (containers built at runtime from decorator
 * metadata). Every project is compiled by `tsc` to one module per class, so module loading is the
 * same for all; Znight's decorators are kept (no-op markers) instead of stripped by the Vite plugin.
 */
import type { CompileResult, DiFramework, DiResult, DiSettings, Suite } from './results.ts'
import type { Runtime } from './variants.ts'

import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

import { rotate } from './boot.ts'
import { DEPENDENCIES, LAYERS, writeProject } from './di-project.ts'
import { environment } from './environment.ts'
import { runtimeBinary } from './process.ts'
import { summarize } from './stats.ts'

export const DI_FRAMEWORKS: readonly DiFramework[] = ['znight', 'nestjs', 'tsyringe', 'inversify']

const ROOT = join(import.meta.dir, '..')
const WORK = join(ROOT, '.work/di')
const TSC = join(ROOT, 'node_modules/.bin/tsc')
const COMPILE = join(import.meta.dir, 'di-compile.ts')

export interface DiOptions {
  readonly runtimes: readonly Runtime[]
  readonly sizes: readonly number[]
  readonly runs: number
  readonly compileRuns: number
  readonly log: (message: string) => void
}

interface Project {
  readonly framework: DiFramework
  readonly size: number
  readonly dir: string
}

/** Runs the container generation in a fresh Node.js process; returns its duration. */
function compile(dir: string): number {
  const output = execFileSync(runtimeBinary('node'), [COMPILE, dir], { encoding: 'utf8' })
  return (JSON.parse(output) as { generateMs: number }).generateMs
}

interface Sample {
  readonly importMs: number
  readonly containerMs: number
  readonly processMs: number
}

async function measure(project: Project, runtime: Runtime): Promise<Sample> {
  const started = performance.now()
  const child = Bun.spawn([runtimeBinary(runtime), join(project.dir, 'dist/main.js')], {
    cwd: project.dir,
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
  const processMs = performance.now() - started
  if (code !== 0) throw new Error(`${project.framework}-${project.size} on ${runtime} exited with ${code}:\n${stderr}`)
  const result = JSON.parse(stdout) as { importMs: number; containerMs: number; created: number }
  if (result.created !== project.size) {
    throw new Error(`${project.framework}-${project.size} created ${result.created} providers`)
  }
  return { importMs: result.importMs, containerMs: result.containerMs, processMs }
}

export async function diSuite(options: DiOptions): Promise<Suite<DiSettings, DiResult> & { compile: CompileResult[] }> {
  const projects: Project[] = []
  for (const size of options.sizes) {
    for (const framework of DI_FRAMEWORKS) {
      const dir = join(WORK, `${framework}-${size}`)
      writeProject(dir, framework, size)
      if (framework === 'znight') compile(dir)
      execFileSync(TSC, ['-p', dir], { stdio: 'inherit' })
      projects.push({ framework, size, dir })
    }
  }
  options.log(`di: ${projects.length} projects built`)

  const compileResults: CompileResult[] = []
  for (const size of options.sizes) {
    const dir = join(WORK, `znight-${size}`)
    const samples = Array.from({ length: options.compileRuns }, () => compile(dir))
    compileResults.push({ providers: size, runtime: 'node', generateMs: summarize(samples, 1) })
  }
  options.log('di: compile times measured')

  const samples = new Map<string, Sample[]>()
  const key = (project: Project, runtime: Runtime): string => `${project.framework}-${project.size}@${runtime}`
  // One discarded run of each project: the file system cache is warm for every measured run
  for (const runtime of options.runtimes) for (const project of projects) await measure(project, runtime)
  for (let run = 0; run < options.runs; run++) {
    for (const runtime of rotate(options.runtimes, run)) {
      for (const project of rotate(projects, run)) {
        const list = samples.get(key(project, runtime)) ?? []
        list.push(await measure(project, runtime))
        samples.set(key(project, runtime), list)
      }
    }
    options.log(`di: run ${run + 1}/${options.runs}`)
  }

  const results: DiResult[] = []
  for (const runtime of options.runtimes) {
    for (const project of projects) {
      const list = samples.get(key(project, runtime)) ?? []
      results.push({
        framework: project.framework,
        providers: project.size,
        runtime,
        containerMs: summarize(list.map(s => s.containerMs)),
        importMs: summarize(list.map(s => s.importMs)),
        processMs: summarize(
          list.map(s => s.processMs),
          1,
        ),
      })
    }
  }
  return {
    environment: environment(),
    settings: { runs: options.runs, sizes: options.sizes, layers: LAYERS, dependenciesPerProvider: DEPENDENCIES },
    results,
    compile: compileResults,
  }
}
