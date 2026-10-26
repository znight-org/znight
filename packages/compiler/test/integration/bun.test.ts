/**
 * The `@znight/compiler/bun` preload in real Bun processes (fixture applications): `bun test` with
 * the bunfig preload, `bun --preload` runs, decorator blanking, errors, `znight.config.ts`, custom
 * preload files, `bun --watch` restarts and recovery.
 *
 * Processes get `--conditions=@znight/source`: the preload and the workspace packages are loaded
 * from their TypeScript sources.
 */
import fs from 'node:fs'

import { DEFAULT_OUT_FILE } from '../../src/options.ts'
import { integrationApp, integrationTemplate, report, run, SOURCE_CONDITION, sleep, waitFor } from './helpers.ts'
import { describe, expect, test as it } from 'bun:test'

const TIMEOUT = 30_000

const BUNFIG = '[test]\npreload = ["@znight/compiler/bun"]\n'

const APP_TEST = `import { Application } from '@znight/core'
import { expect, test } from 'bun:test'

import { __ZNIGHT_METADATA__ } from '../src/.znight/container.generated.js'
import { GreetingService } from '../src/greeting.service.ts'

test('the container is generated before the tests', async () => {
  const app = await Application.create({ metadata: __ZNIGHT_METADATA__, shutdown: { signals: false } })
  expect(app.container.get(GreetingService).greet('Bun')).toBe('Hello Bun @42')
  expect(__ZNIGHT_METADATA__.providers['src/clock.ts#Clock']?.source).toEqual({ file: 'src/clock.ts', line: 4, column: 14 })
  await app.stop()
})
`

const NOTIFIER = `import { Injectable } from '@znight/core'

export interface Mailer {}

@Injectable()
export class Notifier {
  constructor(readonly mailer: Mailer) {}
}
`

/** A stand-in for `@znight/core` whose decorators record their calls (stripping is then observable). */
const RECORDING_CORE = {
  'node_modules/@znight/core/package.json': JSON.stringify({
    name: '@znight/core',
    version: '0.1.0',
    type: 'module',
    exports: { '.': './index.ts' },
  }),
  'node_modules/@znight/core/index.ts': `const calls: string[] = ((globalThis as { __decoratorCalls?: string[] }).__decoratorCalls ??= [])
const marker = (name: string) => (..._args: unknown[]): void => {
  calls.push(name)
}
export function Injectable(_options?: unknown) {
  return marker('Injectable')
}
export function Inject(_name: string) {
  return marker('Inject')
}
export function Factory() {
  return marker('Factory')
}
export function Provides(_options?: unknown) {
  return marker('Provides')
}
export const ErrorCode = { VersionMismatch: 'ZNIGHT018' } as const
export class ZnightError extends Error {
  constructor(readonly code: string, message: string) {
    super(code + ': ' + message)
    this.name = 'ZnightError'
  }
}
export interface ZnightMetadata {
  readonly providers: Record<string, unknown>
}
`,
  'test/decorators.test.ts': `import { expect, test } from 'bun:test'

import { __ZNIGHT_METADATA__ } from '../src/.znight/container.generated.js'

test('decorators', () => {
  expect(Object.keys(__ZNIGHT_METADATA__.providers)).toHaveLength(4)
  console.log('DECORATOR CALLS ' + JSON.stringify((globalThis as { __decoratorCalls?: string[] }).__decoratorCalls ?? []))
})
`,
}

/** A fixture app whose `@znight/core` is {@link RECORDING_CORE} (the real one is not linked). */
function recordingApp(files: Record<string, string> = {}): ReturnType<typeof integrationApp> {
  const app = integrationApp('app', { 'bunfig.toml': BUNFIG })
  fs.rmSync(`${app.root}/node_modules/@znight/core`)
  for (const [file, content] of Object.entries({ ...RECORDING_CORE, ...files })) {
    app.write(file, content)
  }
  return app
}

/** A long-running process whose output (stdout + stderr) is collected. */
function spawn(command: readonly string[], cwd: string): { output(): string; stop(): Promise<void> } {
  const child = Bun.spawn([...command], { cwd, env: { ...process.env, NO_COLOR: '1' }, stdout: 'pipe', stderr: 'pipe' })
  let output = ''
  const collect = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder()
    for await (const chunk of stream) {
      output += decoder.decode(chunk)
    }
  }
  void collect(child.stdout)
  void collect(child.stderr)
  return {
    output: () => output,
    async stop() {
      child.kill()
      await child.exited
    },
  }
}

