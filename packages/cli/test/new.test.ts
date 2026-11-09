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

  it('npm, node, schedule + openapi', () => {
    expect(Object.fromEntries(files({ features: ['schedule', 'openapi'] }))).toMatchSnapshot()
  })

  it('npm, fastify, observability + openapi (swagger) + graphql + websocket', () => {
    expect(
      Object.fromEntries(
        files({
          adapter: 'fastify',
          features: ['observability', 'openapi', 'graphql', 'websocket'],
          openapiUi: 'swagger',
        }),
      ),
    ).toMatchSnapshot()
  })

  it('schedule: the plugin before HttpPlugin, a sample job and its test-clock test', () => {
    const project = files({ packageManager: 'bun', features: ['config', 'schedule'] })
    expect(packageJson(project).dependencies['@znight/schedule']).toBe('^0.1.0')
    const main = file(project, 'src/main.ts')
    expect(main).toContain("import { SchedulePlugin } from '@znight/schedule'")
    expect(main.indexOf('SchedulePlugin.configure()')).toBeLessThan(main.indexOf('HttpPlugin.configure('))
    expect(file(project, 'src/app/heartbeat.jobs.ts')).toContain("@Cron('* * * * *', { name: 'heartbeat' })")
    const test = file(project, 'test/heartbeat.jobs.test.ts')
    expect(test).toContain("import { createTestClock } from '@znight/schedule/testing'")
    expect(test).toContain("import { describe, expect, test } from 'bun:test'")
    expect(test).toContain('only: [HeartbeatJobs]')
    expect(file(files({ features: ['schedule'] }), 'test/heartbeat.jobs.test.ts')).toContain("from 'vitest'")
    expect(file(project, 'README.md')).toContain('g job reports/digest')
  })

  it('openapi: the plugin after HttpPlugin, src/api.ts and the openapi scripts', () => {
    const project = files({ features: ['openapi'] })
    const manifest = packageJson(project)
    expect(manifest.dependencies['@znight/openapi']).toBe('^0.1.0')
    expect(manifest.scripts['openapi']).toBe('znight openapi')
    expect(manifest.scripts['openapi:check']).toBe('znight openapi --check')
    const main = file(project, 'src/main.ts')
    expect(main.indexOf("OpenApiPlugin.configure({ ui: 'scalar' })")).toBeGreaterThan(
      main.indexOf('HttpPlugin.configure('),
    )
    expect(file(project, 'src/api.ts')).toContain('@OpenApiDocument({')
    expect(file(project, 'README.md')).toContain('| `npm run openapi` | Write `openapi.json`')
    expect(project.has('src/app/heartbeat.jobs.ts')).toBe(false)
  })

  it('observability: ObservabilityPlugin is named after the service, metrics and tracing options commented out', () => {
    const main = file(files({ name: 'my-service' }), 'src/main.ts')
    expect(main).toContain(`    ObservabilityPlugin.configure({
      logging: {
        name: 'my-service',
      },
      // metrics: {
      //   // options of the metrics registry
      // },
      // tracing: {
      //   // options of the tracer
      // },
    }),
`)
    expect(main.indexOf('ObservabilityPlugin.configure(')).toBeLessThan(main.indexOf('HttpPlugin.configure('))
    expect(file(files({ name: '@acme/orders' }), 'src/main.ts')).toContain("        name: '@acme/orders',\n")
    // renderProject() is public: any name is quoted safely
    expect(file(files({ name: "it's\\a\nname" }), 'src/main.ts')).toContain("        name: 'it\\'s\\\\a\\nname',\n")
    expect(file(files({ features: [] }), 'src/main.ts')).not.toContain('ObservabilityPlugin')
  })

  it.each([
    [undefined, 'scalar', 'Scalar'],
    ['scalar', 'scalar', 'Scalar'],
    ['swagger', 'swagger', 'Swagger UI'],
  ] as const)('openapi: the %s UI option configures the %s UI', (openapiUi, ui, label) => {
    const project = files({ features: ['openapi'], ...(openapiUi === undefined ? {} : { openapiUi }) })
    const main = file(project, 'src/main.ts')
    expect(main).toContain(`    OpenApiPlugin.configure({ ui: '${ui}' }),`)
    expect(main).toContain(`the API reference at /docs, with ${label}`)
    expect(file(project, 'README.md')).toContain(`${label} API reference at \`/docs\``)
  })

  it('graphql: @znight/graphql and graphql, GraphQLPlugin after HttpPlugin, a code-first resolver and its test', () => {
    const project = files({ packageManager: 'bun', features: ['config', 'observability', 'graphql'] })
    const manifest = packageJson(project)
    expect(manifest.dependencies['@znight/graphql']).toBe('^0.1.0')
    expect(manifest.dependencies['graphql']).toStartWith('^17')
    const main = file(project, 'src/main.ts')
    expect(main).toContain("import { GraphQLPlugin } from '@znight/graphql'")
    expect(main.indexOf('GraphQLPlugin.configure()')).toBeGreaterThan(main.indexOf('HttpPlugin.configure('))
    const resolver = file(project, 'src/app/greeting.resolver.ts')
    expect(resolver).toContain("import { Args, Query, Resolver } from '@znight/graphql'")
    expect(resolver).toContain('@Resolver()')
    expect(resolver).toContain("greeting(@Args('name') name: string): Greeting {")
    const test = file(project, 'test/greeting.resolver.test.ts')
    expect(test).toContain("import { executeOperation } from '@znight/graphql/testing'")
    expect(test).toContain('        GraphQLPlugin.configure(),')
    expect(test).toContain('{ greeting(name: "Ada") { message } }')
    expect(file(project, 'README.md')).toContain('curl localhost:3000/graphql')
    const without = files()
    expect(without.has('src/app/greeting.resolver.ts')).toBe(false)
    expect(packageJson(without).dependencies['graphql']).toBeUndefined()
    expect(file(without, 'src/main.ts')).not.toContain('GraphQLPlugin')
  })

  it('websocket: @znight/websocket and ws, WebSocketPlugin after HttpPlugin, a gateway and its test', () => {
    const project = files({ features: ['websocket'] })
    const manifest = packageJson(project)
    expect(manifest.dependencies['@znight/websocket']).toBe('^0.1.0')
    expect(manifest.dependencies['ws']).toStartWith('^8')
    const main = file(project, 'src/main.ts')
    expect(main).toContain("import { WebSocketPlugin } from '@znight/websocket'")
    expect(main.indexOf('WebSocketPlugin.configure()')).toBeGreaterThan(main.indexOf('HttpPlugin.configure('))
    const gateway = file(project, 'src/app/greeting.gateway.ts')
    expect(gateway).toContain("@Gateway('/ws')")
    expect(gateway).toContain("@OnMessage('greet')")
    expect(gateway).toContain('@Payload(CreateGreeting) input: CreateGreeting')
    const test = file(project, 'test/greeting.gateway.test.ts')
    expect(test).toContain("from 'vitest'")
    expect(test).toContain("const client = await app.connect('/ws')")
    expect(test).toContain("rejects.toMatchObject({ code: 'BAD_REQUEST' })")
    expect(files().has('src/app/greeting.gateway.ts')).toBe(false)
    expect(packageJson(files()).dependencies['ws']).toBeUndefined()
  })

  it('docker: a multi-stage Dockerfile on Node.js (npm), production dependencies only, non-root', () => {
    const project = files()
    const dockerfile = file(project, 'Dockerfile')
    expect(dockerfile).toContain('FROM node:24-slim AS base')
    expect(dockerfile).toContain('FROM base AS deps\nCOPY package.json package-lock.json ./\n')
    // npm keeps the optional peers that dev dependencies satisfy (the compiler) unless they are gone
    expect(dockerfile).toContain('RUN npm pkg delete devDependencies && npm ci --omit=dev')
    expect(dockerfile).toContain('FROM base AS build\nCOPY package.json package-lock.json ./\nRUN npm ci\nCOPY . .\n')
    expect(dockerfile).toContain('RUN npm run build')
    const runtime = dockerfile.slice(dockerfile.lastIndexOf('FROM '))
    expect(runtime).toStartWith('FROM node:24-slim\n')
    expect(runtime).toContain('ENV NODE_ENV=production')
    expect(runtime).toContain('COPY --from=deps /app/node_modules ./node_modules')
    expect(runtime).toContain('COPY --from=build /app/dist ./dist')
    expect(runtime).toContain('USER node')
    expect(runtime).toContain('EXPOSE 3000')
    expect(runtime).toContain('HEALTHCHECK ')
    expect(runtime).toContain("/health').then(r => process.exit(r.ok ? 0 : 1)")
    expect(runtime).toContain('CMD ["node", "--enable-source-maps", "dist/main.js"]')
    expect(dockerfile).toContain('docker build -t my-service .')
    const ignored = file(project, '.dockerignore').split('\n')
    for (const entry of ['node_modules', 'dist', '**/.znight', '.env', '.env.*', '.git'])
      expect(ignored).toContain(entry)
    expect(file(project, 'README.md')).toContain('docker run --rm -p 3000:3000 my-service')
  })

  it('docker: Bun images run the bundle on Bun without its own .env loading', () => {
    const dockerfile = file(files({ packageManager: 'bun', name: '@acme/api' }), 'Dockerfile')
    expect(dockerfile).toContain('FROM oven/bun:1 AS base')
    expect(dockerfile).toContain('RUN bun install --frozen-lockfile --production --omit=peer')
    expect(dockerfile).toContain('RUN bun install --frozen-lockfile\n')
    expect(dockerfile).toContain('RUN bun run build')
    expect(dockerfile).toContain('FROM oven/bun:1-slim\n')
    expect(dockerfile).toContain('USER bun')
    expect(dockerfile).toContain('CMD ["bun", "--no-env-file", "dist/main.js"]')
    expect(dockerfile).toContain('CMD ["bun", "-e", ')
    expect(dockerfile).toContain('docker build -t acme-api .')
  })

  it.each([
    ['pnpm', 'pnpm@10', 'package.json pnpm-lock.yaml', 'pnpm install --frozen-lockfile --prod', 'pnpm run build'],
    ['yarn', 'yarn@4', 'package.json yarn.lock .yarnrc.yml', 'yarn workspaces focus --all --production', 'yarn build'],
  ] as const)('docker: %s through Corepack', (packageManager, tool, manifests, production, build) => {
    const dockerfile = file(files({ packageManager }), 'Dockerfile')
    expect(dockerfile).toContain(`RUN corepack enable && corepack install --global ${tool}`)
    expect(dockerfile).toContain(`COPY ${manifests} ./`)
    expect(dockerfile).toContain(`RUN ${production}`)
    expect(dockerfile).toContain(`RUN ${build}`)
    expect(dockerfile).toContain('USER node')
  })

  it('docker: no Dockerfile with docker: false', () => {
    const project = files({ docker: false })
    expect(project.has('Dockerfile')).toBe(false)
    expect(project.has('.dockerignore')).toBe(false)
    expect(file(project, 'README.md')).not.toContain('## Docker')
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

  it('znight.config.ts holds the compiler options shared by the Vite plugin, the Bun preload and the CLI', () => {
    const bun = file(files({ packageManager: 'bun' }), 'znight.config.ts')
    expect(bun).toContain("import type { ZnightOptions } from '@znight/compiler'")
    expect(bun).toContain('} satisfies ZnightOptions')
    expect(bun).toContain('the Bun preload of the\n// tests (bunfig.toml)')
    expect(file(files({ packageManager: 'npm' }), 'znight.config.ts')).toContain('also used by Vitest')
  })

  it('bun projects test with bun:test and preload the compiler', () => {
    const project = files({ packageManager: 'bun' })
    expect(packageJson(project).scripts['test']).toBe('bun test')
    // `bun run dev` runs the znight binary (node shebang) on Node.js: the application runtime is explicit
    expect(packageJson(project).scripts['dev']).toBe('znight dev --runtime bun')
    expect(packageJson(project).scripts['start']).toBe('znight start --runtime bun')
    expect(packageJson(project).devDependencies['@types/bun']).toBeDefined()
    expect(packageJson(project).devDependencies['vitest']).toBeUndefined()
    expect(file(project, 'bunfig.toml')).toContain('preload = ["@znight/compiler/bun"]')
    expect(file(project, 'test/greeting.service.test.ts')).toContain("from 'bun:test'")
    expect(tsconfig(project).compilerOptions['types']).toEqual(['bun'])
  })

  it('bun projects leave the .env files to @znight/config (Bun would load them first, with its own precedence)', () => {
    const bunfig = file(files({ packageManager: 'bun' }), 'bunfig.toml')
    // a top-level key: before the [test] table
    expect(bunfig.indexOf('env = false\n')).toBeGreaterThanOrEqual(0)
    expect(bunfig.indexOf('env = false\n')).toBeLessThan(bunfig.indexOf('[test]'))
    // without @znight/config, nothing loads them but Bun
    expect(file(files({ packageManager: 'bun', features: [] }), 'bunfig.toml')).not.toContain('env = false')
  })

  it('the TestApp test turns metrics off (no server colliding on :9464, no prom-client needed)', () => {
    const test = file(files(), 'test/greeting.controller.test.ts')
    expect(test).toContain("ObservabilityPlugin.configure({ logging: { level: 'silent' }, metrics: false })")
    expect(file(files({ features: [] }), 'test/greeting.controller.test.ts')).not.toContain('ObservabilityPlugin')
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
    expect(config.include).toEqual(['src', 'test', 'vite.config.ts', 'znight.config.ts'])
    expect(config.compilerOptions['allowImportingTsExtensions']).toBe(true)
  })

  it('vite.config.ts uses the znight() plugin; .gitignore ignores the generated container', () => {
    const project = files()
    expect(file(project, 'vite.config.ts')).toContain("import { znight } from '@znight/compiler'")
    expect(file(project, 'vite.config.ts')).toContain("import options from './znight.config.ts'")
    expect(file(project, 'vite.config.ts')).toContain('plugins: [znight(options)]')
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
    expect(parseFeatures('all')).toEqual({
      features: ['config', 'observability', 'messaging', 'schedule', 'openapi', 'graphql', 'websocket'],
    })
    expect(parseFeatures('openapi,schedule')).toEqual({ features: ['schedule', 'openapi'] })
    expect(parseFeatures('websocket,graphql')).toEqual({ features: ['graphql', 'websocket'] })
    // application events are not a scaffold feature
    expect(parseFeatures('config,events')).toEqual({ unknown: ['events'] })
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
    expect(run.stdout).toContain(
      '✓ Created my-api (bun, fastify, config, observability, messaging, schedule, openapi, graphql, websocket) in my-api',
    )
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
    // Fastify by default, a Dockerfile, the Scalar UI when openapi is selected
    expect(manifest.dependencies.fastify).toBeDefined()
    expect(readFileSync(join(workspace.path, 'svc/src/main.ts'), 'utf8')).toContain('adapter: fastifyAdapter(),')
    expect(existsSync(join(workspace.path, 'svc/Dockerfile'))).toBe(true)
    expect(existsSync(join(workspace.path, 'svc/.dockerignore'))).toBe(true)
  })

  it('--openapi-ui, --no-docker and --adapter node answer their questions', async () => {
    const run = await runCli(
      [
        'new',
        'ui',
        '--features',
        'openapi',
        '--openapi-ui',
        'swagger',
        '--adapter',
        'node',
        '--no-docker',
        '--no-install',
        '--no-git',
      ],
      { cwd: workspace.path },
    )
    expect(run.code).toBe(0)
    const main = readFileSync(join(workspace.path, 'ui/src/main.ts'), 'utf8')
    expect(main).toContain("OpenApiPlugin.configure({ ui: 'swagger' })")
    expect(main).not.toContain('Adapter')
    expect(existsSync(join(workspace.path, 'ui/Dockerfile'))).toBe(false)

    const invalid = await runCli(['new', 'bad-ui', '--openapi-ui', 'redoc', '--no-install', '--no-git'], {
      cwd: workspace.path,
    })
    expect(invalid.code).toBe(2)
    expect(invalid.stderr).toContain('redoc')
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

    const features = await runCli(['new', 'x', '--features', 'config,events,grpc'], { cwd: workspace.path })
    expect(features.code).toBe(2)
    expect(features.stderr).toContain('Unknown features: events, grpc')
    expect(features.stderr).toContain(
      'available features: config, observability, messaging, schedule, openapi, graphql, websocket',
    )
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
      'Add a Dockerfile (production image)?',
      'Install the dependencies with yarn?',
      'Initialise a git repository?',
    ])
    expect(asked.at(-1)).toContain('yarn install')
    expect(processes.runs).toEqual([])
    const manifest = JSON.parse(readFileSync(join(workspace.path, 'asked-app/package.json'), 'utf8'))
    expect(manifest.dependencies.hono).toBeDefined()
    expect(manifest.dependencies['@znight/messaging']).toBeDefined()
    expect(manifest.dependencies['@znight/config']).toBeUndefined()
    expect(existsSync(join(workspace.path, 'asked-app/Dockerfile'))).toBe(false) // confirm answered no
  })

  it('offers Fastify first and by default, every feature but events, and the OpenAPI UI when openapi is chosen', async () => {
    const selects: { message: string; values: string[]; initialValue: unknown }[] = []
    let featureChoices: string[] = []
    const prompts: Prompts = {
      intro: () => undefined,
      outro: () => undefined,
      note: () => undefined,
      text: () => Promise.resolve('ui-app'),
      select: options => {
        selects.push({
          message: options.message,
          values: options.choices.map(choice => choice.value),
          initialValue: options.initialValue,
        })
        return Promise.resolve(
          options.message.startsWith('OpenAPI') ? ('swagger' as never) : (options.initialValue as never),
        )
      },
      multiselect: options => {
        featureChoices = options.choices.map(choice => choice.value)
        return Promise.resolve(['observability', 'openapi', 'graphql', 'websocket'] as never)
      },
      confirm: options => Promise.resolve(options.message.startsWith('Add a Dockerfile')),
      spinner: () => ({ start: () => undefined, stop: () => undefined }),
    }
    const run = await runCli(['new', '--pm', 'npm'], {
      cwd: workspace.path,
      interactive: true,
      services: { processes: new FakeProcesses(), loadPrompts: () => Promise.resolve(prompts) },
    })
    expect(run.code).toBe(0)
    expect(selects).toEqual([
      { message: 'HTTP adapter?', values: ['fastify', 'node', 'express', 'hono'], initialValue: 'fastify' },
      { message: 'OpenAPI reference UI (served at /docs)?', values: ['scalar', 'swagger'], initialValue: 'scalar' },
    ])
    expect(featureChoices).toEqual([
      'config',
      'observability',
      'messaging',
      'schedule',
      'openapi',
      'graphql',
      'websocket',
    ])
    const root = join(workspace.path, 'ui-app')
    const main = readFileSync(join(root, 'src/main.ts'), 'utf8')
    expect(main).toContain('adapter: fastifyAdapter()')
    expect(main).toContain("OpenApiPlugin.configure({ ui: 'swagger' })")
    expect(main).toContain("        name: 'ui-app',")
    expect(main).toContain('GraphQLPlugin.configure()')
    expect(main).toContain('WebSocketPlugin.configure()')
    expect(existsSync(join(root, 'Dockerfile'))).toBe(true)
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
      ['new', 'flags', '--pm', 'npm', '--adapter', 'node', '--features', 'none', '--docker', '--no-install', '--git'],
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
