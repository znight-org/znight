/**
 * Smoke test of the packed tarballs, installed the way users install the packages from npm: in a
 * directory outside the workspace, with npm or Bun, with the `@znight` registry blocked so that
 * every `@znight/*` package comes from a tarball.
 *
 * For each package manager:
 *   1. install `@znight/cli` from its tarball and scaffold an application with `znight new`;
 *   2. point the application's `@znight/*` dependencies (and `overrides`) at the tarballs, install;
 *   3. `znight generate`, `tsc --noEmit` (the published types), `znight build` (Vite);
 *   4. run `dist/main.js` on Node.js and on Bun, request `GET /health` and `GET /greetings/:name`,
 *      stop with SIGTERM and expect exit code 0.
 *
 *   bun run build && bun scripts/release/smoke.ts           # npm and Bun
 *   bun scripts/release/smoke.ts --pm npm                   # one package manager (CI matrix)
 *   bun scripts/release/smoke.ts --tarballs <dir> --keep    # packed tarballs, keep the app
 */
import type { ChildProcess } from 'node:child_process'

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { log, main, runOrThrow, summary } from './support.ts'
import { packAndVerify, reportPacked, tarballName } from './tarball.ts'
import { lockstepVersion, publishablePackages } from './workspace.ts'

type PackageManager = 'npm' | 'bun'
type Runtime = 'node' | 'bun'

const PACKAGE_MANAGERS: readonly PackageManager[] = ['npm', 'bun']
const RUNTIMES: readonly Runtime[] = ['node', 'bun']
/** Nothing listens there: an attempt to download a `@znight/*` package fails at once. */
const BLOCKED_REGISTRY = 'http://127.0.0.1:9/'
const STARTUP_TIMEOUT = 30_000

type Json = Record<string, unknown>

interface Context {
  readonly version: string
  /** `file:` specifier of every package tarball, by package name. */
  readonly specs: Readonly<Record<string, string>>
}

const readJson = (path: string): Json => JSON.parse(readFileSync(path, 'utf8')) as Json
const writeJson = (path: string, value: unknown): void => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)

/** Blocks the `@znight` scope on the registry (both npm and Bun read `.npmrc`). */
function blockZnightRegistry(dir: string): void {
  appendFileSync(join(dir, '.npmrc'), `@znight:registry=${BLOCKED_REGISTRY}\n`)
}

async function install(pm: PackageManager, dir: string): Promise<void> {
  const args = pm === 'npm' ? ['install', '--no-audit', '--no-fund', '--loglevel=error'] : ['install']
  await runOrThrow(pm === 'npm' ? 'npm' : process.execPath, args, {
    cwd: dir,
    env: { npm_config_update_notifier: 'false' },
  })
}

/** Points every `@znight/*` dependency of a manifest at its tarball and overrides transitive ones. */
function useTarballs(manifest: Json, context: Context): Json {
  const rewrite = (field: string): Record<string, string> | undefined => {
    const dependencies = manifest[field] as Record<string, string> | undefined
    if (dependencies === undefined) return undefined
    return Object.fromEntries(
      Object.entries(dependencies).map(([name, range]) => {
        if (!name.startsWith('@znight/')) return [name, range]
        const spec = context.specs[name]
        if (spec === undefined) throw new Error(`the scaffolded app depends on ${name}, which has no tarball`)
        return [name, spec]
      }),
    )
  }
  return {
    ...manifest,
    dependencies: rewrite('dependencies'),
    devDependencies: rewrite('devDependencies'),
    // the tarballs depend on each other at exact versions that are not on the registry (yet)
    overrides: { ...context.specs },
  }
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (typeof address === 'object' && address !== null) resolvePort(address.port)
        else reject(new Error('no port'))
      })
    })
  })
}

/** Fetches `url` once the server answers; fails early when the process exits. */
async function fetchWhenUp(url: string, child: ChildProcess): Promise<Response> {
  const started = Date.now()
  while (Date.now() - started < STARTUP_TIMEOUT) {
    if (child.exitCode !== null)
      throw new Error(`the application exited (code ${child.exitCode}) before ${url} answered`)
    try {
      return await fetch(url, { signal: AbortSignal.timeout(5000) })
    } catch {
      await Bun.sleep(250)
    }
  }
  throw new Error(`${url} did not answer within ${STARTUP_TIMEOUT / 1000}s`)
}

