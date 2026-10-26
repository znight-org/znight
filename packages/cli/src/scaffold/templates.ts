/**
 * Files of a project created by `znight new`. Pure: {@link renderProject} returns the files for a set
 * of options, `create.ts` writes them. The sample application uses the public APIs of the
 * `@znight/*` packages exactly as documented in their READMEs.
 */
import type { Feature, HttpAdapterName, PackageManager, ProjectOptions } from './options.ts'

import { execBinary, runScript } from './options.ts'
import { versionOf } from './versions.ts'

/** A file of the new project. */
export interface ProjectFile {
  /** POSIX path relative to the project directory. */
  readonly path: string
  readonly content: string
}

interface Flags {
  readonly config: boolean
  readonly observability: boolean
  readonly messaging: boolean
  readonly adapter: HttpAdapterName
  readonly pm: PackageManager
  readonly bun: boolean
}

function flagsOf(options: ProjectOptions): Flags {
  const has = (feature: Feature): boolean => options.features.includes(feature)
  return {
    config: has('config'),
    observability: has('observability'),
    messaging: has('messaging'),
    adapter: options.adapter,
    pm: options.packageManager,
    bun: options.packageManager === 'bun',
  }
}

/** Every file of a new project, sorted by path. */
export function renderProject(options: ProjectOptions): ProjectFile[] {
  const flags = flagsOf(options)
  const files: ProjectFile[] = [
    { path: 'package.json', content: packageJson(options, flags) },
    { path: 'tsconfig.json', content: tsconfigJson(flags) },
    { path: 'vite.config.ts', content: viteConfig() },
    { path: 'znight.config.ts', content: znightConfig(flags) },
    { path: '.gitignore', content: gitignore() },
    { path: 'README.md', content: readme(options, flags) },
    { path: 'src/main.ts', content: mainTs(flags) },
    { path: 'src/app/greeting.schemas.ts', content: greetingSchemas(flags) },
    { path: 'src/app/greeting.service.ts', content: greetingService(flags) },
    { path: 'src/app/greeting.controller.ts', content: greetingController(flags) },
    { path: 'src/app/health.controller.ts', content: healthController() },
    { path: 'test/greeting.service.test.ts', content: greetingServiceTest(flags) },
    { path: 'test/greeting.controller.test.ts', content: greetingControllerTest(flags) },
  ]
  if (flags.config) files.push({ path: 'src/app/app.config.ts', content: appConfig() })
  if (flags.messaging) files.push({ path: 'src/app/greeting.consumer.ts', content: greetingConsumer(flags) })
  if (flags.bun) files.push({ path: 'bunfig.toml', content: bunfig(flags) })
  if (flags.pm === 'yarn') files.push({ path: '.yarnrc.yml', content: 'nodeLinker: node-modules\n' })
  return files.sort((a, b) => (a.path < b.path ? -1 : 1))
}

// ---------------------------------------------------------------------------------------------------
// configuration files

function sortRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)))
}

