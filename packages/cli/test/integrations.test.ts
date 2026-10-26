import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createProcessService, runProcess, spawnProcess } from '../src/integrations/process.ts'
import { loadPrompts } from '../src/integrations/prompts.ts'
import { importFromProject, resolveFromProject } from '../src/integrations/resolve.ts'
import {
  createOutputTracker,
  findViteConfig,
  formatBuildError,
  readZnightPluginOptions,
} from '../src/integrations/vite.ts'
import { globBase, isRelevantChange, watchFiles, watchTargets } from '../src/integrations/watch.ts'
import { formatBytes, formatDuration, plural } from '../src/output.ts'
import { detectHostRuntime, resolveRuntime, runtimeArguments, runtimeExecutable, which } from '../src/runtime.ts'
import { FakeVite } from './fake-vite.ts'
import { temporaryDirectory, waitFor } from './helpers.ts'
import { afterEach, beforeEach, describe, expect, test as it } from 'bun:test'

let directory: { path: string; cleanup: () => void }

beforeEach(() => {
  directory = temporaryDirectory()
})

afterEach(() => directory.cleanup())

const node = process.execPath

describe('processes', () => {
  it('runs a command and captures its output', async () => {
    const result = await runProcess(node, ['-e', 'console.log("out"); console.error("err"); process.exit(4)'], {
      cwd: directory.path,
      env: process.env,
    })
    expect(result).toMatchObject({ code: 4, signal: null, stdout: 'out\n', stderr: 'err\n' })
  })

  it('reports a missing executable', async () => {
    const result = await runProcess('znight-definitely-missing-binary', [], { cwd: directory.path, env: process.env })
    expect(result.code).toBeNull()
    expect(result.error).toBeInstanceOf(Error)
  })

  it('spawns a detached process, signals its process group and reports its exit', async () => {
    const child = spawnProcess(node, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: directory.path,
      env: process.env,
      stdio: 'ignore',
      detached: true,
    })
    expect(child.pid).toBeNumber()
    expect(child.kill('SIGTERM')).toBe(true)
    const status = await child.exited
    expect(status.signal).toBe('SIGTERM')
    expect(child.kill('SIGTERM')).toBe(false)
  })

  it('passes the environment and the working directory', async () => {
    const child = spawnProcess(
      node,
      [
        '-e',
        'process.exit(process.env.ZNIGHT_TEST === "1" && process.cwd().endsWith(require("node:path").basename(process.argv[1])) ? 0 : 9)',
        directory.path,
      ],
      { cwd: directory.path, env: { ...process.env, ZNIGHT_TEST: '1', DROPPED: undefined }, stdio: 'ignore' },
    )
    expect((await child.exited).code).toBe(0)
  })

  it('resolves exited with the error of a failed spawn', async () => {
    const child = spawnProcess('znight-definitely-missing-binary', [], {
      cwd: directory.path,
      env: process.env,
      stdio: 'ignore',
    })
    const status = await child.exited
    expect(status.error).toBeInstanceOf(Error)
  })

  it('exposes execve on POSIX runtimes that support it', () => {
    const service = createProcessService()
    const supported = typeof (process as { execve?: unknown }).execve === 'function' && process.platform !== 'win32'
    expect(service.execve !== undefined).toBe(supported)
  })
})

