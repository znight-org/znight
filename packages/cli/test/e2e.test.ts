/**
 * End-to-end test of a scaffolded application (opt-in: `ZNIGHT_CLI_E2E=1`, it takes ~30 s):
 *
 * znight new → znight g → znight generate (--check) → znight openapi (--check) → tsc --noEmit →
 * znight build --openapi (the `znight()` and `openapi()` Vite plugins) → znight start + HTTP requests
 * (and /openapi.json, /docs, /graphql, the /ws gateway; JSON logs, without pino-pretty) → bun test (the `@znight/compiler/bun` preload, TestBed / TestApp, as
 * many passing tests as generated) → znight dev (pretty logs, restart on change, last good process
 * kept on a compile error).
 *
 * The application is created under `test/.tmp/` and its `node_modules` links the workspace packages,
 * which are loaded from their TypeScript sources (`@znight/source` condition, also passed to tsc).
 * The CLI runs on Bun (the compiler then loads the compiler extensions from their sources), Vite
 * loads its config natively (`--config-loader native`, so that the condition applies), and the
 * application runs on Node.js (`NODE_OPTIONS=--conditions=@znight/source`).
 *
 * A second, smaller application (`--openapi-ui none`) is built and started to check that it serves
 * `/openapi.json` and no API reference page at `/docs`.
 *
 * Set `ZNIGHT_CLI_E2E_KEEP=1` to keep the applications for inspection.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
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
function znight(args: readonly string[], env: Record<string, string> = {}, cwd = APP): Promise<Result> {
  return run('bun', [SOURCE, CLI, ...args], { cwd, env: { NODE_OPTIONS: SOURCE, ...env } })
}

interface LongRunning {
  readonly child: ChildProcess
  output(): string
  readonly exit: Promise<number | null>
}

/** A long-running `znight <args>` process (an `undefined` value removes the variable). */
function startZnight(args: readonly string[], env: Record<string, string | undefined>, cwd = APP): LongRunning {
  const variables: Record<string, string> = {}
  for (const [key, value] of Object.entries({ ...process.env, NO_COLOR: '1', NODE_OPTIONS: SOURCE, ...env })) {
    if (value !== undefined) variables[key] = value
  }
  const child = spawn('bun', [SOURCE, CLI, ...args], { cwd, env: variables, stdio: ['ignore', 'pipe', 'pipe'] })
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

/** The log entries of `output` written as JSON lines (pino's format without `pretty`). */
function jsonLogs(output: string): { name?: string; msg?: string }[] {
  return output
    .split('\n')
    .filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line) as { name?: string; msg?: string })
}

/**
 * A Node.js `--import` module making `pino-pretty` unresolvable, as in a production install
 * (it is a dev dependency of the scaffolded project).
 */
function withoutPinoPretty(app: string): string {
  const path = join(app, 'without-pino-pretty.mjs')
  writeFileSync(
    path,
    `import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'pino-pretty' || specifier.startsWith('pino-pretty/')) {
      throw Object.assign(new Error(\`Cannot find module '\${specifier}'\`), { code: 'MODULE_NOT_FOUND' })
    }
    return next(specifier, context)
  },
})
`,
  )
  return path
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

/** Sends a "greet" request to the gateway of the application; resolves with the reply frame. */
function greetOverWebSocket(url: string): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(url)
    const timer = setTimeout(() => reject(new Error(`no reply from ${url}`)), 10_000)
    socket.addEventListener('open', () => socket.send(JSON.stringify({ event: 'greet', data: { name: 'Ada' }, id: 1 })))
    socket.addEventListener('message', event => {
      clearTimeout(timer)
      resolvePromise(JSON.parse(String(event.data)))
      socket.close()
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error(`WebSocket error on ${url}`))
    })
  })
}

/** Links a package into the `node_modules` of the application in `app`. */
function link(name: string, target: string, app: string): void {
  const path = join(app, 'node_modules', name)
  mkdirSync(dirname(path), { recursive: true })
  symlinkSync(realpathSync(target), path, 'dir')
}

const packageDirectory = (name: string, from: string): string =>
  dirname(createRequire(join(from, 'package.json')).resolve(`${name}/package.json`))

/**
 * The test cases of the generated test files (one `test(...)` each): their number follows the
 * features of the project (`--features all` adds test/heartbeat.jobs.test.ts...).
 */
