import type { Prompts } from '../src/integrations/prompts.ts'
import type { ProjectOptions } from '../src/scaffold/options.ts'

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { CancelledError } from '../src/errors.ts'
import { detectPackageManager, parseFeatures, runScript } from '../src/scaffold/options.ts'
import { renderProject } from '../src/scaffold/templates.ts'
import { FakeProcesses, fileTree, runCli, temporaryDirectory } from './helpers.ts'
import { afterEach, beforeEach, describe, expect, test as it } from 'bun:test'

const DEFAULTS: ProjectOptions = {
  name: 'my-service',
  packageManager: 'npm',
  adapter: 'node',
  features: ['config', 'observability'],
  znightVersion: '0.1.0',
}

function files(options: Partial<ProjectOptions> = {}): Map<string, string> {
  return new Map(renderProject({ ...DEFAULTS, ...options }).map(file => [file.path, file.content]))
}

function file(project: Map<string, string>, path: string): string {
  const content = project.get(path)
  if (content === undefined) throw new Error(`missing ${path}`)
  return content
}

function packageJson(project: Map<string, string>): {
  name: string
  type: string
  scripts: Record<string, string>
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
} {
  return JSON.parse(file(project, 'package.json'))
}

/** tsconfig.json is JSONC: drop the comment lines. */
function tsconfig(project: Map<string, string>): { compilerOptions: Record<string, unknown>; include: string[] } {
  const text = file(project, 'tsconfig.json')
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n')
  return JSON.parse(text)
}

