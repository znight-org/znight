/**
 * `znight generate` with the real `@znight/compiler` of the workspace (loaded from sources with the
 * `@znight/source` condition). Fixtures are copied under `test/.tmp/` so that `@znight/core`
 * resolves from the workspace.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { main } from '../src/main.ts'
import { CaptureStream, FakeSignals, waitFor } from './helpers.ts'
import { afterAll, describe, expect, test } from 'bun:test'

// not a literal: the type-check of the CLI tests does not depend on the compiler sources
const COMPILER: string = '@znight/compiler'
const compiler: Record<string, unknown> = await import(COMPILER).catch(() => ({}))
const available = typeof compiler['generate'] === 'function' && typeof compiler['createCompiler'] === 'function'
const it = available ? test : test.skip

const TMP = join(import.meta.dir, '.tmp', `real-compiler-${process.pid}`)
const OUT_FILE = 'src/.znight/container.generated.ts'

afterAll(() => rmSync(TMP, { recursive: true, force: true }))

function fixture(name: string): string {
  const target = join(TMP, `${name}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(TMP, { recursive: true })
  cpSync(join(import.meta.dir, 'fixtures', name), target, { recursive: true })
  return target
}

async function cli(argv: readonly string[], cwd: string, signals = new FakeSignals()) {
  const stdout = new CaptureStream()
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
    const running = cli(['generate', '--watch'], root, signals)
    await waitFor(() => existsSync(join(root, OUT_FILE)), 5000)
    // give the watcher time to start
    await new Promise(resolve => setTimeout(resolve, 100))
    writeFileSync(
      join(root, 'src/audit.service.ts'),
      "import { Injectable } from '@znight/core'\n\n@Injectable()\nexport class AuditService {}\n",
    )
    await waitFor(() => readFileSync(join(root, OUT_FILE), 'utf8').includes('AuditService'), 5000)
    signals.emit('SIGINT')
    const run = await running
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('Watching for changes...')
    expect(run.stdout).toContain('3 providers')
  })
})