function decoratorCalls(stdout: string): string[] {
  const line = stdout.split('\n').find(text => text.startsWith('DECORATOR CALLS '))
  if (line === undefined) {
    throw new Error(`no decorator calls in the output:\n${stdout}`)
  }
  return JSON.parse(line.slice('DECORATOR CALLS '.length))
}

describe('bun test with the @znight/compiler/bun preload', () => {
  it(
    'generates the container (test mode) before the tests',
    async () => {
      const app = integrationApp('app', { 'bunfig.toml': BUNFIG, 'test/app.test.ts': APP_TEST })
      try {
        expect(fs.existsSync(`${app.root}/${DEFAULT_OUT_FILE}`)).toBe(false)
        const result = await run(['bun', SOURCE_CONDITION, 'test'], app.root)
        expect(result.code, result.stdout + result.stderr).toBe(0)
        expect(result.stderr).toContain('1 pass')
        // the disk copy, for tsc and editors
        expect(fs.readFileSync(`${app.root}/${DEFAULT_OUT_FILE}`, 'utf8')).toContain("['src/clock.ts#Clock']")
      } finally {
        app.cleanup()
      }
    },
    TIMEOUT,
  )

  it(
    'blanks the Znight decorators (they never run), unless stripDecorators is false',
    async () => {
      const app = recordingApp()
      try {
        const stripped = await run(['bun', SOURCE_CONDITION, 'test'], app.root)
        expect(stripped.code, stripped.stdout + stripped.stderr).toBe(0)
        expect(decoratorCalls(stripped.stdout)).toEqual([])

        app.write('znight.config.ts', 'export default { stripDecorators: false }\n')
        const kept = await run(['bun', SOURCE_CONDITION, 'test'], app.root)
        expect(kept.code, kept.stdout + kept.stderr).toBe(0)
        expect(decoratorCalls(kept.stdout).sort()).toEqual([
          'Factory',
          'Inject',
          'Injectable',
          'Injectable',
          'Provides',
        ])
      } finally {
        app.cleanup()
      }
    },
    TIMEOUT,
  )

  it(
    'fails with the formatted diagnostics on compile errors, without writing',
    async () => {
      const app = integrationApp('app', {
        'bunfig.toml': BUNFIG,
        'test/app.test.ts': APP_TEST,
        'src/notifier.ts': NOTIFIER,
      })
      try {
        const result = await run(['bun', SOURCE_CONDITION, 'test'], app.root)
        expect(result.code).toBe(1)
        expect(result.stderr).toContain("✗ ZNIGHT001: Missing provider for 'Mailer' required by Notifier")
        expect(result.stderr).toContain(' --> src/notifier.ts:7:32')
        expect(result.stderr).toContain('Build failed with 1 error')
        expect(result.stderr).toContain(
          'ZnightError: ZNIGHT001: The Znight compilation failed with 1 error (see the diagnostics above)',
        )
        expect(result.stderr).not.toContain('1 pass')
        expect(fs.existsSync(`${app.root}/${DEFAULT_OUT_FILE}`)).toBe(false)
      } finally {
        app.cleanup()
      }
    },
    TIMEOUT,
  )

  it(
    'reads znight.config.ts (outFile, logLevel) and supports custom preload files',
    async () => {
      const app = integrationApp('app', {
        'bunfig.toml': BUNFIG,
        'znight.config.ts': "export default { outFile: 'src/di/container.ts', logLevel: 'info' as const }\n",
        'test/app.test.ts': APP_TEST.replace('../src/.znight/container.generated.js', '../src/di/container.ts'),
      })
      try {
        const result = await run(['bun', SOURCE_CONDITION, 'test'], app.root)
        expect(result.code, result.stdout + result.stderr).toBe(0)
        expect(result.stderr).toMatch(/\[znight\] 4 providers compiled in \d+ ms/)
        expect(fs.existsSync(`${app.root}/src/di/container.ts`)).toBe(true)

        app.write('bunfig.toml', '[test]\npreload = ["./preload.ts"]\n')
        app.write(
          'preload.ts',
          "import { createPreload } from '@znight/compiler'\n\nconst result = await createPreload({ outFile: 'src/di/container.ts' })\nconsole.log('CUSTOM PRELOAD ' + result.stats.providers)\n",
        )
        const custom = await run(['bun', SOURCE_CONDITION, 'test'], app.root)
        expect(custom.code, custom.stdout + custom.stderr).toBe(0)
        expect(custom.stdout).toContain('CUSTOM PRELOAD 4')
        expect(custom.stderr).not.toContain('[znight]')
      } finally {
        app.cleanup()
      }
    },
    TIMEOUT,
  )
  it(
    'bun test --watch re-runs when a provider served by the plugin changes',
    async () => {
      const app = integrationApp('app', {
        'bunfig.toml': BUNFIG,
        'test/clock.test.ts': `import { expect, test } from 'bun:test'

import { __ZNIGHT_METADATA__ } from '../src/.znight/container.generated.js'

test('clock', () => {
  const clock = __ZNIGHT_METADATA__.providers['src/clock.ts#Clock']?.factory([]) as { now(): number }
  console.log('NOW ' + clock.now())
})
`,
      })
      const watching = spawn(['bun', SOURCE_CONDITION, 'test', '--watch'], app.root)
      try {
        await waitFor(() => watching.output().includes('NOW 42'), 'the first run')
        await sleep(300)
        // src/clock.ts is only imported by the generated module, and its decorators are blanked by
        // the plugin: Bun watches it because the preload loaded it as text
        app.write('src/clock.ts', fs.readFileSync(`${app.root}/src/clock.ts`, 'utf8').replace('42', '44'))
        await waitFor(() => watching.output().includes('NOW 44'), 'the re-run')
      } finally {
        await watching.stop()
        app.cleanup()
      }
    },
    TIMEOUT,
  )
})

