import { chmodSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createProcessService, runProcess, spawnProcess } from '../src/integrations/process.ts'
import { loadPrompts } from '../src/integrations/prompts.ts'
import { importFromProject, resolveFromProject } from '../src/integrations/resolve.ts'
import {
  createOutputTracker,
  findViteConfig,
  formatBuildError,
  projectRootPlugin,
  readZnightPluginOptions,
} from '../src/integrations/vite.ts'
import {
  changeKind,
  classifyChanges,
  realPath,
  TargetWatchers,
  toPosixPath,
  type WatchFactory,
  watchFiles,
  watchTargets,
} from '../src/integrations/watch.ts'
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
      options: { prune: true, root: directory.path },
    })
  })

  it('reads the options the znight() plugin compiles with, as resolved by Vite', async () => {
    writeFileSync(join(directory.path, 'vite.config.ts'), '')
    const options = { root: 'server', outFile: 'src/di.ts' }
    const vite = new FakeVite({
      configRoot: 'app',
      configAlias: [
        { find: '@', replacement: '/repo/src' },
        { find: /^~/, replacement: '/repo' },
      ],
      configPlugins: [{ name: 'znight', api: { options } }],
    })
    const lookup = await readZnightPluginOptions(vite, directory.path, undefined, 'native')
    // `root` of the plugin against the Vite root, string aliases only
    expect(lookup?.options).toEqual({
      root: join(directory.path, 'app/server'),
      outFile: 'src/di.ts',
      aliases: [{ find: '@', replacement: '/repo/src' }],
    })
    expect(vite.resolvedConfigs[0]).toMatchObject({
      configFile: join(directory.path, 'vite.config.ts'),
      configLoader: 'native',
      mode: 'production',
    })
    expect(vite.resolvedConfigs[0]?.root).toBeUndefined()

    // the compiler of the plugin: its resolved root, aliases and runtime conditions
    const compiler = {
      options: {
        root: '/real/app/server',
        aliases: [{ find: '#lib', replacement: '/real/lib' }],
        runtimeConditions: ['module', 'node', 'production', 'import', 'default'],
      },
    }
    const exposed = new FakeVite({ configPlugins: [{ name: 'znight', api: { options, compiler } }] })
    expect((await readZnightPluginOptions(exposed, directory.path))?.options).toEqual({
      root: '/real/app/server',
      outFile: 'src/di.ts',
      aliases: [{ find: '#lib', replacement: '/real/lib' }],
      runtimeConditions: ['module', 'node', 'production', 'import', 'default'],
    })
  })

  it('leaves NODE_ENV alone when resolving the Vite config', async () => {
    writeFileSync(join(directory.path, 'vite.config.ts'), '')
    const vite = new FakeVite({ configPlugins: [] })
    const resolveConfig = vite.resolveConfig
    const before = process.env['NODE_ENV']
    try {
      for (const value of [undefined, 'test']) {
        if (value === undefined) delete process.env['NODE_ENV']
        else process.env['NODE_ENV'] = value
        const api = {
          build: (config: never) => vite.build(config),
          // like Vite: NODE_ENV defaults to the command's
          resolveConfig: (...args: Parameters<typeof resolveConfig>) => {
            process.env['NODE_ENV'] ??= 'production'
            return resolveConfig(...args)
          },
        }
        expect((await readZnightPluginOptions(api, directory.path))?.found).toBe(false)
        expect(process.env['NODE_ENV']).toBe(value)
      }
    } finally {
      if (before === undefined) delete process.env['NODE_ENV']
      else process.env['NODE_ENV'] = before
    }
  })

  it('resolves the Vite root of the config file against the project root', () => {
    const plugin = projectRootPlugin('/repo/app')
    const hook = plugin.config as { order: string; handler: (config: { root?: string }) => { root: string } }
    expect(hook.order).toBe('pre')
    expect(hook.handler({})).toEqual({ root: '/repo/app' })
    expect(hook.handler({ root: 'web' })).toEqual({ root: '/repo/app/web' })
    expect(hook.handler({ root: '/elsewhere' })).toEqual({ root: '/elsewhere' })
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
  it('computes the watch targets from the include roots and the files of the last compile', () => {
    // the include roots recursively (nested ones dropped), the project root flat
    expect(watchTargets('/app', ['/app/src', '/app/lib', '/app/src/users'])).toEqual([
      { path: '/app/lib', recursive: true },
      { path: '/app/src', recursive: true },
      { path: '/app', recursive: false },
    ])
    expect(watchTargets('/app', ['/app'])).toEqual([{ path: '/app', recursive: true }])
    // the directories of the files of the last compile outside the include roots
    expect(
      watchTargets(
        '/app',
        ['/app/src', '/libs/shared/src'],
        [
          '/app/src/a.ts',
          '/app/package.json',
          '/libs/shared/src/index.ts',
          '/libs/shared/package.json',
          '/app/node_modules/@acme/compiled/package.json',
          '/app/node_modules/@acme/compiled/dist/znight.providers.json',
        ],
      ),
    ).toEqual([
      { path: '/app/src', recursive: true },
      { path: '/libs/shared/src', recursive: true },
      { path: '/app', recursive: false },
      { path: '/app/node_modules/@acme/compiled', recursive: false },
      { path: '/app/node_modules/@acme/compiled/dist', recursive: false },
      { path: '/libs/shared', recursive: false },
    ])
  })

  it('resolves real paths, also of deleted files', () => {
    const real = realpathSync(directory.path)
    const link = join(directory.path, 'link')
    mkdirSync(join(directory.path, 'target'))
    symlinkSync(join(directory.path, 'target'), link)
    expect(realPath(join(link, 'a.ts'))).toBe(`${real}/target/a.ts`)
    expect(realPath(join(directory.path, 'gone/deeper/a.ts'))).toBe(`${real}/gone/deeper/a.ts`)
    expect(realPath(link)).toBe(`${real}/target`)
    expect(toPosixPath('C:\\repo\\src')).toBe('C:/repo/src')
  })

  it('tells the kind of an fs.watch event from the disk and the files of the last compile', () => {
    const root = realpathSync(directory.path)
    const src = `${root}/src`
    mkdirSync(join(src, 'users'), { recursive: true })
    for (const file of ['users/user.service.ts', 'new.ts']) writeFileSync(join(src, file), '')
    const known = new Set([`${src}/users/user.service.ts`, `${src}/gone.ts`])
    expect(changeKind(`${src}/users/user.service.ts`, known)).toBe('changed')
    expect(changeKind(`${src}/new.ts`, known)).toBe('added')
    expect(changeKind(`${src}/gone.ts`, known)).toBe('removed')
    // a directory created or moved there (fs.watch reports the directory only), one deleted or moved away
    expect(changeKind(`${src}/users`, known)).toBe('added')
    rmSync(join(src, 'users'), { recursive: true })
    expect(changeKind(`${src}/users`, known)).toBe('removed')
    expect(changeKind(`${src}/users/user.service.ts`, known)).toBe('removed')
  })

  it('classifies changes, directories included', () => {
    const root = realpathSync(directory.path)
    const src = `${root}/src`
    mkdirSync(join(src, 'accounts'), { recursive: true })
    writeFileSync(join(src, 'accounts/user.service.ts'), '')
    writeFileSync(join(src, 'known.ts'), '')
    writeFileSync(join(src, 'new.ts'), '')
    const known = new Set([`${src}/known.ts`, `${src}/users/user.service.ts`, `${src}/users/user.controller.ts`])
    // `mv src/users src/accounts`
    expect(classifyChanges([`${src}/users`, `${src}/accounts`, `${src}/known.ts`, `${src}/new.ts`], known)).toEqual({
      changed: [`${src}/known.ts`],
      added: [`${src}/accounts`, `${src}/new.ts`],
      removed: [`${src}/users`, `${src}/users/user.service.ts`, `${src}/users/user.controller.ts`],
    })
    // an event on a directory itself (Windows, moved away and back): its known files are re-read
    expect(classifyChanges([src], known)).toEqual({
      changed: [`${src}/known.ts`],
      added: [src],
      removed: [`${src}/users/user.service.ts`, `${src}/users/user.controller.ts`],
    })
  })

  it('keeps one watcher per target, restarting the ones whose directory came back', () => {
    const started: string[] = []
    const closed: string[] = []
    const factory: WatchFactory = targets => {
      const names = targets.map(target => `${target.recursive ? 'r' : 'f'}:${target.path}`)
      started.push(...names)
      return { close: () => closed.push(...names) }
    }
    const src = join(directory.path, 'src')
    const lib = join(directory.path, 'lib')
    mkdirSync(src)
    const watchers = new TargetWatchers(factory, () => undefined)
    watchers.update([
      { path: src, recursive: true },
      { path: lib, recursive: true },
      { path: directory.path, recursive: false },
    ])
    expect(started).toEqual([`r:${src}`, `r:${lib}`, `f:${directory.path}`])
    // unchanged targets keep their watcher; a missing directory is watched once it exists
    watchers.update([
      { path: src, recursive: true },
      { path: lib, recursive: true },
      { path: directory.path, recursive: false },
    ])
    expect(started).toHaveLength(3)
    mkdirSync(lib)
    watchers.update(
      [
        { path: src, recursive: true },
        { path: lib, recursive: true },
      ],
      new Set([src]),
    )
    expect(started.slice(3)).toEqual([`r:${src}`, `r:${lib}`])
    expect(closed).toEqual([`f:${directory.path}`, `r:${src}`, `r:${lib}`])
    expect(watchers.targets).toEqual([
      { path: src, recursive: true },
      { path: lib, recursive: true },
    ])
    watchers.close()
    expect(closed.slice(3)).toEqual([`r:${src}`, `r:${lib}`])
  })

  it('reports file and directory changes', async () => {
    const src = join(directory.path, 'src')
    mkdirSync(join(src, 'deep'), { recursive: true })
    mkdirSync(join(src, 'users'), { recursive: true })
    writeFileSync(join(src, 'users', 'user.service.ts'), '')
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
      mkdirSync(join(src, '.znight'))
      writeFileSync(join(src, '.znight', 'container.generated.ts'), '')
      renameSync(join(src, 'users'), join(src, 'accounts'))
      await waitFor(
        () =>
          changes.some(file => file.endsWith('a.ts')) &&
          changes.some(file => file.endsWith('users')) &&
          changes.some(file => file.endsWith('accounts')),
        3000,
      )
      expect(changes.some(file => file.includes('.znight'))).toBe(false)
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