describe('project templates', () => {
  it('default project (npm, node adapter, config + observability)', () => {
    expect(Object.fromEntries(files())).toMatchSnapshot()
  })

  it('bun, fastify, every feature', () => {
    expect(
      Object.fromEntries(
        files({ packageManager: 'bun', adapter: 'fastify', features: ['config', 'observability', 'messaging'] }),
      ),
    ).toMatchSnapshot()
  })

  it('yarn, express, no feature', () => {
    expect(Object.fromEntries(files({ packageManager: 'yarn', adapter: 'express', features: [] }))).toMatchSnapshot()
  })

  it('pnpm, hono, messaging only', () => {
    expect(
      Object.fromEntries(files({ packageManager: 'pnpm', adapter: 'hono', features: ['messaging'] })),
    ).toMatchSnapshot()
  })

  it('package.json: ESM, scripts, @znight/* in lockstep with the CLI', () => {
    const manifest = packageJson(files({ znightVersion: '1.2.3' }))
    expect(manifest.name).toBe('my-service')
    expect(manifest.type).toBe('module')
    expect(manifest.scripts).toEqual({
      dev: 'znight dev',
      build: 'znight build',
      start: 'znight start',
      generate: 'znight generate',
      typecheck: 'znight generate && tsc --noEmit',
      test: 'vitest run',
    })
    expect(manifest.dependencies['@znight/core']).toBe('^1.2.3')
    expect(manifest.dependencies['@znight/http']).toBe('^1.2.3')
    expect(manifest.dependencies['@znight/config']).toBe('^1.2.3')
    expect(manifest.dependencies['@znight/observability']).toBe('^1.2.3')
    expect(manifest.dependencies['@znight/messaging']).toBeUndefined()
    expect(manifest.dependencies['zod']).toStartWith('^4')
    expect(manifest.devDependencies['@znight/compiler']).toBe('^1.2.3')
    expect(manifest.devDependencies['@znight/cli']).toBe('^1.2.3')
    expect(manifest.devDependencies['@znight/testing']).toBe('^1.2.3')
    expect(manifest.devDependencies['vite']).toStartWith('^8')
    expect(manifest.devDependencies['typescript']).toStartWith('^7')
    expect(manifest.devDependencies['light-my-request']).toBeDefined()
  })

  it.each([
    ['node', [], ['light-my-request'], undefined],
    ['fastify', ['fastify'], [], 'adapter: fastifyAdapter(),'],
    ['express', ['express'], ['@types/express', 'light-my-request'], 'adapter: expressAdapter(),'],
    ['hono', ['hono', '@hono/node-server'], [], 'adapter: honoAdapter(),'],
  ] as const)('package.json: dependencies of the %s adapter', (adapter, dependencies, devDependencies, option) => {
    const manifest = packageJson(files({ adapter }))
    expect(dependencies.filter(name => manifest.dependencies[name] === undefined)).toEqual([])
    expect(devDependencies.filter(name => manifest.devDependencies[name] === undefined)).toEqual([])
    const main = file(files({ adapter }), 'src/main.ts')
    expect(main.includes('Adapter')).toBe(option !== undefined)
    expect(option === undefined || main.includes(option)).toBe(true)
  })

  it('bun projects test with bun:test and preload the compiler', () => {
    const project = files({ packageManager: 'bun' })
    expect(packageJson(project).scripts['test']).toBe('bun test')
    expect(packageJson(project).devDependencies['@types/bun']).toBeDefined()
    expect(packageJson(project).devDependencies['vitest']).toBeUndefined()
    expect(file(project, 'bunfig.toml')).toContain('preload = ["@znight/compiler/bun"]')
    expect(file(project, 'test/greeting.service.test.ts')).toContain("from 'bun:test'")
    expect(tsconfig(project).compilerOptions['types']).toEqual(['bun'])
  })

  it('other package managers test with Vitest (the znight() plugin regenerates the container)', () => {
    for (const packageManager of ['npm', 'pnpm', 'yarn'] as const) {
      const project = files({ packageManager })
      expect(project.has('bunfig.toml')).toBe(false)
      expect(packageJson(project).devDependencies['vitest']).toBeDefined()
      expect(file(project, 'test/greeting.controller.test.ts')).toContain("from 'vitest'")
    }
    expect(files({ packageManager: 'yarn' }).get('.yarnrc.yml')).toBe('nodeLinker: node-modules\n')
  })

  it('tsconfig.json: strict, decorators, bundler resolution, no emit', () => {
    const config = tsconfig(files())
    expect(config.compilerOptions).toMatchObject({
      strict: true,
      experimentalDecorators: true,
      moduleResolution: 'bundler',
      module: 'preserve',
      noEmit: true,
      verbatimModuleSyntax: true,
    })
    expect(config.compilerOptions['emitDecoratorMetadata']).toBeUndefined()
    expect(config.include).toEqual(['src', 'test', 'vite.config.ts'])
  })

  it('vite.config.ts uses the znight() plugin; .gitignore ignores the generated container', () => {
    const project = files()
    expect(file(project, 'vite.config.ts')).toContain("import { znight } from '@znight/compiler'")
    expect(file(project, 'vite.config.ts')).toContain('plugins: [znight()]')
    const ignored = file(project, '.gitignore').split('\n')
    for (const entry of ['node_modules', 'dist', '.znight']) expect(ignored).toContain(entry)
  })

  it('the sample application follows the features', () => {
    const minimal = files({ features: [] })
    expect(minimal.has('src/app/app.config.ts')).toBe(false)
    expect(file(minimal, 'src/main.ts')).toContain('HttpPlugin.configure({ port: Number(process.env.PORT ?? 3000) })')
    expect(file(minimal, 'src/app/greeting.service.ts')).not.toContain('constructor')

    const full = files({ features: ['config', 'observability', 'messaging'] })
    expect(file(full, 'src/main.ts')).toContain('port: container.get(AppConfig).port')
    expect(file(full, 'src/app/greeting.consumer.ts')).toContain("@Consumer('greetings')")
    expect(file(full, 'src/app/greeting.controller.ts')).toContain('private readonly broker: MessageBroker')
    expect(file(full, 'test/greeting.service.test.ts')).toContain("config: { app: { greeting: 'Hi' } }")
    expect(file(full, 'test/greeting.service.test.ts')).toContain('mocks.get(Logger).debug')
  })
})