describe('bun --preload @znight/compiler/bun', () => {
  it(
    'runs the application (serve mode) and refuses to run on Node.js',
    async () => {
      const app = integrationApp('app')
      try {
        const result = await run(
          ['bun', SOURCE_CONDITION, '--preload', '@znight/compiler/bun', 'src/main.ts'],
          app.root,
        )
        expect(result.stderr).toBe('')
        expect(report(result.stdout).greeting).toBe('Hello Ada @42')
        expect(fs.readFileSync(`${app.root}/${DEFAULT_OUT_FILE}`, 'utf8')).toContain('source: {')

        const production = await run(
          ['bun', SOURCE_CONDITION, '--preload', '@znight/compiler/bun', 'src/main.ts'],
          app.root,
          { NODE_ENV: 'production' },
        )
        expect(report(production.stdout).greeting).toBe('Hello Ada @42')
        expect(fs.readFileSync(`${app.root}/${DEFAULT_OUT_FILE}`, 'utf8')).not.toContain('source: {')

        const node = await run(['node', SOURCE_CONDITION, '--import', '@znight/compiler/bun', '-e', '0'], app.root)
        expect(node.code).not.toBe(0)
        expect(node.stderr).toContain('[znight] the Znight preload runs under Bun only')
      } finally {
        app.cleanup()
      }
    },
    TIMEOUT,
  )

  it(
    'restarts bun --watch with fresh metadata, waits on errors and recovers',
    async () => {
      const app = integrationApp('app', {
        'src/main.ts': `${fs.readFileSync(`${integrationTemplate('app')}/src/main.ts`, 'utf8')}\nawait new Promise(() => {})\n`,
      })
      const watching = spawn(
        ['bun', SOURCE_CONDITION, '--watch', '--preload', '@znight/compiler/bun', 'src/main.ts'],
        app.root,
      )
      const output = (): string => watching.output()
      const reports = (): string[] =>
        output()
          .split('\n')
          .filter(line => line.startsWith('{'))
      try {
        await waitFor(() => reports().length === 1, 'the first run')
        expect(report(output()).greeting).toBe('Hello Ada @42')
        await sleep(300)

        // a provider change restarts the process
        app.write('src/clock.ts', fs.readFileSync(`${app.root}/src/clock.ts`, 'utf8').replace('42', '43'))
        await waitFor(() => reports().length === 2, 'the restart')
        expect(reports()[1]).toContain('Hello Ada @43')

        // a syntax error: diagnostics, then the process waits for a fix (the preload throws before
        // main.ts runs: only the files the preload loaded as text are watched)
        const factory = fs.readFileSync(`${app.root}/src/settings.factory.ts`, 'utf8')
        app.write('src/settings.factory.ts', factory.replace('prefix(): string {', 'prefix(): string {{'))
        await waitFor(() => output().includes('✗ ZNIGHT022'), 'the diagnostics')
        expect(output()).toContain(' --> src/settings.factory.ts:')
        expect(output()).toContain('ZnightError: ZNIGHT022: The Znight compilation failed with 2 errors')
        expect(output()).not.toContain('bun-plugin.ts')
        app.write('src/settings.factory.ts', factory)
        await waitFor(() => reports().length === 3, 'the recovery')
        expect(reports()[2]).toContain('Hello Ada @43')
      } finally {
        await watching.stop()
        app.cleanup()
      }
    },
    TIMEOUT,
  )
})
