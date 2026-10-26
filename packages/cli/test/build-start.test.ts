import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { exitCodeOf } from '../src/integrations/process.ts'
import { FakeVite } from './fake-vite.ts'
import { FakeProcesses, FakeSignals, runCli, temporaryDirectory, waitFor } from './helpers.ts'
import { afterEach, beforeEach, describe, expect, test as it } from 'bun:test'

let project: { path: string; cleanup: () => void }

beforeEach(() => {
  project = temporaryDirectory()
})

afterEach(() => project.cleanup())

describe('znight build', () => {
  it('runs a production Vite build and prints the entry', async () => {
    const vite = new FakeVite()
    mkdirSync(join(project.path, 'dist'))
    writeFileSync(join(project.path, 'dist/main.js'), 'x'.repeat(2048))
    const run = await runCli(['build'], { cwd: project.path, services: { loadVite: () => Promise.resolve(vite) } })
    expect(run.code).toBe(0)
    const config = vite.lastBuild()
    // the root is not inline (it would override the config file's): a config hook sets it
    expect(config.root).toBeUndefined()
    expect(vite.resolvedRoot(config)).toBe(project.path)
    expect(config.mode).toBe('production')
    expect(config.logLevel).toBe('info')
    expect(config.build?.watch).toBeUndefined()
    // no vite.config.* in the project root: none is searched in the working directory
    expect(config.configFile).toBe(false)
    expect(run.stdout).toMatch(/✓ Built dist\/main\.js 2\.05 kB in \d+ms/)
    expect(run.stdout).toContain('run it with znight start')
  })

  it('resolves the root of the Vite config against the project root', async () => {
    writeFileSync(join(project.path, 'vite.config.ts'), "export default { root: 'app' }")
    const vite = new FakeVite({ configRoot: 'app' })
    const run = await runCli(['build'], { cwd: project.path, services: { loadVite: () => Promise.resolve(vite) } })
    expect(run.code).toBe(0)
    const config = vite.lastBuild()
    expect(config.configFile).toBe(join(project.path, 'vite.config.ts'))
    expect(vite.resolvedRoot(config)).toBe(join(project.path, 'app'))
    expect(run.stdout).toContain('✓ Built app/dist/main.js')
    // from another directory
    const other = await runCli(['build', '--root', project.path], {
      cwd: join(project.path, '..'),
      services: { loadVite: () => Promise.resolve(vite) },
    })
    expect(other.code).toBe(0)
    expect(vite.resolvedRoot(vite.lastBuild())).toBe(join(project.path, 'app'))
  })

  it('passes --config, --mode and --log-level to Vite', async () => {
    const vite = new FakeVite()
    const run = await runCli(['build', '--config', 'vite.prod.ts', '--mode', 'staging', '--log-level', 'silent'], {
      cwd: project.path,
      services: { loadVite: () => Promise.resolve(vite) },
    })
    expect(run.code).toBe(0)
    expect(vite.lastBuild()).toMatchObject({
      configFile: join(project.path, 'vite.prod.ts'),
      mode: 'staging',
      logLevel: 'silent',
    })
  })

  it('fails with exit code 1 and the error of the build', async () => {
    const error = Object.assign(new Error('[znight] ZNIGHT001: Missing provider for EmailService'), {
      plugin: 'znight',
      id: '/app/src/a.ts',
    })
    const vite = new FakeVite({ fail: error })
    const run = await runCli(['build'], { cwd: project.path, services: { loadVite: () => Promise.resolve(vite) } })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('[znight] [znight] ZNIGHT001: Missing provider for EmailService')
    expect(run.stderr).toContain('--> /app/src/a.ts')
    expect(run.stderr).toContain('✗ Build failed')
  })
})

describe('znight start', () => {
  function withBuild(file = 'dist/main.js'): void {
    mkdirSync(join(project.path, 'dist'), { recursive: true })
    writeFileSync(join(project.path, file), '')
  }

  it('replaces the process with node (execve) when supported', async () => {
    withBuild()
    const processes = new FakeProcesses({ execve: true })
    const run = await runCli(['start', '--', '--port', '8080'], {
      cwd: project.path,
      env: { PATH: '/usr/bin', HOME: '/home/u', UNSET: undefined },
      services: { processes },
    })
    expect(run.code).toBe(0)
    expect(processes.children).toHaveLength(0)
    expect(processes.execs).toEqual([
      {
        file: '/usr/bin/node',
        args: ['/usr/bin/node', '--enable-source-maps', join(project.path, 'dist/main.js'), '--port', '8080'],
        env: { PATH: '/usr/bin', HOME: '/home/u', NODE_ENV: 'production' },
        cwd: project.path,
      },
    ])
  })

  it('spawns the application, forwards signals and returns its exit code', async () => {
    withBuild()
    const processes = new FakeProcesses()
    processes.childOptions = { exitAfterMs: undefined }
    const signals = new FakeSignals()
    const running = runCli(['start', '--root', '.'], {
      cwd: project.path,
      env: { NODE_ENV: 'test' },
      signals,
      services: { processes },
    })
    await waitFor(() => processes.children.length === 1)
    const child = processes.children[0]
    expect(child?.options).toMatchObject({ cwd: project.path, detached: true })
    expect(child?.options.env['NODE_ENV']).toBe('test')
    signals.emit('SIGTERM')
    signals.emit('SIGHUP')
    expect(child?.signals).toEqual(['SIGTERM', 'SIGHUP'])
    child?.exit(3)
    const run = await running
    expect(run.code).toBe(3)
    expect(signals.count('SIGTERM')).toBe(0)
  })

  it('mirrors a death by signal like a shell (128 + n)', () => {
    expect(exitCodeOf({ code: 0, signal: null })).toBe(0)
    expect(exitCodeOf({ code: null, signal: 'SIGTERM' })).toBe(143)
    expect(exitCodeOf({ code: null, signal: 'SIGINT' })).toBe(130)
    expect(exitCodeOf({ code: null, signal: null })).toBe(1)
  })

  it('finds dist/main.mjs and honours --entry', async () => {
    withBuild('dist/main.mjs')
    const processes = new FakeProcesses({ execve: true })
    expect((await runCli(['start'], { cwd: project.path, services: { processes } })).code).toBe(0)
    expect(processes.execs[0]?.args.at(-1)).toBe(join(project.path, 'dist/main.mjs'))

    withBuild('dist/worker.js')
    await runCli(['start', '--entry', 'dist/worker.js'], { cwd: project.path, services: { processes } })
    expect(processes.execs[1]?.args.at(-1)).toBe(join(project.path, 'dist/worker.js'))
  })

  it('runs with Bun when the CLI runs on Bun', async () => {
    withBuild()
    const processes = new FakeProcesses({ execve: true })
    await runCli(['start'], {
      cwd: project.path,
      runtime: { name: 'bun', execPath: '/opt/bun', platform: 'linux' },
      services: { processes },
    })
    expect(processes.execs[0]?.args).toEqual(['/opt/bun', join(project.path, 'dist/main.js')])
  })

  it('fails without a build', async () => {
    const run = await runCli(['start'], { cwd: project.path })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('dist/main.js not found')
    expect(run.stderr).toContain('znight build')
  })

  it('fails when the process cannot start', async () => {
    withBuild()
    const processes = new FakeProcesses()
    processes.childOptions = { exitAfterMs: undefined }
    const running = runCli(['start'], { cwd: project.path, services: { processes } })
    await waitFor(() => processes.children.length === 1)
    processes.children[0]?.exit(null, null, new Error('spawn node EACCES'))
    const run = await running
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('Cannot start node: spawn node EACCES')
  })
})