function packageJson(options: ProjectOptions, flags: Flags): string {
  const znight = `^${options.znightVersion}`
  const dependencies: Record<string, string> = {
    '@znight/core': znight,
    '@znight/http': znight,
    zod: versionOf('zod'),
  }
  if (flags.config) dependencies['@znight/config'] = znight
  if (flags.observability) dependencies['@znight/observability'] = znight
  if (flags.messaging) dependencies['@znight/messaging'] = znight
  if (flags.adapter === 'fastify') dependencies['fastify'] = versionOf('fastify')
  if (flags.adapter === 'express') dependencies['express'] = versionOf('express')
  if (flags.adapter === 'hono') {
    dependencies['hono'] = versionOf('hono')
    dependencies['@hono/node-server'] = versionOf('@hono/node-server')
  }
  const devDependencies: Record<string, string> = {
    '@types/node': versionOf('@types/node'),
    '@znight/cli': znight,
    '@znight/compiler': znight,
    '@znight/testing': znight,
    typescript: versionOf('typescript'),
    vite: versionOf('vite'),
  }
  if (flags.bun) devDependencies['@types/bun'] = versionOf('@types/bun')
  else devDependencies['vitest'] = versionOf('vitest')
  if (flags.adapter === 'express') devDependencies['@types/express'] = versionOf('@types/express')
  // in-memory requests (TestApp.inject) with the node and express adapters
  if (flags.adapter === 'node' || flags.adapter === 'express') {
    devDependencies['light-my-request'] = versionOf('light-my-request')
  }
  const manifest = {
    name: options.name,
    version: '0.1.0',
    private: true,
    type: 'module',
    engines: { node: '>=24' },
    scripts: {
      // `bun run` honours the node shebang of the znight binary: the runtime has to be explicit
      dev: flags.bun ? 'znight dev --runtime bun' : 'znight dev',
      build: 'znight build',
      start: flags.bun ? 'znight start --runtime bun' : 'znight start',
      generate: 'znight generate',
      typecheck: 'znight generate && tsc --noEmit',
      test: flags.bun ? 'bun test' : 'vitest run',
    },
    dependencies: sortRecord(dependencies),
    devDependencies: sortRecord(devDependencies),
  }
  return `${JSON.stringify(manifest, null, 2)}\n`
}

function tsconfigJson(flags: Flags): string {
  return `{
  "compilerOptions": {
    "target": "ES2024",
    "lib": ["ES2024", "ESNext.Disposable"],
    "module": "preserve",
    "moduleResolution": "bundler",
    "moduleDetection": "force",
    "types": ["${flags.bun ? 'bun' : 'node'}"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    // Znight decorators are TypeScript decorators: no emitDecoratorMetadata nor reflect-metadata
    "experimentalDecorators": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "noEmit": true,
    // vite.config.ts imports ./znight.config.ts (also loaded as is by Node.js and Bun)
    "allowImportingTsExtensions": true
  },
  "include": ["src", "test", "vite.config.ts", "znight.config.ts"]
}
`
}

function viteConfig(): string {
  return `import { znight } from '@znight/compiler'
import { defineConfig } from 'vite'

import options from './znight.config.ts'

// znight() generates the dependency injection container at build time and configures a server
// build: src/main.ts -> dist/main.js (Node.js 24 target, source maps).
export default defineConfig({
  plugins: [znight(options)],
})
`
}

function znightConfig(flags: Flags): string {
  const readers = flags.bun
    ? `// Options of the Znight compiler. The znight() Vite plugin (vite.config.ts), the Bun preload of the
// tests (bunfig.toml) and \`znight generate\` read them, so they all generate the same container.`
    : `// Options of the Znight compiler. The znight() Vite plugin (vite.config.ts, also used by Vitest)
// and \`znight generate\` read them, so they all generate the same container.`
  return `import type { ZnightOptions } from '@znight/compiler'

${readers}
// https://github.com/znight-org/znight/tree/main/packages/compiler#options
export default {
  // reportUnused: true, // warn about providers nothing uses (ZNIGHT019)
} satisfies ZnightOptions
`
}

function bunfig(flags: Flags): string {
  // Bun loads .env files into process.env with its own precedence, which then wins over dotenv()
  const env = flags.config
    ? `# @znight/config loads the .env files (dotenv()), the same way on Node.js and Bun: Bun's own
# loading would put them in process.env first, with its own precedence
env = false

`
    : ''
  return `${env}[test]
# Regenerates the DI container (src/.znight/container.generated.ts) before the tests run
preload = ["@znight/compiler/bun"]
`
}

function gitignore(): string {
  return `node_modules
dist
coverage
*.log

# generated by the Znight compiler (znight generate, vite build, bun test)
.znight

# local environment
.env.local
.env.*.local
`
}

// ---------------------------------------------------------------------------------------------------
// application

function adapterImport(adapter: HttpAdapterName): string | undefined {
  switch (adapter) {
    case 'fastify':
      return "import { fastifyAdapter } from '@znight/http/fastify'"
    case 'express':
      return "import { expressAdapter } from '@znight/http/express'"
    case 'hono':
      return "import { honoAdapter } from '@znight/http/hono'"
    default:
      return undefined
  }
}

