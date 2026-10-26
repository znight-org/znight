/**
 * Golden test (architecture §3.3 and §4.1): the generated module of every example application is
 * byte-identical whether the `@znight/*` packages are used from their sources (`@znight/source`
 * condition: the compiler, its extensions and the analysed declarations) or from their build
 * (`dist`), on Node.js and on Bun, in `build` and `serve` modes.
 *
 * Opt-in (`ZNIGHT_E2E=1`) and requires `bun run build` (the `dist` variants load the built
 * packages). Example roots that do not exist yet (no `src/`) are skipped.
 */
import type { CompiledExample } from './support/compile-example.ts'

import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { beforeAll, describe, expect, test as it } from 'bun:test'

const enabled = process.env['ZNIGHT_E2E'] === '1'

const REPO = resolve(import.meta.dir, '..')
const SCRIPT = join(import.meta.dir, 'support/compile-example.ts')
const SOURCE = '--conditions=@znight/source'
const TIMEOUT = 180_000

/** Example applications: the standalone examples and every service of the monorepo example. */
function exampleRoots(): string[] {
  const roots = ['examples/rest-api', 'examples/microservice', 'examples/worker']
  const services = join(REPO, 'examples/monorepo/services')
  if (existsSync(services)) {
    for (const name of readdirSync(services).sort()) roots.push(`examples/monorepo/services/${name}`)
  }
  return roots
}

const roots = exampleRoots().map(root => ({ root, present: existsSync(join(REPO, root, 'src')) }))

interface Runtime {
  readonly name: 'bun' | 'node'
  readonly executable: string
}

const runtimes: Runtime[] = [{ name: 'bun', executable: process.execPath }]
const node = Bun.which('node')
if (node !== null) runtimes.push({ name: 'node', executable: node })

type Variant = 'source' | 'dist'
const VARIANTS: readonly Variant[] = ['source', 'dist']

/** Compiles `root` in a child process. */
function compileExample(runtime: Runtime, variant: Variant, root: string): Promise<CompiledExample> {
  const args = [...(variant === 'source' ? [SOURCE] : []), SCRIPT, root, variant]
  return new Promise((resolvePromise, reject) => {
    const child = spawn(runtime.executable, args, {
      cwd: REPO,
      env: { ...process.env, NO_COLOR: '1', NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`${runtime.name} ${args.join(' ')} exited with code ${code}:\n${stderr}`))
        return
      }
      try {
        resolvePromise(JSON.parse(stdout) as CompiledExample)
      } catch {
        reject(new Error(`${runtime.name} ${args.join(' ')} printed invalid JSON:\n${stdout}\n${stderr}`))
      }
    })
  })
}

/** The first line where `a` and `b` differ, for readable failures. */
function firstDifference(a: string, b: string): string | undefined {
  if (a === b) return undefined
  const left = a.split('\n')
  const right = b.split('\n')
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    if (left[index] !== right[index]) {
      return `line ${index + 1}:\n  - ${left[index] ?? '<end of file>'}\n  + ${right[index] ?? '<end of file>'}`
    }
  }
  return 'same lines, different line endings'
}

describe.skipIf(!enabled)('golden: generated modules with and without @znight/source (ZNIGHT_E2E=1)', () => {
  beforeAll(() => {
    const missing = ['compiler', 'core', 'http', 'messaging', 'config'].filter(
      name => !existsSync(join(REPO, 'packages', name, 'dist')),
    )
    if (missing.length > 0) {
      throw new Error(`run "bun run build" first: no dist for ${missing.map(name => `@znight/${name}`).join(', ')}`)
    }
  })

  it.each(roots.map(({ root, present }) => [root, present] as const))(
    '%s',
    async (root, present) => {
      if (!present) {
        console.warn(`[golden] ${root} does not exist yet: skipped`)
        return
      }
      const runs = runtimes.flatMap(runtime => VARIANTS.map(variant => ({ runtime, variant })))
      const results = await Promise.all(
        runs.map(async run => ({ ...run, result: await compileExample(run.runtime, run.variant, root) })),
      )
      for (const { runtime, variant, result } of results) {
        // the variant really loaded the compiler it names
        const entry = relative(REPO, result.compiler)
        expect(entry).toBe(variant === 'source' ? 'packages/compiler/src/index.ts' : 'packages/compiler/dist/index.mjs')
        for (const [mode, compiled] of Object.entries(result.modes)) {
          if (!compiled.ok) {
            throw new Error(`${root} (${runtime.name}, ${variant}, ${mode}) does not compile:\n${compiled.diagnostics}`)
          }
        }
      }
      const [reference, ...others] = results
      if (reference === undefined) throw new Error('no compile result')
      for (const mode of Object.keys(reference.result.modes)) {
        const expected = reference.result.modes[mode]?.code ?? ''
        expect(expected).toContain('export const __ZNIGHT_METADATA__')
        for (const other of others) {
          const difference = firstDifference(expected, other.result.modes[mode]?.code ?? '')
          const label = `${mode}: ${reference.runtime.name}/${reference.variant} vs ${other.runtime.name}/${other.variant}`
          expect(difference === undefined ? label : `${label}, ${difference}`).toBe(label)
        }
      }
    },
    TIMEOUT,
  )
})
