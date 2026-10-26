/**
 * End-to-end test of a scaffolded application (opt-in: `ZNIGHT_CLI_E2E=1`, it takes ~30 s):
 *
 * znight new → znight g → znight generate (--check) → tsc --noEmit → znight build (the `znight()`
 * Vite plugin) → znight start + HTTP requests → bun test (the `@znight/compiler/bun` preload,
 * TestBed / TestApp) → znight dev (restart on change, last good process kept on a compile error).
 *
 * The application is created under `test/.tmp/` and its `node_modules` links the workspace packages,
 * which are loaded from their TypeScript sources (`@znight/source` condition, also passed to tsc).
 * The CLI runs on Bun (the compiler then loads the compiler extensions from their sources), Vite
 * loads its config natively (`--config-loader native`, so that the condition applies), and the
 * application runs on Node.js (`NODE_OPTIONS=--conditions=@znight/source`).
 *
 * Set `ZNIGHT_CLI_E2E_KEEP=1` to keep the application for inspection.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'

import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

const enabled = process.env['ZNIGHT_CLI_E2E'] === '1'

const CLI_ROOT = resolve(import.meta.dir, '..')
const REPO = resolve(CLI_ROOT, '../..')
const CLI = join(CLI_ROOT, 'src/cli.ts')
/** The CLI built by `bun run build` (its tests run only when it exists). */
const BUILT_CLI = join(CLI_ROOT, 'dist/cli.mjs')
const APP = join(CLI_ROOT, 'test/.tmp', `e2e-${process.pid}`)
const SOURCE = '--conditions=@znight/source'
const TIMEOUT = 180_000

interface Result {
  readonly code: number | null
  readonly output: string
}

/** Runs a command to completion; output = stdout + stderr. */
function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<Result> {
  return new Promise(resolvePromise => {
    const child = spawn(command, [...args], {
      cwd: options.cwd ?? APP,
      env: { ...process.env, NO_COLOR: '1', ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', chunk => {
      output += chunk
    })
    child.stderr.on('data', chunk => {
      output += chunk
    })
    child.on('error', error => resolvePromise({ code: null, output: `${output}\n${error.message}` }))
    child.on('close', code => resolvePromise({ code, output }))
  })
}

/** `znight <args>` on Bun, the CLI and the workspace packages loaded from their sources. */
function znight(args: readonly string[], env: Record<string, string> = {}): Promise<Result> {
  return run('bun', [SOURCE, CLI, ...args], { env: { NODE_OPTIONS: SOURCE, ...env } })
}

interface LongRunning {
  readonly child: ChildProcess
  output(): string
  readonly exit: Promise<number | null>
}

/** A long-running `znight <args>` process. */
function startZnight(args: readonly string[], env: Record<string, string>): LongRunning {
  const child = spawn('bun', [SOURCE, CLI, ...args], {
    cwd: APP,
    env: { ...process.env, NO_COLOR: '1', NODE_OPTIONS: SOURCE, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout?.on('data', chunk => {
    output += chunk
  })
  child.stderr?.on('data', chunk => {
    output += chunk
  })
  const exit = new Promise<number | null>(resolvePromise => child.once('exit', code => resolvePromise(code)))
  return { child, output: () => output, exit }
}

function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => (typeof address === 'object' && address !== null ? resolvePromise(address.port) : reject()))
    })
  })
}

/** Fetches `url` once the server answers; fails early when `process` exits. */
async function fetchWhenUp(url: string, process: LongRunning, timeoutMs = 60_000): Promise<Response> {
  const started = Date.now()
  let exited = false
  void process.exit.then(() => {
    exited = true
  })
  while (Date.now() - started < timeoutMs) {
    if (exited) throw new Error(`the process exited before ${url} answered`)
    try {
      return await fetch(url)
    } catch {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 200))
    }
  }
  throw new Error(`${url} did not answer within ${timeoutMs}ms`)
}

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1
}