function adapterCall(adapter: HttpAdapterName): string | undefined {
  return adapter === 'node' ? undefined : `${adapter}Adapter()`
}

function mainTs(flags: Flags): string {
  const imports = [
    flags.config ? "import { ConfigPlugin } from '@znight/config'" : undefined,
    "import { Application } from '@znight/core'",
    "import { HttpPlugin } from '@znight/http'",
    adapterImport(flags.adapter),
    flags.messaging ? "import { MessagingPlugin } from '@znight/messaging'" : undefined,
    flags.messaging ? "import { memory } from '@znight/messaging/memory'" : undefined,
    flags.observability ? "import { ObservabilityPlugin } from '@znight/observability'" : undefined,
  ].filter(line => line !== undefined)
  const localImports = [
    "import { __ZNIGHT_METADATA__ } from './.znight/container.generated.js'",
    flags.config ? "import { AppConfig } from './app/app.config.js'" : undefined,
  ].filter(line => line !== undefined)

  const plugins: string[] = []
  if (flags.observability) {
    plugins.push(
      '    // first, so that its hooks wrap everything: request logs, metrics (with prom-client), traces',
      '    ObservabilityPlugin.configure(),',
    )
  }
  if (flags.config) {
    plugins.push(
      '    // loads .env files and the environment, validates every @Config class before anything starts',
      '    ConfigPlugin.configure(),',
    )
  }
  if (flags.messaging) {
    plugins.push(
      '    // in-memory broker for development: use rabbitmq(), sqs() or kafka() in production',
      '    MessagingPlugin.configure({ driver: memory() }),',
    )
  }
  const adapter = adapterCall(flags.adapter)
  if (flags.config) {
    plugins.push(
      '    HttpPlugin.configure(container => ({',
      ...(adapter === undefined ? [] : [`      adapter: ${adapter},`]),
      '      port: container.get(AppConfig).port,',
      '    })),',
    )
  } else {
    const port = 'port: Number(process.env.PORT ?? 3000)'
    plugins.push(
      adapter === undefined
        ? `    HttpPlugin.configure({ ${port} }),`
        : `    HttpPlugin.configure({ adapter: ${adapter}, ${port} }),`,
    )
  }

  return `${imports.join('\n')}

${localImports.join('\n')}

const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins: [
${plugins.join('\n')}
  ],
})

// SIGINT / SIGTERM stop the application gracefully (in-flight requests are drained)
await app.start()
`
}

function appConfig(): string {
  return `import { Config, Env } from '@znight/config'

/**
 * Settings of the application, validated at boot by ConfigPlugin. Each property is read from the
 * environment (or a .env file): APP_<PROPERTY> by default, or the name given to @Env. Properties
 * with an initializer are optional; their type selects the coercion ("3000" -> 3000).
 */
@Config('app')
export class AppConfig {
  /** HTTP port (PORT). */
  @Env('PORT')
  port = 3000

  /** Greeting used by GreetingService (APP_GREETING). */
  greeting = 'Hello'
}
`
}

function greetingSchemas(flags: Flags): string {
  const usage = flags.messaging
    ? 'Body of POST /greetings and POST /greetings/async, payload of the "greetings" queue.'
    : 'Body of POST /greetings.'
  return `import { z } from 'zod'

/** ${usage} */
export const CreateGreeting = z.object({
  name: z.string().trim().min(1).max(100),
  excited: z.boolean().default(false),
})
export type CreateGreeting = z.output<typeof CreateGreeting>
`
}