function generatedTests(): { files: number; tests: number } {
  const files = readdirSync(join(APP, 'test')).filter(file => file.endsWith('.test.ts'))
  const tests = files.reduce(
    (count, file) => count + countMatches(readFileSync(join(APP, 'test', file), 'utf8'), /^\s*(?:test|it)\(/gm),
    0,
  )
  return { files: files.length, tests }
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length
}

/** Fails with the command output when it did not succeed. */
function expectSuccess(result: Result, step: string): void {
  if (result.code !== 0) throw new Error(`${step} failed (exit code ${result.code}):\n${result.output}`)
}

const VITE_CONFIG = 'vite.e2e.config.ts'
const WORKSPACE_PACKAGES = [
  'cli',
  'compiler',
  'config',
  'core',
  'graphql',
  'http',
  'messaging',
  'observability',
  'openapi',
  'schedule',
  'testing',
  'websocket',
]
/** Third-party dependencies of the generated package.json, linked from the package that tests with them. */
const THIRD_PARTY: readonly (readonly [name: string, from: string])[] = [
  ['zod', 'http'],
  ['fastify', 'http'],
  ['graphql', 'graphql'],
  ['ws', 'websocket'],
  ['pino-pretty', 'observability'],
]

/**
 * Creates the application `name` in `app` with `znight new --yes <args>`, links the workspace and
 * third-party packages into its `node_modules`, and writes the type-check and Vite settings of the tests.
 */
async function scaffold(app: string, name: string, args: readonly string[]): Promise<void> {
  rmSync(app, { recursive: true, force: true })
  mkdirSync(dirname(app), { recursive: true })
  const created = await run(
    'bun',
    [SOURCE, CLI, 'new', name, '--yes', '--pm', 'bun', ...args, '--no-install', '--no-git', '--dir', app],
    { cwd: dirname(app) },
  )
  expectSuccess(created, 'znight new')
  for (const pkg of WORKSPACE_PACKAGES) {
    link(`@znight/${pkg}`, join(REPO, 'packages', pkg), app)
  }
  for (const [pkg, from] of THIRD_PARTY) link(pkg, packageDirectory(pkg, join(REPO, 'packages', from)), app)
  link('vite', packageDirectory('vite', CLI_ROOT), app)
  // tsc resolves the workspace packages to their sources, like the tests of the repository
  const tsconfig = readFileSync(join(app, 'tsconfig.json'), 'utf8').replace(
    '"noEmit": true',
    '"noEmit": true,\n    "customConditions": ["@znight/source"]',
  )
  writeFileSync(join(app, 'tsconfig.json'), tsconfig)
  // the linked workspace packages stay external in the bundle (like dependencies installed from npm)
  const external = `ssr: { external: ${JSON.stringify([...WORKSPACE_PACKAGES.map(pkg => `@znight/${pkg}`), ...THIRD_PARTY.map(([pkg]) => pkg)])} }`
  writeFileSync(
    join(app, VITE_CONFIG),
    `import { mergeConfig } from 'vite'\nimport base from './vite.config.ts'\n\nexport default mergeConfig(base, { ${external} })\n`,
  )
}

describe.skipIf(!enabled)('scaffolded application (ZNIGHT_CLI_E2E=1)', () => {
  beforeAll(() => scaffold(APP, 'e2e-app', ['--features', 'all']), TIMEOUT)

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
    'znight openapi writes openapi.json, --check confirms it',
    async () => {
      expectSuccess(await znight(['openapi', '--config-loader', 'native']), 'znight openapi')
      const document = JSON.parse(readFileSync(join(APP, 'openapi.json'), 'utf8')) as { info?: object; paths?: object }
      expect(Object.keys(document.paths ?? {})).toContain('/greetings/{name}')
      // src/openapi.ts
      expect(document.info).toEqual({ title: 'e2e-app', description: 'The HTTP API of e2e-app.', version: '1.0.0' })
      expectSuccess(await znight(['openapi', '--check', '--config-loader', 'native']), 'znight openapi --check')
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
    'znight build bundles the application (--openapi: and its OpenAPI document)',
    async () => {
      expectSuccess(
        await znight(['build', '--openapi', '--config', VITE_CONFIG, '--config-loader', 'native']),
        'znight build',
      )
      expect(existsSync(join(APP, 'dist/main.js'))).toBe(true)
      // the document emitted by the build is the one of znight openapi
      expect(readFileSync(join(APP, 'dist/openapi.json'), 'utf8')).toBe(readFileSync(join(APP, 'openapi.json'), 'utf8'))
    },
    TIMEOUT,
  )

  it(
    'znight start serves HTTP requests with JSON logs, without pino-pretty, and stops on SIGTERM',
    async () => {
      const port = await freePort()
      const blocker = withoutPinoPretty(APP)
      // the blocker works: pino-pretty is linked into node_modules, but cannot be loaded with it
      const blocked = await run('node', ['--import', blocker, '-e', "require('pino-pretty')"])
      expect(blocked.code).not.toBe(0)
      expect(blocked.output).toContain("Cannot find module 'pino-pretty'")
      // NODE_ENV unset (bun test sets it to "test"): znight start sets "production"
      const app = startZnight(['start', '--runtime', 'node'], {
        PORT: String(port),
        LOG_LEVEL: 'info',
        NODE_ENV: undefined,
        NODE_OPTIONS: `${SOURCE} --import ${blocker}`,
      })
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
        const openapi = await fetch(`${base}/openapi.json`)
        expect(openapi.status).toBe(200)
        expect(Object.keys(((await openapi.json()) as { paths?: object }).paths ?? {})).toContain('/greetings/{name}')
        const docs = await fetch(`${base}/docs`)
        expect(docs.status).toBe(200)
        expect(docs.headers.get('content-type')).toContain('text/html')
        const graphql = await post('/graphql', { query: '{ greeting(name: "Ada") { message } }' })
        expect(graphql.status).toBe(200)
        expect(await graphql.json()).toEqual({ data: { greeting: { message: 'Hello, Ada.' } } })
        expect(await greetOverWebSocket(`ws://127.0.0.1:${port}/ws`)).toEqual({
          id: 1,
          data: { message: 'Hello, Ada.' },
        })
        // AppConfig.environment is "production": JSON logs, named after the project
        const logs = jsonLogs(app.output())
        expect(logs.length).toBeGreaterThan(0)
        expect(logs.every(entry => entry.name === 'e2e-app')).toBe(true)
        expect(app.output()).not.toContain('INFO (e2e-app)')
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
      const expected = generatedTests()
      expect(expected.tests).toBeGreaterThan(0)
      const result = await run('bun', ['test', SOURCE])
      expectSuccess(result, 'bun test')
      expect(result.output).toMatch(new RegExp(`\\b${expected.tests} pass\\b`))
      expect(result.output).toMatch(/\b0 fail\b/)
      expect(result.output).toContain(`Ran ${expected.tests} tests across ${expected.files} files`)
      expect(existsSync(join(APP, 'src/.znight/container.generated.ts'))).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'znight dev runs the application with pretty logs and restarts it after a change',
    async () => {
      const port = await freePort()
      // NODE_ENV unset (bun test sets it to "test"): znight dev sets "development"
      const dev = startZnight(['dev', '--config', VITE_CONFIG, '--config-loader', 'native', '--runtime', 'node'], {
        PORT: String(port),
        LOG_LEVEL: 'info',
        NODE_ENV: undefined,
      })
      const url = `http://127.0.0.1:${port}/greetings/Ada`
      try {
        expect((await fetchWhenUp(url, dev)).status).toBe(200)
        // AppConfig.environment is "development": pino-pretty output, no JSON lines
        await waitForOutput(dev, 'INFO (e2e-app)')
        expect(jsonLogs(dev.output())).toEqual([])
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

describe.skipIf(!enabled)('scaffolded application without an API reference UI (--openapi-ui none)', () => {
  const app = `${APP}-no-ui`

  beforeAll(
    () => scaffold(app, 'e2e-no-ui', ['--adapter', 'node', '--features', 'openapi', '--openapi-ui', 'none']),
    TIMEOUT,
  )

  afterAll(() => {
    if (process.env['ZNIGHT_CLI_E2E_KEEP'] !== '1') rmSync(app, { recursive: true, force: true })
  })

  it(
    'serves /openapi.json and no page at /docs',
    async () => {
      expectSuccess(
        await znight(['build', '--config', VITE_CONFIG, '--config-loader', 'native'], {}, app),
        'znight build',
      )
      const port = await freePort()
      const server = startZnight(['start', '--runtime', 'node'], { PORT: String(port), LOG_LEVEL: 'warn' }, app)
      const base = `http://127.0.0.1:${port}`
      try {
        const openapi = await fetchWhenUp(`${base}/openapi.json`, server)
        expect(openapi.status).toBe(200)
        expect(((await openapi.json()) as { info?: object }).info).toEqual({
          title: 'e2e-no-ui',
          description: 'The HTTP API of e2e-no-ui.',
          version: '1.0.0',
        })
        // OpenApiPlugin.configure() without ui: no reference page and no asset route
        expect((await fetch(`${base}/docs`)).status).toBe(404)
        expect((await fetch(`${base}/docs/_assets/index.js`)).status).toBe(404)
      } catch (error) {
        throw new Error(`${String(error)}\n--- znight start output ---\n${server.output()}`)
      } finally {
        server.child.kill('SIGTERM')
      }
      expect(await server.exit).toBe(0)
    },
    TIMEOUT,
  )
})
