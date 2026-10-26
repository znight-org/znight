/**
 * `znight generate` with the real `@znight/compiler` of the workspace (loaded from sources with the
 * `@znight/source` condition). Fixtures are copied under `test/.tmp/` so that `@znight/core`
 * resolves from the workspace.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { main } from '../src/main.ts'
import { CaptureStream, FakeSignals, waitFor } from './helpers.ts'
import { afterAll, describe, expect, test } from 'bun:test'

// not a literal: the type-check of the CLI tests does not depend on the compiler sources
const COMPILER: string = '@znight/compiler'
const compiler: Record<string, unknown> = await import(COMPILER).catch(() => ({}))
const available = typeof compiler['generate'] === 'function' && typeof compiler['createCompiler'] === 'function'
const it = available ? test : test.skip

const INJECTABLE = (name: string): string =>
  `import { Injectable } from '@znight/core'\n\n@Injectable()\nexport class ${name} {}\n`

const TMP = join(import.meta.dir, '.tmp', `real-compiler-${process.pid}`)
const OUT_FILE = 'src/.znight/container.generated.ts'

afterAll(() => rmSync(TMP, { recursive: true, force: true }))

function fixture(name: string): string {
  const target = join(TMP, `${name}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(TMP, { recursive: true })
  cpSync(join(import.meta.dir, 'fixtures', name), target, { recursive: true })
  return target
}

/** Runs the CLI; pass `stdout` to follow its output while it runs (`--watch`). */
async function cli(argv: readonly string[], cwd: string, signals = new FakeSignals(), stdout = new CaptureStream()) {
  const stderr = new CaptureStream()
  const code = await main(argv, { cwd, env: {}, stdout, stderr, interactive: false, signals })
  return { code, stdout: stdout.text(), stderr: stderr.text() }
}