function greetingService(flags: Flags): string {
  const imports = ["import { Injectable } from '@znight/core'"]
  if (flags.observability) imports.push("import { Logger } from '@znight/observability'")
  const local = flags.config ? "\nimport { AppConfig } from './app.config.js'\n" : ''
  const params: string[] = []
  if (flags.config) params.push('    private readonly config: AppConfig,')
  if (flags.observability) params.push('    private readonly logger: Logger,')
  let members = ''
  if (params.length > 0) {
    members = `  // dependencies are resolved at build time from the parameter types
  constructor(
${params.join('\n')}
  ) {}

`
  }
  const greeting = flags.config ? 'this.config.greeting' : "'Hello'"
  const log = flags.observability ? "    this.logger.debug('Greeting', { name, excited })\n" : ''
  return `${imports.join('\n')}
${local}
@Injectable()
export class GreetingService {
${members}  greet(name: string, excited = false): string {
${log}    return \`\${${greeting}}, \${name}\${excited ? '!' : '.'}\`
  }
}
`
}

function greetingController(flags: Flags): string {
  const httpImports = flags.messaging
    ? 'Body, Controller, Get, HttpCode, Param, Post, Query'
    : 'Body, Controller, Get, Param, Post, Query'
  const imports = [`import { ${httpImports} } from '@znight/http'`]
  if (flags.messaging) imports.push("import { MessageBroker } from '@znight/messaging'")
  const ctor = flags.messaging
    ? `  constructor(
    private readonly greetings: GreetingService,
    private readonly broker: MessageBroker,
  ) {}`
    : '  constructor(private readonly greetings: GreetingService) {}'
  const enqueue = flags.messaging
    ? `

  /** POST /greetings/async: published to the "greetings" queue, handled by GreetingConsumer. */
  @Post('/async')
  @HttpCode(202)
  async enqueue(@Body(CreateGreeting) input: CreateGreeting): Promise<{ id: string }> {
    const { id } = await this.broker.publish('greetings', input, { type: 'greeting.requested' })
    return { id }
  }`
    : ''
  return `${imports.join('\n')}

import { CreateGreeting } from './greeting.schemas.js'
import { GreetingService } from './greeting.service.js'

@Controller('/greetings')
export class GreetingController {
${ctor}

  /** GET /greetings/Ada?excited=true: route and query parameters are coerced to their types. */
  @Get('/:name')
  greet(@Param('name') name: string, @Query('excited') excited?: boolean): { message: string } {
    return { message: this.greetings.greet(name, excited) }
  }

  /** POST /greetings {"name": "Ada"}: the body is validated by the schema (400 otherwise). */
  @Post()
  create(@Body(CreateGreeting) input: CreateGreeting): { message: string } {
    return { message: this.greetings.greet(input.name, input.excited) }
  }${enqueue}
}
`
}

function healthController(): string {
  return `import { Controller, Get } from '@znight/http'

@Controller('/health')
export class HealthController {
  /** GET /health */
  @Get()
  check(): { status: 'ok'; uptime: number } {
    return { status: 'ok', uptime: Math.round(process.uptime()) }
  }
}
`
}

function greetingConsumer(flags: Flags): string {
  const imports = ["import { Consumer, Message, OnMessage, Retry } from '@znight/messaging'"]
  if (flags.observability) imports.push("import { Logger } from '@znight/observability'")
  const ctor = flags.observability
    ? `  constructor(
    private readonly greetings: GreetingService,
    private readonly logger: Logger,
  ) {}`
    : '  constructor(private readonly greetings: GreetingService) {}'
  const output = flags.observability
    ? '    this.logger.info(this.greetings.greet(request.name, request.excited))'
    : '    console.log(this.greetings.greet(request.name, request.excited))'
  return `${imports.join('\n')}

import { CreateGreeting } from './greeting.schemas.js'
import { GreetingService } from './greeting.service.js'

/**
 * Consumes the "greetings" queue. Delivery is at-least-once: handlers must be idempotent. A failing
 * handler is retried, then the message goes to the dead-letter queue (greetings.dlq).
 */
@Consumer('greetings')
export class GreetingConsumer {
${ctor}

  @OnMessage('greeting.requested')
  @Retry({ attempts: 3, backoff: 'exponential', delay: 500 })
  handle(@Message(CreateGreeting) request: CreateGreeting): void {
${output}
  }
}
`
}

// ---------------------------------------------------------------------------------------------------
// tests