/** Waits until `process` printed `needle` (`count` times). */
async function waitForOutput(process: LongRunning, needle: string, count = 1, timeoutMs = 60_000): Promise<void> {
  const started = Date.now()
  while (countOf(process.output(), needle) < count) {
    if (Date.now() - started > timeoutMs) throw new Error(`"${needle}" was not printed within ${timeoutMs}ms`)
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
}

/** Links a package into the application's `node_modules`. */
function link(name: string, target: string): void {
  const path = join(APP, 'node_modules', name)
  mkdirSync(dirname(path), { recursive: true })
  symlinkSync(realpathSync(target), path, 'dir')
}

const packageDirectory = (name: string, from: string): string =>
  dirname(createRequire(join(from, 'package.json')).resolve(`${name}/package.json`))

/** Fails with the command output when it did not succeed. */
function expectSuccess(result: Result, step: string): void {
  if (result.code !== 0) throw new Error(`${step} failed (exit code ${result.code}):\n${result.output}`)
}

const VITE_CONFIG = 'vite.e2e.config.ts'
const WORKSPACE_PACKAGES = ['cli', 'compiler', 'config', 'core', 'http', 'messaging', 'observability', 'testing']

describe.skipIf(!enabled)('scaffolded application (ZNIGHT_CLI_E2E=1)', () => {
  beforeAll(async () => {
    rmSync(APP, { recursive: true, force: true })
    mkdirSync(dirname(APP), { recursive: true })
    const created = await run(
      'bun',
      [
        SOURCE,
        CLI,
        'new',
        'e2e-app',
        '--yes',
        '--pm',
        'bun',
        '--features',
        'all',
        '--no-install',
        '--no-git',
        '--dir',
        APP,
      ],
      { cwd: dirname(APP) },
    )
    expectSuccess(created, 'znight new')
    for (const name of WORKSPACE_PACKAGES) {
      link(`@znight/${name}`, join(REPO, 'packages', name))
    }
    link('zod', packageDirectory('zod', join(REPO, 'packages/http')))
    link('vite', packageDirectory('vite', CLI_ROOT))
    // tsc resolves the workspace packages to their sources, like the tests of the repository
    const tsconfig = readFileSync(join(APP, 'tsconfig.json'), 'utf8').replace(
      '"noEmit": true',
      '"noEmit": true,\n    "customConditions": ["@znight/source"]',
    )
    writeFileSync(join(APP, 'tsconfig.json'), tsconfig)
    // the linked workspace packages stay external in the bundle (like dependencies installed from npm)
    const external = `ssr: { external: ${JSON.stringify([...WORKSPACE_PACKAGES.map(name => `@znight/${name}`), 'zod'])} }`
    writeFileSync(
      join(APP, VITE_CONFIG),
      `import { mergeConfig } from 'vite'\nimport base from './vite.config.ts'\n\nexport default mergeConfig(base, { ${external} })\n`,
    )
  }, TIMEOUT)

  afterAll(() => {
    if (process.env['ZNIGHT_CLI_E2E_KEEP'] !== '1') rmSync(APP, { recursive: true, force: true })
  })

  it('znight g adds a provider', async () => {
    const result = await znight(['g', 'service', 'audit/audit'])
    expectSuccess(result, 'znight g')
    expect(existsSync(join(APP, 'src/audit/audit.service.ts'))).toBe(true)
  })

  it(
    'znight generate writes the container, --check confirms it',
    async () => {
      const generated = await znight(['generate', '--config-loader', 'native'])
      expectSuccess(generated, 'znight generate')
      const container = readFileSync(join(APP, 'src/.znight/container.generated.ts'), 'utf8')
      expect(container).toContain('GreetingController')
      expect(container).toContain('GreetingConsumer')
      expect(container).toContain('AuditService')
      expectSuccess(await znight(['generate', '--check', '--config-loader', 'native']), 'znight generate --check')
    },
    TIMEOUT,
  )

  it(
    'type-checks with tsc --noEmit',
    async () => {
      const result = await run('node', [join(REPO, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', APP])
      expectSuccess(result, 'tsc')
      expect(result.output).toBe('')
    },
    TIMEOUT,
  )

  it(
    'znight build bundles the application',
    async () => {
      expectSuccess(await znight(['build', '--config', VITE_CONFIG, '--config-loader', 'native']), 'znight build')
      expect(existsSync(join(APP, 'dist/main.js'))).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'znight start serves HTTP requests and stops on SIGTERM',
    async () => {
      const port = await freePort()
      const app = startZnight(['start', '--runtime', 'node'], { PORT: String(port), LOG_LEVEL: 'warn' })
      const base = `http://127.0.0.1:${port}`
      const post = (path: string, body: unknown): Promise<Response> =>
        fetch(`${base}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      try {
        const health = await fetchWhenUp(`${base}/health`, app)
        expect(health.status).toBe(200)
        expect(await health.json()).toMatchObject({ status: 'ok' })
        const greeting = await fetch(`${base}/greetings/Ada?excited=true`)
        expect(await greeting.json()).toEqual({ message: 'Hello, Ada!' })
        expect((await post('/greetings', { name: 'Grace' })).status).toBe(201)
        expect((await post('/greetings', { name: '' })).status).toBe(400)
        expect((await post('/greetings/async', { name: 'Grace' })).status).toBe(202)
      } catch (error) {
        throw new Error(`${String(error)}\n--- znight start output ---\n${app.output()}`)
      } finally {
        app.child.kill('SIGTERM')
      }
      expect(await app.exit).toBe(0)
    },
    TIMEOUT,
  )

  it(
    'the build also runs on Bun',
    async () => {
      const port = await freePort()
      const child = spawn('bun', [SOURCE, 'dist/main.js'], {
        cwd: APP,
        env: { ...process.env, NO_COLOR: '1', PORT: String(port), LOG_LEVEL: 'warn' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      child.stdout.on('data', chunk => {
        output += chunk
      })
      child.stderr.on('data', chunk => {
        output += chunk
      })
      const app: LongRunning = {
        child,
        output: () => output,
        exit: new Promise(resolvePromise => child.once('exit', code => resolvePromise(code))),
      }
      try {
        const greeting = await fetchWhenUp(`http://127.0.0.1:${port}/greetings/Ada`, app)
        expect(await greeting.json()).toEqual({ message: 'Hello, Ada.' })
      } catch (error) {
        throw new Error(`${String(error)}\n--- bun dist/main.js output ---\n${app.output()}`)
      } finally {
        child.kill('SIGTERM')
      }
      expect(await app.exit).toBe(0)
    },
    TIMEOUT,
  )

  it.skipIf(!existsSync(BUILT_CLI))(
    'the built CLI runs on Node.js (bun run build)',
    async () => {
      expectSuccess(await run('node', [BUILT_CLI, 'generate']), 'node znight generate')
      expectSuccess(
        await run('node', [BUILT_CLI, 'build', '--config', VITE_CONFIG, '--config-loader', 'native']),
        'node znight build',
      )
      expect(existsSync(join(APP, 'dist/main.js'))).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'runs the generated tests with bun test (TestBed, TestApp)',
    async () => {
      // the preload regenerates the container (bunfig.toml): it does not need to exist
      rmSync(join(APP, 'src/.znight'), { recursive: true, force: true })
      const result = await run('bun', ['test', SOURCE])
      expectSuccess(result, 'bun test')
      expect(result.output).toMatch(/\b4 pass\b/)
      expect(result.output).toMatch(/\b0 fail\b/)
      expect(existsSync(join(APP, 'src/.znight/container.generated.ts'))).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'znight dev restarts the application after a change',
    async () => {
      const port = await freePort()
      const dev = startZnight(['dev', '--config', VITE_CONFIG, '--config-loader', 'native', '--runtime', 'node'], {
        PORT: String(port),
        LOG_LEVEL: 'warn',
      })
      const url = `http://127.0.0.1:${port}/greetings/Ada`
      try {
        expect((await fetchWhenUp(url, dev)).status).toBe(200)
        const file = join(APP, 'src/app/app.config.ts')
        writeFileSync(file, readFileSync(file, 'utf8').replace("greeting = 'Hello'", "greeting = 'Salut'"))
        const started = Date.now()
        let message = ''
        while (Date.now() - started < 60_000 && message !== 'Salut, Ada.') {
          await new Promise(resolvePromise => setTimeout(resolvePromise, 300))
          try {
            message = ((await (await fetch(url)).json()) as { message: string }).message
          } catch {
            // restarting
          }
        }
        expect(message).toBe('Salut, Ada.')
        expect(dev.output()).toContain('Restarted')

        // a compile error (missing provider): the build succeeds with a throwing generated module,
        // znight dev keeps the last good process instead of restarting into a crash
        const service = join(APP, 'src/app/greeting.service.ts')
        const original = readFileSync(service, 'utf8')
        writeFileSync(
          join(APP, 'src/app/clock.ts'),
          'export class Clock {\n  now(): number {\n    return Date.now()\n  }\n}\n',
        )
        writeFileSync(
          service,
          original
            .replace(
              "import { AppConfig } from './app.config.js'",
              "import { AppConfig } from './app.config.js'\nimport { Clock } from './clock.js'",
            )
            .replace(
              '    private readonly logger: Logger,',
              '    private readonly logger: Logger,\n    private readonly clock: Clock,',
            ),
        )
        await waitForOutput(dev, 'Compilation failed with 1 error')
        expect(dev.output()).toContain("ZNIGHT001: Missing provider for 'Clock' required by GreetingService")
        expect(dev.output()).toContain('The last good build keeps running')
        const restarts = countOf(dev.output(), 'Restarted')
        expect(((await (await fetch(url)).json()) as { message: string }).message).toBe('Salut, Ada.')

        writeFileSync(service, original)
        await waitForOutput(dev, 'Restarted', restarts + 1)
        expect((await fetchWhenUp(url, dev)).status).toBe(200)
      } catch (error) {
        throw new Error(`${String(error)}\n--- znight dev output ---\n${dev.output()}`)
      } finally {
        dev.child.kill('SIGINT')
      }
      expect(await dev.exit).toBe(0)
    },
    TIMEOUT,
  )
})