describe('znight generate with @znight/compiler', () => {
  it('generates, then reports the file up to date', async () => {
    const root = fixture('compile')
    const first = await cli(['generate'], root)
    expect(first.code).toBe(0)
    expect(first.stdout).toMatch(/✓ Generated src\/\.znight\/container\.generated\.ts \(2 providers, 2 files, \d+m?s\)/)
    const generated = readFileSync(join(root, OUT_FILE), 'utf8')
    expect(generated).toContain("['src/greeting.service.ts#GreetingService']")
    expect(generated).toContain('factory: d => new GreetingService(d[0])')

    const again = await cli(['generate'], root)
    expect(again.stdout).toContain('Up to date: src/.znight/container.generated.ts')

    const check = await cli(['generate', '--check'], root)
    expect(check.code).toBe(0)
    expect(check.stdout).toContain('is up to date')
  })

  it('detects a missing or stale generated file with --check', async () => {
    const root = fixture('compile')
    const missing = await cli(['generate', '--check'], root)
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain('src/.znight/container.generated.ts is missing')
    expect(existsSync(join(root, OUT_FILE))).toBe(false)

    await cli(['generate'], root)
    writeFileSync(join(root, OUT_FILE), '// stale')
    const stale = await cli(['generate', '--check'], root)
    expect(stale.code).toBe(1)
    expect(stale.stderr).toContain('is out of date')
  })

  it('names the library manifest when only it is missing or stale (library mode)', async () => {
    const root = fixture('compile')
    writeFileSync(join(root, 'znight.config.ts'), 'export default { library: true }\n')
    // the providers of a library are part of its public API
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'fixture-lib', type: 'module', exports: { '.': './src/index.ts' } }),
    )
    writeFileSync(join(root, 'src/index.ts'), "export * from './clock.ts'\nexport * from './greeting.service.ts'\n")
    const generated = await cli(['generate'], root)
    expect(generated.code).toBe(0)
    expect(existsSync(join(root, 'dist/znight.providers.json'))).toBe(true)
    expect((await cli(['generate', '--check'], root)).code).toBe(0)

    // what a build cleaning dist/ (tsdown) does
    rmSync(join(root, 'dist'), { recursive: true })
    const missing = await cli(['generate', '--check'], root)
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain('✗ dist/znight.providers.json is missing')
    expect(missing.stderr).not.toContain('container.generated.ts')

    await cli(['generate'], root)
    writeFileSync(join(root, 'dist/znight.providers.json'), '{}')
    const stale = await cli(['generate', '--check'], root)
    expect(stale.code).toBe(1)
    expect(stale.stderr).toContain('✗ dist/znight.providers.json is out of date')
    expect(stale.stderr).not.toContain('container.generated.ts')
  })

  it('prints the diagnostics with code frames and fails', async () => {
    const root = fixture('broken')
    const run = await cli(['generate'], root)
    expect(run.code).toBe(1)
    expect(run.stderr).toContain("ZNIGHT001: Missing provider for 'EmailService' required by NotificationService")
    expect(run.stderr).toContain('--> src/notification.service.ts:7:39')
    expect(run.stderr).toContain('constructor(private readonly email: EmailService) {}')
    expect(run.stderr).toContain('✗ Generation failed with 1 error')
    expect(run.stderr).not.toContain('Build failed with')
    expect(existsSync(join(root, OUT_FILE))).toBe(false)
  })

  it('reads the options of znight.config.ts (shared with the Bun preload)', async () => {
    const root = fixture('compile')
    writeFileSync(join(root, 'znight.config.ts'), "export default { outFile: 'src/di/container.ts' }\n")
    const run = await cli(['generate'], root)
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('Generated src/di/container.ts')
    expect(existsSync(join(root, 'src/di/container.ts'))).toBe(true)
    expect(existsSync(join(root, OUT_FILE))).toBe(false)
  })

  it('regenerates on changes with --watch', async () => {
    const root = fixture('compile')
    const signals = new FakeSignals()
    const stdout = new CaptureStream()
    const running = cli(['generate', '--watch'], root, signals, stdout)
    await waitFor(() => existsSync(join(root, OUT_FILE)), 5000)
    // give the watcher time to start
    await new Promise(resolve => setTimeout(resolve, 100))
    writeFileSync(
      join(root, 'src/audit.service.ts'),
      "import { Injectable } from '@znight/core'\n\n@Injectable()\nexport class AuditService {}\n",
    )
    // the report, not the file: the file is on disk before the write is reported to the CLI
    await waitFor(() => stdout.text().includes('3 providers'), 5000)
    expect(readFileSync(join(root, OUT_FILE), 'utf8')).toContain('AuditService')
    signals.emit('SIGINT')
    const run = await running
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('Watching for changes...')
    expect(run.stdout).toContain('3 providers')
  })

  it('regenerates when a directory of providers is moved, with --watch', async () => {
    const root = fixture('compile')
    mkdirSync(join(root, 'src/users'))
    writeFileSync(join(root, 'src/users/user.service.ts'), INJECTABLE('UserService'))
    const signals = new FakeSignals()
    const running = cli(['generate', '--watch'], root, signals)
    await waitFor(() => existsSync(join(root, OUT_FILE)), 5000)
    expect(readFileSync(join(root, OUT_FILE), 'utf8')).toContain('users/user.service')
    await new Promise(resolve => setTimeout(resolve, 100))
    // fs.watch reports the two directories only, not the files they contain
    renameSync(join(root, 'src/users'), join(root, 'src/accounts'))
    await waitFor(() => readFileSync(join(root, OUT_FILE), 'utf8').includes('accounts/user.service'), 5000)
    expect(readFileSync(join(root, OUT_FILE), 'utf8')).not.toContain('users/user.service')
    signals.emit('SIGINT')
    expect((await running).code).toBe(0)
  })

  it('regenerates on changes of a source library outside the project, with --watch', async () => {
    const root = fixture('compile')
    const library = join(root, '..', `shared-${Math.random().toString(36).slice(2, 8)}`)
    mkdirSync(join(library, 'src'), { recursive: true })
    writeFileSync(
      join(library, 'package.json'),
      JSON.stringify({
        name: '@acme/shared',
        type: 'module',
        exports: { '.': './src/index.ts' },
        znight: { apiVersion: 1, library: 'source' },
      }),
    )
    writeFileSync(join(library, 'src/calendar.ts'), INJECTABLE('Calendar'))
    writeFileSync(join(library, 'src/index.ts'), "export * from './calendar.ts'\n")
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'fixture-compile', private: true, type: 'module', dependencies: { '@acme/shared': '*' } }),
    )
    // a workspace dependency: a symbolic link to the library
    mkdirSync(join(root, 'node_modules/@acme'), { recursive: true })
    symlinkSync(library, join(root, 'node_modules/@acme/shared'), 'dir')

    const signals = new FakeSignals()
    const stdout = new CaptureStream()
    const running = cli(['generate', '--watch'], root, signals, stdout)
    await waitFor(() => existsSync(join(root, OUT_FILE)), 5000)
    expect(readFileSync(join(root, OUT_FILE), 'utf8')).toContain('Calendar')
    await new Promise(resolve => setTimeout(resolve, 100))
    writeFileSync(join(library, 'src/timer.ts'), INJECTABLE('Timer'))
    writeFileSync(join(library, 'src/index.ts'), "export * from './calendar.ts'\nexport * from './timer.ts'\n")
    // the report, not the file: the file is on disk before the write is reported to the CLI
    await waitFor(() => stdout.text().includes('4 providers'), 5000)
    expect(readFileSync(join(root, OUT_FILE), 'utf8')).toContain('Timer')
    signals.emit('SIGINT')
    const run = await running
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('3 providers')
    expect(run.stdout).toContain('4 providers')
  })
})