function testImports(flags: Flags, names: string): string {
  return flags.bun ? `import { ${names} } from 'bun:test'` : `import { ${names} } from 'vitest'`
}

function greetingServiceTest(flags: Flags): string {
  const imports = [testImports(flags, 'describe, expect, test')]
  if (flags.observability) imports.push("import { Logger } from '@znight/observability'")
  imports.push("import { TestBed } from '@znight/testing'")
  const configOption = flags.config ? "\n      config: { app: { greeting: 'Hi' } }, // @Config('app') values" : ''
  const greeting = flags.config ? 'Hi' : 'Hello'
  const loggerTest = flags.observability
    ? `

  test('logs every greeting', async () => {
    const { instance, mocks } = await TestBed.create(GreetingService, { metadata })

    instance.greet('Grace')

    // Logger is provided by ObservabilityPlugin at runtime: TestBed injects an auto-mock
    expect(mocks.get(Logger).debug).toHaveBeenCalledWith('Greeting', { name: 'Grace', excited: false })
  })`
    : ''
  return `${imports.join('\n')}

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { GreetingService } from '../src/app/greeting.service.js'

// TestBed builds GreetingService with its generated factory and auto-mocks its dependencies
describe('GreetingService', () => {
  test('greets', async () => {
    const { instance } = await TestBed.create(GreetingService, {
      metadata,${configOption}
    })

    expect(instance.greet('Ada')).toBe('${greeting}, Ada.')
    expect(instance.greet('Ada', true)).toBe('${greeting}, Ada!')
  })${loggerTest}
})
`
}

function greetingControllerTest(flags: Flags): string {
  const imports = [
    testImports(flags, 'afterEach, beforeEach, describe, expect, test'),
    "import { HttpPlugin } from '@znight/http'",
  ]
  if (flags.messaging) {
    imports.push("import { MessagingPlugin } from '@znight/messaging'")
    imports.push("import { memory } from '@znight/messaging/memory'")
  }
  if (flags.observability) imports.push("import { ObservabilityPlugin } from '@znight/observability'")
  imports.push("import { TestApp } from '@znight/testing'")
  const plugins: string[] = []
  // no metrics server (port 9464 once prom-client is installed): test files and `dev` run side by side
  if (flags.observability) {
    plugins.push("ObservabilityPlugin.configure({ logging: { level: 'silent' }, metrics: { server: false } })")
  }
  if (flags.messaging) plugins.push('MessagingPlugin.configure({ driver: memory() })')
  // port 0: TestApp.inject() sends requests in memory, the server listens on a free port
  plugins.push('HttpPlugin.configure({ port: 0 })')
  const pluginList =
    plugins.length === 1 ? `[${plugins[0]}]` : `[\n${plugins.map(plugin => `        ${plugin},`).join('\n')}\n      ]`
  const greeting = 'Hello'
  return `${imports.join('\n')}

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'

// TestApp starts the application (without signal handlers) and sends requests in memory
describe('GreetingController', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await TestApp.create({
      metadata,
      plugins: ${pluginList},
    })
  })

  afterEach(async () => {
    await app.close()
  })

  test('GET /greetings/:name', async () => {
    const response = await app.inject({ method: 'GET', url: '/greetings/Ada?excited=true' })

    expect(response.status).toBe(200)
    expect(response.json()).toEqual({ message: '${greeting}, Ada!' })
  })

  test('POST /greetings validates the body', async () => {
    const created = await app.inject({ method: 'POST', url: '/greetings', body: { name: 'Grace' } })
    expect(created.status).toBe(201)
    expect(created.json()).toEqual({ message: '${greeting}, Grace.' })

    const invalid = await app.inject({ method: 'POST', url: '/greetings', body: { name: '' } })
    expect(invalid.status).toBe(400)
  })
})
`
}

// ---------------------------------------------------------------------------------------------------
// README