describe('runtimes', () => {
  it('detects the host runtime', () => {
    const host = detectHostRuntime()
    expect(host.name).toBe(typeof process.versions.bun === 'string' ? 'bun' : 'node')
    expect(host.execPath).toBe(process.execPath)
  })

  it('resolves auto and finds executables in PATH', () => {
    const host = { name: 'node', execPath: '/usr/bin/node', platform: process.platform } as const
    expect(resolveRuntime('auto', host)).toBe('node')
    expect(resolveRuntime(undefined, { ...host, name: 'bun' })).toBe('bun')
    expect(resolveRuntime('bun', host)).toBe('bun')
    expect(runtimeExecutable('node', host, {})).toBe('/usr/bin/node')

    const bin = join(directory.path, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'bun'), '#!/bin/sh\n')
    chmodSync(join(bin, 'bun'), 0o755)
    writeFileSync(join(bin, 'not-executable'), '')
    expect(runtimeExecutable('bun', host, { PATH: bin })).toBe(join(bin, 'bun'))
    expect(which('not-executable', { PATH: bin }, 'linux')).toBeUndefined()
    expect(which('bun', { PATH: '' })).toBeUndefined()
    expect(which(join(bin, 'missing'), {})).toBeUndefined()
  })

  it('enables source maps on Node.js only', () => {
    expect(runtimeArguments('node')).toEqual(['--enable-source-maps'])
    expect(runtimeArguments('node', ['--inspect'])).toEqual(['--enable-source-maps', '--inspect'])
    expect(runtimeArguments('bun', ['--inspect'])).toEqual(['--inspect'])
  })
})

describe('project resolution', () => {
  function fakePackage(name: string, source: string): void {
    const root = join(directory.path, 'node_modules', name)
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name, type: 'module', main: 'index.js' }))
    writeFileSync(join(root, 'index.js'), source)
  }

  it('prefers the version installed in the project', async () => {
    fakePackage('fake-tool', 'export const origin = "project"\n')
    expect(resolveFromProject('fake-tool', directory.path)).toEndWith(join('fake-tool', 'index.js'))
    const module = (await importFromProject('fake-tool', directory.path, () => Promise.resolve({ origin: 'cli' }))) as {
      origin: string
    }
    expect(module.origin).toBe('project')
  })

  it('falls back to the CLI dependency', async () => {
    const module = (await importFromProject('fake-tool', directory.path, () => Promise.resolve({ origin: 'cli' }))) as {
      origin: string
    }
    expect(module.origin).toBe('cli')
  })

  it('does not hide a broken project install behind the fallback', async () => {
    fakePackage('broken-tool', 'throw new Error("broken install")\n')
    await expect(importFromProject('broken-tool', directory.path, () => Promise.resolve({}))).rejects.toThrow(
      'broken install',
    )
  })
})

describe('vite helpers', () => {
  it('finds the config file', () => {
    expect(findViteConfig(directory.path)).toBeUndefined()
    writeFileSync(join(directory.path, 'vite.config.mts'), '')
    expect(findViteConfig(directory.path)).toBe(join(directory.path, 'vite.config.mts'))
    expect(findViteConfig(directory.path, 'custom.ts')).toBe(join(directory.path, 'custom.ts'))
  })

  it('reads the options of znight() through api.getOptions()', async () => {
    writeFileSync(join(directory.path, 'vite.config.ts'), '')
    const plugin = { name: 'znight', api: { getOptions: () => ({ prune: true }) } }
    const vite = new FakeVite({ configPlugins: [false, null, [plugin]] })
    const lookup = await readZnightPluginOptions(vite, directory.path)
    expect(lookup).toEqual({
      configFile: join(directory.path, 'vite.config.ts'),
      found: true,
      options: { prune: true },
    })
  })

  it('tracks the entry chunk of a build', () => {
    const tracker = createOutputTracker('/app')
    expect(tracker.entry()).toBeUndefined()
    const hook = tracker.plugin.writeBundle as (options: unknown, bundle: unknown) => void
    hook({ dir: '/app/dist' }, { 'chunk.js': { type: 'chunk', isEntry: false, name: 'chunk', fileName: 'chunk.js' } })
    expect(tracker.entry()).toBeUndefined()
    hook(
      { dir: '/app/dist' },
      {
        'other.js': { type: 'chunk', isEntry: true, name: 'other', fileName: 'other.js' },
        'main.js': { type: 'chunk', isEntry: true, name: 'main', fileName: 'main.js' },
        'style.css': { type: 'asset', fileName: 'style.css' },
      },
    )
    expect(tracker.entry()).toBe('/app/dist/main.js')
    hook(
      { file: 'out/server.js' },
      { 'server.js': { type: 'chunk', isEntry: true, name: 'server', fileName: 'server.js' } },
    )
    expect(tracker.entry()).toBe('/app/out/server.js')
  })

  it('formats build errors', () => {
    expect(formatBuildError('plain')).toBe('plain')
    const error = Object.assign(new Error('Unexpected token'), {
      plugin: 'vite:oxc',
      loc: { file: '/app/src/a.ts', line: 2, column: 4 },
      frame: '2 | const = 1',
    })
    expect(formatBuildError(error)).toBe('[vite:oxc] Unexpected token\n  --> /app/src/a.ts:2:4\n2 | const = 1')
    // Vite already added the location and the frame to the message
    const enhanced = Object.assign(new Error('Unexpected token\nfile: /app/src/a.ts\n2 | const = 1'), {
      id: '/app/src/a.ts',
      frame: '2 | const = 1',
    })
    expect(formatBuildError(enhanced)).toBe(enhanced.message)
  })
})

