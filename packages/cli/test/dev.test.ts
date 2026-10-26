import type { HostRuntime } from '../src/runtime.ts'

import { join } from 'node:path'

import { FakeVite, type FakeZnightApi } from './fake-vite.ts'
import { type CliRun, FakeProcesses, FakeSignals, runCli, temporaryDirectory, waitFor } from './helpers.ts'
import { afterEach, beforeEach, describe, expect, test as it } from 'bun:test'

describe('znight dev', () => {
  let project: { path: string; cleanup: () => void }
  let vite: FakeVite
  let processes: FakeProcesses
  let signals: FakeSignals

  beforeEach(() => {
    project = temporaryDirectory()
    vite = new FakeVite()
    processes = new FakeProcesses()
    processes.childOptions = { exitAfterMs: 2 }
    signals = new FakeSignals()
  })

  afterEach(() => project.cleanup())

  function start(argv: readonly string[] = [], runtime?: HostRuntime): Promise<CliRun> {
    return runCli(['dev', '--debounce', '5', ...argv], {
      cwd: project.path,
      signals,
      ...(runtime === undefined ? {} : { runtime }),
      services: { loadVite: () => Promise.resolve(vite), processes },
    })
  }

  it('runs a Vite build in watch mode and starts the application after the first build', async () => {
    const running = start()
    await waitFor(() => vite.watchers.length === 1)
    const config = vite.lastBuild()
    expect(config.root).toBe(project.path)
    expect(config.mode).toBe('development')
    expect(config.logLevel).toBe('warn')
    expect(config.build?.watch).toEqual({})
    expect(config.clearScreen).toBe(false)
    expect(processes.children).toHaveLength(0)

    vite.succeed()
    await waitFor(() => processes.children.length === 1)
    const child = processes.children[0]
    expect(child?.command).toBe('/usr/bin/node')
    expect(child?.args).toEqual(['--enable-source-maps', join(project.path, 'dist/main.js')])
    expect(child?.options.cwd).toBe(project.path)
    expect(child?.options.detached).toBe(true)
    expect(child?.options.env['NODE_ENV']).toBe('development')

    signals.emit('SIGINT')
    const run = await running
    expect(run.code).toBe(0)
    expect(vite.watchers[0]?.closed).toBe(true)
    expect(child?.signals).toEqual(['SIGINT'])
    expect(run.stdout).toContain('Built in')
    expect(run.stdout).toContain('Started dist/main.js')
    expect(signals.count('SIGINT')).toBe(0)
  })

  it('restarts the application after every successful rebuild', async () => {
    const running = start()
    await waitFor(() => vite.watchers.length === 1)
    vite.succeed()
    await waitFor(() => processes.children.length === 1)
    vite.succeed()
    await waitFor(() => processes.children.length === 2)
    expect(processes.children[0]?.signals).toEqual(['SIGTERM'])
    expect(processes.children[0]?.done).toBe(true)
    signals.emit('SIGTERM')
    const run = await running
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('Change detected, rebuilding...')
    expect(run.stdout).toContain('Restarted dist/main.js')
    expect(processes.children[1]?.signals).toEqual(['SIGTERM'])
  })

  it('debounces a burst of builds into one restart', async () => {
    const running = start(['--debounce', '40'])
    await waitFor(() => vite.watchers.length === 1)
    vite.succeed()
    vite.succeed()
    vite.succeed()
    await waitFor(() => processes.children.length === 1)
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(processes.children).toHaveLength(1)
    signals.emit('SIGINT')
    await running
  })

  it('keeps the last good process running when a build fails', async () => {
    const running = start(['--log-level', 'silent'])
    await waitFor(() => vite.watchers.length === 1)
    vite.succeed()
    await waitFor(() => processes.children.length === 1)
    vite.failBuild(Object.assign(new Error('Unexpected token'), { id: '/app/src/main.ts', frame: '1 | const = 1' }))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(processes.children).toHaveLength(1)
    expect(processes.children[0]?.signals).toEqual([])
    vite.succeed()
    await waitFor(() => processes.children.length === 2)
    signals.emit('SIGINT')
    const run = await running
    expect(run.stderr).toContain('Unexpected token')
    expect(run.stderr).toContain('--> /app/src/main.ts')
    expect(run.stderr).toContain('1 | const = 1')
    expect(run.stderr).toContain('Build failed. The last good build keeps running. Waiting for changes...')
  })

  describe('compile errors (the znight() plugin does not fail watch builds)', () => {
    const failed = {
      ok: false,
      diagnostics: [
        {
          code: 'ZNIGHT001',
          severity: 'error',
          message: "Missing provider for 'Mailer' required by Notifier",
          location: { file: '/app/src/notifier.ts', line: 9, column: 32 },
        },
        { code: 'ZNIGHT019', severity: 'warning', message: 'Unused provider' },
      ],
    }
    let api: FakeZnightApi

    beforeEach(() => {
      api = { result: { ok: true, diagnostics: [] } }
      vite = new FakeVite({ znight: api })
    })

    it('keeps the last good process running, restarts once the compilation succeeds', async () => {
      const running = start()
      await waitFor(() => vite.watchers.length === 1)
      vite.succeed()
      await waitFor(() => processes.children.length === 1)

      api.result = failed
      vite.succeed()
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(processes.children).toHaveLength(1)
      expect(processes.children[0]?.signals).toEqual([])

      api.result = { ok: true, diagnostics: [] }
      vite.succeed()
      await waitFor(() => processes.children.length === 2)
      signals.emit('SIGINT')
      const run = await running
      expect(run.stderr).toContain(
        'Compilation failed with 1 error. The last good build keeps running. Waiting for changes...',
      )
      // Vite prints the diagnostics (the znight() plugin logs them)
      expect(run.stderr).not.toContain('Missing provider')
      expect(run.stdout.match(/Built in/g)).toHaveLength(2)
    })

    it('does not start the application when the first compilation fails', async () => {
      api.result = failed
      const running = start()
      await waitFor(() => vite.watchers.length === 1)
      vite.succeed()
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(processes.children).toHaveLength(0)
      api.result = { ok: true, diagnostics: [] }
      vite.succeed()
      await waitFor(() => processes.children.length === 1)
      signals.emit('SIGINT')
      const run = await running
      expect(run.stderr).toContain('Compilation failed with 1 error. Waiting for changes...')
      expect(run.stdout).toContain('Started dist/main.js')
    })

    it('cancels a restart still pending for the previous build', async () => {
      const running = start(['--debounce', '40'])
      await waitFor(() => vite.watchers.length === 1)
      vite.succeed()
      await waitFor(() => processes.children.length === 1)
      vite.succeed() // schedules a restart in 40 ms...
      api.result = failed
      vite.succeed() // ...which would run the broken output
      await new Promise(resolve => setTimeout(resolve, 80))
      expect(processes.children).toHaveLength(1)
      signals.emit('SIGINT')
      await running
    })

    it('prints the diagnostics itself when Vite is silent', async () => {
      const formatted: unknown[] = []
      const compiler = {
        formatDiagnostics: (diagnostics: readonly { code: string }[], options: unknown) => {
          formatted.push(options)
          return diagnostics.map(diagnostic => `[formatted] ${diagnostic.code}`).join('\n')
        },
      }
      api.result = failed
      const running = runCli(['dev', '--debounce', '5', '--log-level', 'silent'], {
        cwd: project.path,
        signals,
        services: {
          loadVite: () => Promise.resolve(vite),
          loadCompiler: () => Promise.resolve(compiler as never),
          processes,
        },
      })
      await waitFor(() => vite.watchers.length === 1)
      vite.succeed()
      await waitFor(() => formatted.length === 1)
      await new Promise(resolve => setTimeout(resolve, 10))
      signals.emit('SIGINT')
      const run = await running
      expect(formatted).toEqual([{ color: false, cwd: project.path, summary: false }])
      expect(run.stderr).toContain('[formatted] ZNIGHT001\n[formatted] ZNIGHT019')
      expect(run.stderr.indexOf('[formatted]')).toBeLessThan(run.stderr.indexOf('Compilation failed'))
    })

    it('falls back to a built-in formatter without the compiler', async () => {
      api.result = failed
      const running = start(['--log-level', 'silent'])
      await waitFor(() => vite.watchers.length === 1)
      vite.succeed()
      await new Promise(resolve => setTimeout(resolve, 20))
      signals.emit('SIGINT')
      const run = await running
      expect(run.stderr).toContain("✗ ZNIGHT001: Missing provider for 'Mailer' required by Notifier")
      expect(run.stderr).toMatch(/--> .*app\/src\/notifier.ts:9:32/)
      expect(run.stderr).toContain('Compilation failed with 1 error. Waiting for changes...')
    })
  })

  it('does not print the build error twice when Vite logs it', async () => {
    const running = start()
    await waitFor(() => vite.watchers.length === 1)
    vite.failBuild(new Error('Unexpected token'))
    signals.emit('SIGINT')
    const run = await running
    expect(run.stderr).not.toContain('Unexpected token')
    expect(run.stderr).toContain('Build failed. Waiting for changes...')
    expect(processes.children).toHaveLength(0)
  })

  it('reports an application exiting by itself and waits for changes', async () => {
    const running = start()
    await waitFor(() => vite.watchers.length === 1)
    vite.succeed()
    await waitFor(() => processes.children.length === 1)
    processes.children[0]?.exit(1)
    await new Promise(resolve => setTimeout(resolve, 10))
    vite.succeed()
    await waitFor(() => processes.children.length === 2)
    // the crashed process is not signalled again
    expect(processes.children[0]?.signals).toEqual([])
    signals.emit('SIGINT')
    const run = await running
    expect(run.stderr).toContain('The application exited with code 1. Waiting for changes...')
  })

  it('runs the entry chunk of the build, or --entry', async () => {
    const running = start()
    await waitFor(() => vite.watchers.length === 1)
    vite.succeed('server.mjs')
    await waitFor(() => processes.children.length === 1)
    expect(processes.children[0]?.args.at(-1)).toBe(join(project.path, 'dist/server.mjs'))
    signals.emit('SIGINT')
    await running

    const explicit = start(['--entry', 'out/app.js'])
    await waitFor(() => vite.watchers.length === 2)
    vite.succeed()
    await waitFor(() => processes.children.length === 2)
    expect(processes.children[1]?.args.at(-1)).toBe(join(project.path, 'out/app.js'))
    signals.emit('SIGINT')
    await explicit
  })

  it('forwards arguments after -- and --inspect, and honours NODE_ENV', async () => {
    const running = runCli(['dev', '--debounce', '0', '--inspect', '--', '--verbose', 'x'], {
      cwd: project.path,
      signals,
      env: { NODE_ENV: 'staging' },
      services: { loadVite: () => Promise.resolve(vite), processes },
    })
    await waitFor(() => vite.watchers.length === 1)
    vite.succeed()
    await waitFor(() => processes.children.length === 1)
    expect(processes.children[0]?.args).toEqual([
      '--enable-source-maps',
      '--inspect',
      join(project.path, 'dist/main.js'),
      '--verbose',
      'x',
    ])
    expect(processes.children[0]?.options.env['NODE_ENV']).toBe('staging')
    signals.emit('SIGINT')
    await running
  })

  it('runs the application with Bun when the CLI runs on Bun', async () => {
    const running = start([], { name: 'bun', execPath: '/opt/bun', platform: 'linux' })
    await waitFor(() => vite.watchers.length === 1)
    vite.succeed()
    await waitFor(() => processes.children.length === 1)
    expect(processes.children[0]?.command).toBe('/opt/bun')
    expect(processes.children[0]?.args).toEqual([join(project.path, 'dist/main.js')])
    signals.emit('SIGINT')
    await running
  })

  it('fails when the requested runtime is not installed', async () => {
    const run = await runCli(['dev', '--runtime', 'bun'], {
      cwd: project.path,
      env: { PATH: '' },
      services: { loadVite: () => Promise.resolve(vite), processes },
    })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('Cannot find "bun" in PATH')
  })

  it('kills the application on a second signal (exit code 130)', async () => {
    processes.childOptions = { exitAfterMs: undefined }
    const running = runCli(['dev', '--debounce', '0', '--kill-timeout', '10000'], {
      cwd: project.path,
      signals,
      services: { loadVite: () => Promise.resolve(vite), processes },
    })
    await waitFor(() => vite.watchers.length === 1)
    vite.succeed()
    await waitFor(() => processes.children.length === 1)
    signals.emit('SIGINT')
    // the application ignores SIGINT: a second Ctrl+C forces the exit
    await waitFor(() => processes.children[0]?.signals.length === 1)
    signals.emit('SIGINT')
    const run = await running
    expect(run.code).toBe(130)
    expect(processes.children[0]?.signals).toEqual(['SIGINT', 'SIGKILL'])
  })

  it('fails with exit code 1 when the Vite build cannot start', async () => {
    vite = new FakeVite({ fail: new Error('failed to load config from vite.config.ts') })
    const run = await start()
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('failed to load config from vite.config.ts')
    expect(run.stderr).toContain('✗ Cannot start the Vite build')
    expect(processes.children).toHaveLength(0)
  })

  it('validates the numeric options', async () => {
    const run = await runCli(['dev', '--debounce', '-1'], { cwd: project.path })
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('Invalid value for --debounce')
  })
})