function readme(options: ProjectOptions, flags: Flags): string {
  const run = (script: string): string => runScript(flags.pm, script)
  const znight = execBinary(flags.pm, 'znight')
  const features = [
    `- **HTTP** with \`@znight/http\` (${flags.adapter === 'node' ? 'built-in node:http server' : `${flags.adapter} adapter`})`,
    flags.config ? '- **Configuration** with `@znight/config` (`src/app/app.config.ts`, `.env` files)' : undefined,
    flags.observability
      ? '- **Observability** with `@znight/observability` (structured logs, metrics, traces)'
      : undefined,
    flags.messaging ? '- **Messaging** with `@znight/messaging` (in-memory broker in `src/main.ts`)' : undefined,
  ].filter(line => line !== undefined)
  const tree = [
    'src/',
    '├─ main.ts                    # Application.create() + plugins + start()',
    '├─ .znight/                   # generated DI container (git-ignored)',
    '└─ app/',
    flags.config ? '   ├─ app.config.ts            # @Config: settings read from the environment' : undefined,
    flags.messaging ? '   ├─ greeting.consumer.ts     # @Consumer: handles the "greetings" queue' : undefined,
    '   ├─ greeting.controller.ts   # @Controller: /greetings routes',
    '   ├─ greeting.schemas.ts      # Zod schemas',
    '   ├─ greeting.service.ts      # @Injectable',
    '   └─ health.controller.ts     # GET /health',
    'test/                          # TestBed (unit) and TestApp (HTTP) tests',
    'vite.config.ts                 # znight() plugin: generates the container, server build',
    'znight.config.ts               # compiler options',
  ].filter(line => line !== undefined)
  const configNote = flags.config
    ? `
## Configuration

\`AppConfig\` (\`src/app/app.config.ts\`) reads \`PORT\` and \`APP_GREETING\` from the environment or from
\`.env\` / \`.env.local\` files. Missing or invalid values stop the application at boot with every
problem listed.${
        flags.bun
          ? `

\`bunfig.toml\` turns Bun's own \`.env\` loading off (\`env = false\`): the files are read by
\`@znight/config\`, the same way on Node.js and Bun.`
          : ''
      }
`
    : ''
  const testNote = flags.bun
    ? '`bun test` regenerates the container first (`bunfig.toml` preloads `@znight/compiler/bun`).'
    : 'Vitest uses `vite.config.ts`, so the `znight()` plugin regenerates the container before the tests.'
  const compilerNote = flags.bun
    ? 'the `znight()` Vite plugin, the Bun preload of the tests and `znight generate`'
    : 'the `znight()` Vite plugin (builds and Vitest) and `znight generate`'
  return `# ${options.name}

A [Znight](https://github.com/znight-org/znight) application: dependency injection resolved at **build
time** — no \`reflect-metadata\`, errors reported by the compiler with their location.

${features.join('\n')}

## Scripts

| Command | Description |
| --- | --- |
| \`${run('dev')}\` | Build in watch mode and restart the application on every change |
| \`${run('build')}\` | Production build (\`dist/main.js\`) |
| \`${run('start')}\` | Run the production build |
| \`${run('test')}\` | Run the tests |
| \`${run('typecheck')}\` | Generate the container, then type-check with \`tsc\` |
| \`${run('generate')}\` | Generate \`src/.znight/container.generated.ts\` (\`znight generate --check\` in CI) |

\`\`\`sh
${run('dev')}
curl localhost:3000/health
curl localhost:3000/greetings/Ada?excited=true
curl -X POST localhost:3000/greetings -H 'content-type: application/json' -d '{"name":"Grace"}'
\`\`\`

## Project structure

\`\`\`txt
${tree.join('\n')}
\`\`\`

Providers are discovered by the compiler from their decorators: there are no modules to declare.
Its options live in \`znight.config.ts\`, read by ${compilerNote}.
Add code with the generators:

\`\`\`sh
${znight} g service users/user        # src/users/user.service.ts
${znight} g controller users/user     # src/users/user.controller.ts
\`\`\`
${configNote}
## Tests

${testNote}

## Learn more

- [Znight documentation](https://github.com/znight-org/znight#readme)
`
}