describe('options', () => {
  it('parses --features', () => {
    expect(parseFeatures('config,observability')).toEqual({ features: ['config', 'observability'] })
    expect(parseFeatures(' Messaging , config ')).toEqual({ features: ['config', 'messaging'] })
    expect(parseFeatures('none')).toEqual({ features: [] })
    expect(parseFeatures('')).toEqual({ features: [] })
    expect(parseFeatures('all')).toEqual({ features: ['config', 'observability', 'messaging'] })
    expect(parseFeatures('config,graphql')).toEqual({ unknown: ['graphql'] })
  })

  it('detects the package manager', () => {
    expect(detectPackageManager({ npm_config_user_agent: 'pnpm/9.1.0 npm/? node/v24.0.0' }, false)).toBe('pnpm')
    expect(detectPackageManager({ npm_config_user_agent: 'yarn/4.5.0 npm/? node/v24.0.0' }, true)).toBe('yarn')
    expect(detectPackageManager({ npm_config_user_agent: 'bun/1.3.0 npm/? node/v24.0.0' }, false)).toBe('bun')
    expect(detectPackageManager({}, true)).toBe('bun')
    expect(detectPackageManager({}, false)).toBe('npm')
  })

  it('formats run commands', () => {
    expect(runScript('npm', 'dev')).toBe('npm run dev')
    expect(runScript('bun', 'dev')).toBe('bun run dev')
    expect(runScript('pnpm', 'dev')).toBe('pnpm dev')
    expect(runScript('yarn', 'dev')).toBe('yarn dev')
  })
})