describe('watching', () => {
  it('computes glob bases and watch targets', () => {
    expect(globBase('src/**/*.{ts,tsx,mts}')).toBe('src')
    expect(globBase('apps/api/src/**/*.ts')).toBe('apps/api/src')
    expect(globBase('**/*.ts')).toBe('.')
    expect(globBase('src/main.ts')).toBe('src')
    expect(watchTargets('/app', ['src/**/*.ts', 'src/users/**/*.ts', 'lib/*.ts'])).toEqual([
      { path: '/app/lib', recursive: true },
      { path: '/app/src', recursive: true },
      { path: '/app', recursive: false },
    ])
    expect(watchTargets('/app', ['**/*.ts'])).toEqual([{ path: '/app', recursive: true }])
  })

  it('ignores irrelevant changes', () => {
    expect(isRelevantChange('users/user.service.ts')).toBe(true)
    expect(isRelevantChange('tsconfig.json')).toBe(true)
    expect(isRelevantChange('a.mts')).toBe(true)
    expect(isRelevantChange('.znight/container.generated.ts')).toBe(false)
    expect(isRelevantChange('node_modules/x/index.ts')).toBe(false)
    expect(isRelevantChange('dist/main.js')).toBe(false)
    expect(isRelevantChange('README.md')).toBe(false)
  })

  it('reports file changes', async () => {
    const src = join(directory.path, 'src')
    mkdirSync(join(src, 'deep'), { recursive: true })
    const changes: string[] = []
    const watcher = watchFiles(
      [
        { path: src, recursive: true },
        { path: join(directory.path, 'missing'), recursive: true },
      ],
      file => changes.push(file),
    )
    try {
      await new Promise(resolve => setTimeout(resolve, 50))
      writeFileSync(join(src, 'deep', 'a.ts'), 'export {}')
      writeFileSync(join(src, 'notes.md'), '')
      await waitFor(() => changes.some(file => file.endsWith('a.ts')), 3000)
      expect(changes.every(file => file.endsWith('.ts'))).toBe(true)
    } finally {
      watcher.close()
    }
  })
})

describe('prompts', () => {
  it('adapts @clack/prompts', async () => {
    const prompts = await loadPrompts()
    for (const method of ['intro', 'outro', 'text', 'select', 'multiselect', 'confirm', 'spinner', 'note'] as const) {
      expect(prompts[method]).toBeFunction()
    }
  })
})

describe('formatting', () => {
  it('formats durations, sizes and counts', () => {
    expect(formatDuration(12.4)).toBe('12ms')
    expect(formatDuration(1240)).toBe('1.24s')
    expect(formatDuration(125_000)).toBe('2m 05s')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1500)).toBe('1.50 kB')
    expect(formatBytes(2_310_000)).toBe('2.31 MB')
    expect(plural(1, 'provider')).toBe('1 provider')
    expect(plural(3, 'provider')).toBe('3 providers')
  })
})