/** Runs the built application on `runtime` and checks it over HTTP. */
async function serve(app: string, runtime: Runtime): Promise<void> {
  const port = await freePort()
  const command = runtime === 'node' ? 'node' : process.execPath
  const child = spawn(command, ['dist/main.js'], {
    cwd: app,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'production', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  const exited = new Promise<number | null>(resolveExit => child.once('exit', code => resolveExit(code)))
  const base = `http://127.0.0.1:${port}`
  try {
    const health = await fetchWhenUp(`${base}/health`, child)
    if (health.status !== 200) throw new Error(`GET /health answered ${health.status}`)
    const greeting = await fetch(`${base}/greetings/Smoke`)
    const body = (await greeting.json()) as { message?: unknown }
    if (greeting.status !== 200 || typeof body.message !== 'string' || !body.message.includes('Smoke')) {
      throw new Error(`GET /greetings/Smoke answered ${greeting.status} ${JSON.stringify(body)}`)
    }
    log.info(`    ✔ ${runtime}: GET /health → 200, GET /greetings/Smoke → "${body.message}"`)
  } catch (error) {
    child.kill('SIGKILL')
    throw new Error(`${runtime} dist/main.js: ${String(error)}\n--- output ---\n${output}`)
  }
  child.kill('SIGTERM')
  const code = await Promise.race([exited, Bun.sleep(15_000).then(() => 'timeout' as const)])
  if (code === 'timeout') {
    child.kill('SIGKILL')
    throw new Error(`${runtime} dist/main.js did not stop within 15s after SIGTERM\n--- output ---\n${output}`)
  }
  if (code !== 0)
    throw new Error(`${runtime} dist/main.js exited with code ${code} after SIGTERM\n--- output ---\n${output}`)
  log.info(`    ✔ ${runtime}: graceful shutdown (exit code 0)`)
}

async function smoke(pm: PackageManager, work: string, context: Context): Promise<void> {
  const dir = join(work, pm)
  const runner = join(dir, 'cli')
  const app = join(dir, 'smoke-app')
  mkdirSync(runner, { recursive: true })

  log.step(`[${pm}] install @znight/cli from its tarball, znight new`)
  const cliSpec = context.specs['@znight/cli']
  if (cliSpec === undefined) throw new Error('no tarball for @znight/cli')
  writeJson(join(runner, 'package.json'), {
    name: 'znight-smoke-cli',
    private: true,
    dependencies: { '@znight/cli': cliSpec },
    overrides: { ...context.specs },
  })
  blockZnightRegistry(runner)
  await install(pm, runner)
  const cli = join(runner, 'node_modules/.bin/znight')
  const reported = (await runOrThrow(cli, ['--version'], { env: { NO_COLOR: '1' } })).stdout.trim()
  if (!reported.includes(context.version)) throw new Error(`znight --version printed "${reported}"`)
  await runOrThrow(
    cli,
    ['new', 'smoke-app', '--yes', '--pm', pm, '--adapter', 'node', '--no-install', '--no-git', '--dir', app],
    { cwd: dir, env: { NO_COLOR: '1' } },
  )
  log.info(`    ✔ znight ${reported} scaffolded ${app}`)

  log.step(`[${pm}] install the application`)
  writeJson(join(app, 'package.json'), useTarballs(readJson(join(app, 'package.json')), context))
  blockZnightRegistry(app)
  await install(pm, app)
  const manifest = readJson(join(app, 'package.json'))
  for (const field of ['dependencies', 'devDependencies']) {
    for (const name of Object.keys((manifest[field] as Record<string, string> | undefined) ?? {})) {
      if (!name.startsWith('@znight/')) continue
      const installed = readJson(join(app, 'node_modules', name, 'package.json'))
      if (installed['version'] !== context.version) {
        throw new Error(`${name}: installed ${String(installed['version'])}, expected ${context.version}`)
      }
    }
  }
  log.info(`    ✔ @znight/* ${context.version} installed from the tarballs`)

  const bin = join(app, 'node_modules/.bin')
  for (const [label, command, args] of [
    ['znight generate', join(bin, 'znight'), ['generate']],
    ['tsc --noEmit', join(bin, 'tsc'), ['--noEmit']],
    ['znight build', join(bin, 'znight'), ['build']],
  ] as const) {
    log.step(`[${pm}] ${label}`)
    const result = await runOrThrow(command, [...args], { cwd: app, env: { NO_COLOR: '1' } })
    log.block(label, `${result.stdout}${result.stderr}`)
  }
  if (!existsSync(join(app, 'dist/main.js'))) throw new Error('znight build did not write dist/main.js')

  log.step(`[${pm}] run dist/main.js`)
  for (const runtime of RUNTIMES) await serve(app, runtime)
}

main(async () => {
  const { values } = parseArgs({
    options: {
      pm: { type: 'string', multiple: true },
      tarballs: { type: 'string' },
      keep: { type: 'boolean', default: false },
    },
  })
  const pms = (values.pm ?? PACKAGE_MANAGERS) as PackageManager[]
  for (const pm of pms) if (!PACKAGE_MANAGERS.includes(pm)) throw new Error(`--pm must be npm or bun (got ${pm})`)

  const nodeVersion = (await runOrThrow('node', ['--version'])).stdout.trim()
  if (Number(nodeVersion.replace(/^v/, '').split('.')[0]) < 24)
    throw new Error(`Node.js >= 24 is required, found ${nodeVersion}`)
  log.info(`Node.js ${nodeVersion}, Bun ${Bun.version}, npm ${(await runOrThrow('npm', ['--version'])).stdout.trim()}`)

  const packages = publishablePackages()
  const version = lockstepVersion(packages)
  const work = mkdtempSync(join(process.env['RUNNER_TEMP'] ?? tmpdir(), 'znight-smoke-'))
  try {
    let tarballDir = values.tarballs === undefined ? undefined : resolve(values.tarballs)
    if (tarballDir === undefined) {
      tarballDir = join(work, 'tarballs')
      log.step(`Packing ${packages.length} packages`)
      const errors = reportPacked(await packAndVerify(packages, tarballDir, { missingReadme: 'warning' }))
      if (errors > 0) throw new Error(`${errors} problem(s) found in the tarballs`)
    }
    const specs: Record<string, string> = {}
    for (const pkg of packages) {
      const tarball = join(tarballDir, tarballName(pkg))
      if (!existsSync(tarball)) throw new Error(`missing tarball ${tarball}`)
      specs[pkg.name] = `file:${tarball}`
    }
    for (const pm of pms) await smoke(pm, work, { version, specs })
    log.info(`\nSmoke test passed (${pms.join(', ')}; Node.js and Bun). ${values.keep ? `Kept in ${work}` : ''}`)
    summary(
      `### Smoke test passed\n\nPackage managers: ${pms.join(', ')}. Runtimes: Node.js ${nodeVersion}, Bun ${Bun.version}.\n`,
    )
  } finally {
    if (!values.keep) rmSync(work, { recursive: true, force: true })
  }
})