describe('znight new', () => {
  let workspace: { path: string; cleanup: () => void }

  beforeEach(() => {
    workspace = temporaryDirectory()
  })

  afterEach(() => workspace.cleanup())

  it('creates a project from flags', async () => {
    const processes = new FakeProcesses()
    const run = await runCli(
      [
        'new',
        'my-api',
        '--yes',
        '--pm',
        'bun',
        '--adapter',
        'fastify',
        '--features',
        'all',
        '--no-install',
        '--no-git',
      ],
      { cwd: workspace.path, services: { processes } },
    )
    expect(run.code).toBe(0)
    expect(run.stderr).toBe('')
    expect(run.stdout).toContain('✓ Created my-api (bun, fastify, config, observability, messaging) in my-api')
    expect(run.stdout).toContain('cd my-api')
    expect(run.stdout).toContain('bun install')
    expect(run.stdout).toContain('bun run dev')
    expect(processes.runs).toEqual([])
    const root = join(workspace.path, 'my-api')
    expect(fileTree(root)).toMatchSnapshot()
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    expect(manifest.name).toBe('my-api')
    expect(manifest.dependencies.fastify).toBeDefined()
    expect(manifest.dependencies['@znight/messaging']).toBe('^0.1.0')
    expect(readFileSync(join(root, 'vite.config.ts'), 'utf8')).toContain('znight()')
  })

  it('uses the defaults when not interactive', async () => {
    const run = await runCli(['new', 'svc', '--no-install', '--no-git'], { cwd: workspace.path })
    expect(run.code).toBe(0)
    const manifest = JSON.parse(readFileSync(join(workspace.path, 'svc/package.json'), 'utf8'))
    expect(manifest.scripts.test).toBe('vitest run') // npm: not running on Bun in this context
    expect(manifest.dependencies['@znight/config']).toBeDefined()
    expect(manifest.dependencies['@znight/observability']).toBeDefined()
    expect(manifest.dependencies['@znight/messaging']).toBeUndefined()
  })

  it('initialises git and installs the dependencies', async () => {
    const processes = new FakeProcesses()
    processes.runResult = (_command, args) => (args[0] === 'rev-parse' ? { code: 128, stdout: '' } : { code: 0 })
    const run = await runCli(['new', 'svc', '--pm', 'pnpm'], { cwd: workspace.path, services: { processes } })
    expect(run.code).toBe(0)
    const root = join(workspace.path, 'svc')
    expect(processes.runs).toEqual([
      { command: 'git', args: ['rev-parse', '--is-inside-work-tree'], cwd: root },
      { command: 'git', args: ['init', '--quiet'], cwd: root },
      { command: 'pnpm', args: ['install'], cwd: root },
    ])
    expect(run.stdout).toContain('✓ Initialised a git repository')
    expect(run.stdout).toContain('✓ Installed the dependencies')
    expect(run.stdout).not.toContain('pnpm install\n')
    expect(run.stdout).toContain('pnpm dev')
  })

  it('skips git init inside a repository and when git is missing', async () => {
    const inside = new FakeProcesses()
    inside.runResult = () => ({ code: 0, stdout: 'true\n' })
    const run = await runCli(['new', 'a', '--no-install'], { cwd: workspace.path, services: { processes: inside } })
    expect(run.code).toBe(0)
    expect(run.stderr).toContain('Already inside a git repository')
    expect(inside.runs.map(entry => entry.args[0])).toEqual(['rev-parse'])

    const missing = new FakeProcesses()
    missing.runResult = () => ({ code: null, error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) })
    const other = await runCli(['new', 'b', '--no-install'], { cwd: workspace.path, services: { processes: missing } })
    expect(other.code).toBe(0)
    expect(other.stderr).toContain('git is not available')
  })

  it('fails with exit code 1 when the installation fails, showing its output', async () => {
    const processes = new FakeProcesses()
    processes.runResult = command => (command === 'npm' ? { code: 1, stderr: 'npm ERR! 404 Not Found' } : { code: 0 })
    const run = await runCli(['new', 'svc', '--no-git'], { cwd: workspace.path, services: { processes } })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('npm install exited with code 1')
    expect(run.stderr).toContain('npm ERR! 404 Not Found')
    expect(run.stderr).toContain('The project was created but installing the dependencies failed')
    expect(existsSync(join(workspace.path, 'svc/package.json'))).toBe(true)
  })

  it('creates the project in the current directory with "."', async () => {
    const directory = join(workspace.path, 'Cool App')
    mkdirSync(join(directory, '.git'), { recursive: true })
    const run = await runCli(['new', '.', '--no-install', '--no-git'], { cwd: directory })
    expect(run.code).toBe(0)
    expect(JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).name).toBe('cool-app')
    expect(run.stdout).not.toContain('cd ')
  })

  it('honours --dir', async () => {
    const run = await runCli(['new', '@acme/api', '--dir', 'apps/api', '--no-install', '--no-git'], {
      cwd: workspace.path,
    })
    expect(run.code).toBe(0)
    expect(JSON.parse(readFileSync(join(workspace.path, 'apps/api/package.json'), 'utf8')).name).toBe('@acme/api')
    expect(run.stdout).toContain('cd apps/api')
  })

  it('creates a scoped package in a directory named after the unscoped name', async () => {
    const run = await runCli(['new', '@acme/api', '--no-install', '--no-git'], { cwd: workspace.path })
    expect(run.code).toBe(0)
    expect(existsSync(join(workspace.path, 'api/package.json'))).toBe(true)
  })

  it('refuses a non-empty directory unless --force', async () => {
    mkdirSync(join(workspace.path, 'taken'))
    writeFileSync(join(workspace.path, 'taken/notes.txt'), 'keep')
    const refused = await runCli(['new', 'taken', '--no-install', '--no-git'], { cwd: workspace.path })
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('taken is not empty')
    expect(refused.stderr).toContain('--force')
    expect(existsSync(join(workspace.path, 'taken/package.json'))).toBe(false)

    const forced = await runCli(['new', 'taken', '--force', '--no-install', '--no-git'], { cwd: workspace.path })
    expect(forced.code).toBe(0)
    expect(readFileSync(join(workspace.path, 'taken/notes.txt'), 'utf8')).toBe('keep')
    expect(existsSync(join(workspace.path, 'taken/package.json'))).toBe(true)
  })

  it('refuses a target that is a file', async () => {
    writeFileSync(join(workspace.path, 'file'), '')
    const run = await runCli(['new', 'file', '--no-install', '--no-git'], { cwd: workspace.path })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('file exists and is not a directory')
  })

  it('reports invalid names, missing names and unknown features as usage errors', async () => {
    const invalid = await runCli(['new', 'My App'], { cwd: workspace.path })
    expect(invalid.code).toBe(2)
    expect(invalid.stderr).toContain('Invalid project name "My App": the name must be lower case')
    expect(invalid.stderr).toContain('try "my-app"')

    const missing = await runCli(['new', '--yes'], { cwd: workspace.path })
    expect(missing.code).toBe(2)
    expect(missing.stderr).toContain('Missing project name')

    const features = await runCli(['new', 'x', '--features', 'config,graphql,grpc'], { cwd: workspace.path })
    expect(features.code).toBe(2)
    expect(features.stderr).toContain('Unknown features: graphql, grpc')
    expect(features.stderr).toContain('available features: config, observability, messaging')
    expect(existsSync(join(workspace.path, 'x'))).toBe(false)
  })

  it('asks the questions when interactive', async () => {
    const asked: string[] = []
    const prompts: Prompts = {
      intro: () => undefined,
      outro: message => void asked.push(`outro:${message}`),
      note: () => undefined,
      text: options => {
        asked.push(options.message)
        expect(options.validate?.('Bad Name')).toContain('lower case')
        return Promise.resolve('asked-app')
      },
      select: options => {
        asked.push(options.message)
        return Promise.resolve((options.message.startsWith('Package') ? 'yarn' : 'hono') as never)
      },
      multiselect: options => {
        asked.push(options.message)
        return Promise.resolve(['messaging'] as never)
      },
      confirm: options => {
        asked.push(options.message)
        return Promise.resolve(false)
      },
      spinner: () => ({ start: () => undefined, stop: () => undefined }),
    }
    const processes = new FakeProcesses()
    const run = await runCli(['new'], {
      cwd: workspace.path,
      interactive: true,
      services: { processes, loadPrompts: () => Promise.resolve(prompts) },
    })
    expect(run.code).toBe(0)
    expect(asked.slice(0, -1)).toEqual([
      'Project name?',
      'Package manager?',
      'HTTP adapter?',
      'Features? (space to toggle)',
      'Install the dependencies with yarn?',
      'Initialise a git repository?',
    ])
    expect(asked.at(-1)).toContain('yarn install')
    expect(processes.runs).toEqual([])
    const manifest = JSON.parse(readFileSync(join(workspace.path, 'asked-app/package.json'), 'utf8'))
    expect(manifest.dependencies.hono).toBeDefined()
    expect(manifest.dependencies['@znight/messaging']).toBeDefined()
    expect(manifest.dependencies['@znight/config']).toBeUndefined()
  })

  it('does not ask what the flags answer, and --yes disables the prompts', async () => {
    const asked: string[] = []
    const prompts = {
      intro: () => undefined,
      outro: () => undefined,
      note: () => undefined,
      confirm: (options: { message: string }) => {
        asked.push(options.message)
        return Promise.resolve(true)
      },
    } as unknown as Prompts
    const run = await runCli(
      ['new', 'flags', '--pm', 'npm', '--adapter', 'node', '--features', 'none', '--no-install', '--git'],
      { cwd: workspace.path, interactive: true, services: { loadPrompts: () => Promise.resolve(prompts) } },
    )
    expect(run.code).toBe(0)
    expect(asked).toEqual([])

    const yes = await runCli(['new', 'quiet', '--yes', '--no-install', '--no-git'], {
      cwd: workspace.path,
      interactive: true,
      services: { loadPrompts: () => Promise.reject(new Error('must not prompt')) },
    })
    expect(yes.code).toBe(0)
  })

  it('exits with 130 when a prompt is cancelled', async () => {
    const prompts = {
      intro: () => undefined,
      text: () => Promise.reject(new CancelledError('Operation cancelled')),
    } as unknown as Prompts
    const run = await runCli(['new'], {
      cwd: workspace.path,
      interactive: true,
      services: { loadPrompts: () => Promise.resolve(prompts) },
    })
    expect(run.code).toBe(130)
    expect(run.stderr).toContain('Operation cancelled')
  })
})
