/**
 * Files of a project created by `znight new`. Pure: {@link renderProject} returns the files for a set
 * of options, `create.ts` writes them. The sample application uses the public APIs of the
 * `@znight/*` packages exactly as documented in their READMEs.
 */
import type { Feature, HttpAdapterName, OpenApiUiName, PackageManager, ProjectOptions } from './options.ts'

import { DEFAULT_OPENAPI_UI, execBinary, OPENAPI_UI_LABELS, runScript } from './options.ts'
import { versionOf } from './versions.ts'

/** A file of the new project. */
export interface ProjectFile {
  /** POSIX path relative to the project directory. */
  readonly path: string
  readonly content: string
}

interface Flags {
  /** npm package name of the project (the logger name). */
  readonly name: string
  readonly config: boolean
  readonly observability: boolean
  readonly messaging: boolean
  readonly schedule: boolean
  readonly openapi: boolean
  readonly openapiUi: OpenApiUiName
  readonly graphql: boolean
  readonly websocket: boolean
  readonly docker: boolean
  readonly adapter: HttpAdapterName
  readonly pm: PackageManager
  readonly bun: boolean
}

function flagsOf(options: ProjectOptions): Flags {
  const has = (feature: Feature): boolean => options.features.includes(feature)
  return {
    name: options.name,
    config: has('config'),
    observability: has('observability'),
    messaging: has('messaging'),
    schedule: has('schedule'),
    openapi: has('openapi'),
    openapiUi: options.openapiUi ?? DEFAULT_OPENAPI_UI,
    graphql: has('graphql'),
    websocket: has('websocket'),
    docker: options.docker ?? true,
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
  if (flags.schedule) {
    files.push({ path: 'src/app/heartbeat.jobs.ts', content: heartbeatJobs() })
    files.push({ path: 'test/heartbeat.jobs.test.ts', content: heartbeatJobsTest(flags) })
  }
  if (flags.openapi) files.push({ path: 'src/openapi.ts', content: openApiDocument(flags) })
  if (flags.graphql) {
    files.push({ path: 'src/app/greeting.resolver.ts', content: greetingResolver() })
    files.push({ path: 'test/greeting.resolver.test.ts', content: greetingResolverTest(flags) })
  }
  if (flags.websocket) {
    files.push({ path: 'src/app/greeting.gateway.ts', content: greetingGateway() })
    files.push({ path: 'test/greeting.gateway.test.ts', content: greetingGatewayTest(flags) })
  }
  if (flags.bun) files.push({ path: 'bunfig.toml', content: bunfig(flags) })
  if (flags.docker) {
    files.push({ path: 'Dockerfile', content: dockerfile(flags) })
    files.push({ path: '.dockerignore', content: dockerignore() })
  }
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
  if (flags.schedule) dependencies['@znight/schedule'] = znight
  if (flags.openapi) dependencies['@znight/openapi'] = znight
  if (flags.graphql) {
    dependencies['@znight/graphql'] = znight
    dependencies['graphql'] = versionOf('graphql')
  }
  if (flags.websocket) {
    dependencies['@znight/websocket'] = znight
    // the transport of the node:http based servers (Bun provides its own ws module)
    dependencies['ws'] = versionOf('ws')
  }
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
  // logging.pretty in src/main.ts, loaded only in development: the production image does not ship it
  if (flags.observability) devDependencies['pino-pretty'] = versionOf('pino-pretty')
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
      ...(flags.openapi ? { openapi: 'znight openapi', 'openapi:check': 'znight openapi --check' } : {}),
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
// Docker

/** How the image installs and builds with a package manager. */
interface DockerSteps {
  /** Files of the install layers (the lockfile is required: installs are frozen). */
  readonly manifests: string
  /** Package manager setup of the base stage. */
  readonly setup: readonly string[]
  /** Every dependency, for the build. */
  readonly install: string
  /** Production dependencies only, without the compiler, Vite, TypeScript... */
  readonly production: string
  readonly build: string
}

function dockerSteps(pm: PackageManager): DockerSteps {
  // pnpm and yarn come from Corepack (bundled with Node.js 24); the packageManager field of
  // package.json, when present, picks their version
  const corepack = (tool: string): string[] => [
    'ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0',
    `RUN corepack enable && corepack install --global ${tool}`,
  ]
  switch (pm) {
    case 'bun':
      return {
        manifests: 'package.json bun.lock',
        setup: [],
        install: 'bun install --frozen-lockfile',
        // --omit=peer: Bun would also install the optional peers the dev dependencies satisfy (the
        // @znight/* packages declare the compiler as one); required peers are direct dependencies
        production: 'bun install --frozen-lockfile --production --omit=peer',
        build: 'bun run build',
      }
    case 'pnpm':
      return {
        manifests: 'package.json pnpm-lock.yaml',
        setup: corepack('pnpm@10'),
        install: 'pnpm install --frozen-lockfile',
        production: 'pnpm install --frozen-lockfile --prod',
        build: 'pnpm run build',
      }
    case 'yarn':
      return {
        manifests: 'package.json yarn.lock .yarnrc.yml',
        setup: corepack('yarn@4'),
        install: 'yarn install --immutable',
        production: 'yarn workspaces focus --all --production',
        build: 'yarn build',
      }
    default:
      return {
        manifests: 'package.json package-lock.json',
        setup: [],
        install: 'npm ci',
        // without the devDependencies in package.json, npm also leaves out the optional peers they
        // satisfy (the @znight/* packages declare the compiler as one): `npm ci --omit=dev` keeps them
        production: 'npm pkg delete devDependencies && npm ci --omit=dev',
        build: 'npm run build',
      }
  }
}

/** A multi-stage image: build with every dependency, run the bundle with the production ones. */
function dockerfile(flags: Flags): string {
  const steps = dockerSteps(flags.pm)
  const runtime = flags.bun ? 'bun' : 'node'
  const [baseImage, runImage] = flags.bun ? ['oven/bun:1', 'oven/bun:1-slim'] : ['node:24-slim', 'node:24-slim']
  // the images ship neither curl nor wget: the runtime itself probes GET /health
  const probe =
    "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
  const command = flags.bun
    ? '["bun", "--no-env-file", "dist/main.js"]'
    : '["node", "--enable-source-maps", "dist/main.js"]'
  const envFiles = flags.bun
    ? '\n# --no-env-file: Bun would load .env files into process.env by itself, with its own precedence'
    : ''
  return `# syntax=docker/dockerfile:1
# Production image: docker build -t ${dockerTag(flags.name)} .
# Installs are frozen: install the dependencies once (${flags.pm} install) so that the lockfile exists.

FROM ${baseImage} AS base
${steps.setup.map(line => `${line}\n`).join('')}WORKDIR /app

# --- production dependencies only, at the versions of the lockfile ----------------------------------
FROM base AS deps
COPY ${steps.manifests} ./
RUN ${steps.production}

# --- build: every dependency, since the Znight compiler, Vite and TypeScript run here ---------------
FROM base AS build
COPY ${steps.manifests} ./
RUN ${steps.install}
COPY . .
# generates the DI container (src/.znight), fails on any wiring error, bundles dist/main.js
RUN ${steps.build}

# --- runtime: the bundle and the production dependencies, as a non-root user ----------------------
FROM ${runImage}
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER ${runtime}
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \\
  CMD ["${runtime}", "-e", "${probe}"]
# exec form: the runtime is PID 1 and receives SIGTERM directly (graceful shutdown)${envFiles}
CMD ${command}
`
}

/** A Docker image name for an npm package name (`@acme/api` -> `acme-api`). */
function dockerTag(name: string): string {
  return name.replace(/^@/, '').replace('/', '-')
}

function dockerignore(): string {
  return `# not part of the image: the build installs and generates everything itself
node_modules
dist
coverage
**/.znight
*.log
.git
.env
.env.*
Dockerfile
.dockerignore
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
    flags.graphql ? "import { GraphQLPlugin } from '@znight/graphql'" : undefined,
    "import { HttpPlugin } from '@znight/http'",
    adapterImport(flags.adapter),
    flags.messaging ? "import { MessagingPlugin } from '@znight/messaging'" : undefined,
    flags.messaging ? "import { memory } from '@znight/messaging/memory'" : undefined,
    flags.observability ? "import { ObservabilityPlugin } from '@znight/observability'" : undefined,
    flags.openapi ? "import { OpenApiPlugin } from '@znight/openapi'" : undefined,
    flags.schedule ? "import { SchedulePlugin } from '@znight/schedule'" : undefined,
    flags.websocket ? "import { WebSocketPlugin } from '@znight/websocket'" : undefined,
  ].filter(line => line !== undefined)
  const localImports = [
    "import { __ZNIGHT_METADATA__ } from './.znight/container.generated.js'",
    flags.config ? "import { AppConfig } from './app/app.config.js'" : undefined,
  ].filter(line => line !== undefined)

  const plugins: string[] = []
  if (flags.observability) {
    const logging = [
      '      logging: {',
      `        name: ${quote(flags.name)},`,
      '        // human-readable logs in development (`znight dev`), JSON logs in production',
      flags.config
        ? "        pretty: container.get(AppConfig).environment === 'development',"
        : "        pretty: process.env['NODE_ENV'] === 'development',",
      '      },',
      '      metrics: false,',
      '      tracing: false,',
    ]
    plugins.push(
      '    // first, so that its hooks wrap everything; metrics (with prom-client) and tracing are off',
      ...(flags.config
        ? ['    ObservabilityPlugin.configure(container => ({', ...logging, '    })),']
        : ['    ObservabilityPlugin.configure({', ...logging, '    }),']),
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
  if (flags.schedule) {
    plugins.push(
      '    // before HttpPlugin: plugins stop in reverse order, so HTTP stops first, then running jobs drain',
      '    SchedulePlugin.configure(),',
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
  if (flags.openapi) {
    plugins.push(
      ...(flags.openapiUi === 'none'
        ? [
            '    // GET /openapi.json, no API reference UI (document options: src/openapi.ts)',
            '    OpenApiPlugin.configure(),',
          ]
        : [
            `    // GET /openapi.json and the API reference at /docs, with ${OPENAPI_UI_LABELS[flags.openapiUi]} (document options: src/openapi.ts)`,
            `    OpenApiPlugin.configure({ ui: ${quote(flags.openapiUi)} }),`,
          ]),
    )
  }
  if (flags.graphql) {
    plugins.push(
      '    // POST /graphql, GET /graphql (GraphiQL in development): the schema is derived from the resolvers',
      '    GraphQLPlugin.configure(),',
    )
  }
  if (flags.websocket) {
    plugins.push(
      "    // WebSocket gateways on the HTTP server's port (ws on Node.js, Bun's own WebSocket on Bun)",
      '    WebSocketPlugin.configure(),',
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

/** A single-quoted TypeScript string literal of `value` (quotes, backslashes and line breaks escaped). */
function quote(value: string): string {
  let out = "'"
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (char === "'" || char === '\\') out += `\\${char}`
    else if (char === '\n') out += '\\n'
    else if (char === '\r') out += '\\r'
    else if (code < 0x20 || code === 0x2028 || code === 0x2029) out += `\\u${code.toString(16).padStart(4, '0')}`
    else out += char
  }
  return `${out}'`
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

  /** Runtime environment (NODE_ENV): \`znight dev\` sets "development", the Docker image "production". */
  @Env('NODE_ENV')
  environment = 'development'
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

function heartbeatJobs(): string {
  return `import { Cron, type JobContext } from '@znight/schedule'

/**
 * Scheduled jobs. A class with @Cron, @Interval or @Timeout methods becomes a singleton provider
 * (no decorator needed): its dependencies are constructor parameters. Running several instances?
 * Give SchedulePlugin a lock store so that each occurrence runs on one of them.
 */
export class HeartbeatJobs {
  /** Number of runs. */
  beats = 0
  /** The occurrence of the last run. */
  last: Date | undefined

  /** Every minute (cron expressions run in UTC unless they set a timeZone). */
  @Cron('* * * * *', { name: 'heartbeat' })
  beat(ctx: JobContext): void {
    this.beats++
    this.last = ctx.scheduledAt
  }
}
`
}

function openApiDocument(flags: Flags): string {
  const served = flags.openapiUi === 'none' ? 'GET /openapi.json' : 'GET /openapi.json, the API reference at /docs'
  return `import { OpenApiDocument } from '@znight/openapi'

// Options of the OpenAPI document (${served}), read by the
// compiler. The class is a marker: it is never instantiated.
@OpenApiDocument({
  info: {
    title: ${quote(flags.name)},
    description: ${quote(`The HTTP API of ${flags.name}.`)},
    version: '1.0.0',
  },
})
export class Api {}
`
}

function greetingResolver(): string {
  return `import { Args, Query, Resolver } from '@znight/graphql'

import { GreetingService } from './greeting.service.js'

/** A greeting. */
export interface Greeting {
  readonly message: string
}

/**
 * GraphQL resolver (code-first): the compiler derives the schema from the TypeScript types and the
 * JSDoc, \`type Query { greeting(name: String!): Greeting! }\` here.
 */
@Resolver()
export class GreetingResolver {
  constructor(private readonly greetings: GreetingService) {}

  /**
   * Greets someone.
   * @param name Who to greet.
   */
  @Query()
  greeting(@Args('name') name: string): Greeting {
    return { message: this.greetings.greet(name) }
  }
}
`
}

function greetingGateway(): string {
  return `import { Gateway, OnMessage, Payload } from '@znight/websocket'

import { CreateGreeting } from './greeting.schemas.js'
import { GreetingService } from './greeting.service.js'

/**
 * WebSocket gateway on ws://localhost:3000/ws, served by the HTTP server. Frames are JSON: the
 * request {"event": "greet", "data": {"name": "Ada"}, "id": 1} is answered with
 * {"id": 1, "data": {"message": "Hello, Ada."}}.
 */
@Gateway('/ws')
export class GreetingGateway {
  constructor(private readonly greetings: GreetingService) {}

  /** The payload is validated by the schema (a BAD_REQUEST error reply otherwise). */
  @OnMessage('greet')
  greet(@Payload(CreateGreeting) input: CreateGreeting): { message: string } {
    return { message: this.greetings.greet(input.name, input.excited) }
  }
}
`
}

// ---------------------------------------------------------------------------------------------------
// tests

function heartbeatJobsTest(flags: Flags): string {
  return `${testImports(flags, 'describe, expect, test')}
import { SchedulePlugin, SchedulerRegistry } from '@znight/schedule'
import { createTestClock } from '@znight/schedule/testing'
import { TestApp } from '@znight/testing'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { HeartbeatJobs } from '../src/app/heartbeat.jobs.js'

// virtual time: the clock only moves when the test advances it, and waits for the runs it starts
describe('HeartbeatJobs', () => {
  test('beats every minute', async () => {
    const clock = createTestClock('2026-01-01T00:00:30Z')
    const app = await TestApp.create({
      metadata,
      plugins: [SchedulePlugin.configure({ clock })],
      only: [HeartbeatJobs],
    })
    try {
      await clock.advance('3m')

      expect(app.get(HeartbeatJobs).beats).toBe(3)
      expect(app.get(HeartbeatJobs).last?.toISOString()).toBe('2026-01-01T00:03:00.000Z')
      const heartbeat = app.get(SchedulerRegistry).get('heartbeat')
      expect(heartbeat?.nextRun?.toISOString()).toBe('2026-01-01T00:04:00.000Z')
    } finally {
      await app.close()
    }
  })
})
`
}

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

/** Imports and `plugins` array of a `TestApp` test, with the plugins the providers need. */
function testAppPlugins(
  flags: Flags,
  names: string,
  extra: { readonly graphql?: boolean; readonly websocket?: boolean } = {},
): { imports: string; plugins: string } {
  const imports = [testImports(flags, names)]
  if (extra.graphql === true) {
    imports.push("import { GraphQLPlugin } from '@znight/graphql'")
    imports.push("import { executeOperation } from '@znight/graphql/testing'")
  }
  imports.push("import { HttpPlugin } from '@znight/http'")
  if (flags.messaging) {
    imports.push("import { MessagingPlugin } from '@znight/messaging'")
    imports.push("import { memory } from '@znight/messaging/memory'")
  }
  if (flags.observability) imports.push("import { ObservabilityPlugin } from '@znight/observability'")
  imports.push("import { TestApp } from '@znight/testing'")
  if (extra.websocket === true) imports.push("import { WebSocketPlugin } from '@znight/websocket'")
  const plugins: string[] = []
  // metrics off: no metrics server colliding on :9464 with `dev` or other test files, and no need for
  // prom-client (any metrics object requires it)
  if (flags.observability) {
    plugins.push("ObservabilityPlugin.configure({ logging: { level: 'silent' }, metrics: false })")
  }
  if (flags.messaging) plugins.push('MessagingPlugin.configure({ driver: memory() })')
  // port 0: TestApp.inject() sends requests in memory, the server listens on a free port
  plugins.push('HttpPlugin.configure({ port: 0 })')
  if (extra.graphql === true) plugins.push('GraphQLPlugin.configure()')
  if (extra.websocket === true) plugins.push('WebSocketPlugin.configure()')
  const list =
    plugins.length === 1 ? `[${plugins[0]}]` : `[\n${plugins.map(plugin => `        ${plugin},`).join('\n')}\n      ]`
  return { imports: imports.join('\n'), plugins: list }
}

function greetingControllerTest(flags: Flags): string {
  const { imports, plugins: pluginList } = testAppPlugins(flags, 'afterEach, beforeEach, describe, expect, test')
  const greeting = 'Hello'
  return `${imports}

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

function greetingResolverTest(flags: Flags): string {
  const { imports, plugins } = testAppPlugins(flags, 'describe, expect, test', { graphql: true })
  return `${imports}

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'

// executeOperation() sends the operation through the whole HTTP pipeline, in memory
describe('GreetingResolver', () => {
  test('query { greeting }', async () => {
    const app = await TestApp.create({
      metadata,
      plugins: ${plugins},
    })
    try {
      const response = await executeOperation(app, { query: '{ greeting(name: "Ada") { message } }' })

      expect(response.status).toBe(200)
      expect(response.errors).toBeUndefined()
      expect(response.data).toEqual({ greeting: { message: 'Hello, Ada.' } })
    } finally {
      await app.close()
    }
  })
})
`
}

function greetingGatewayTest(flags: Flags): string {
  const { imports, plugins } = testAppPlugins(flags, 'describe, expect, test', { websocket: true })
  return `${imports}

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'

// app.connect() opens an in-memory connection, through the real handshake
describe('GreetingGateway', () => {
  test('answers "greet" requests', async () => {
    const app = await TestApp.create({
      metadata,
      plugins: ${plugins},
    })
    try {
      const client = await app.connect('/ws')

      expect(await client.request('greet', { name: 'Ada', excited: true })).toEqual({ message: 'Hello, Ada!' })
      await expect(client.request('greet', { name: '' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      await client.close()
    } finally {
      await app.close()
    }
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
      ? '- **Observability** with `@znight/observability` (structured logs: pretty-printed by `pino-pretty` in development, JSON in production; metrics and tracing are off in `src/main.ts`)'
      : undefined,
    flags.messaging ? '- **Messaging** with `@znight/messaging` (in-memory broker in `src/main.ts`)' : undefined,
    flags.schedule ? '- **Scheduled jobs** with `@znight/schedule` (`src/app/heartbeat.jobs.ts`)' : undefined,
    flags.openapi
      ? `- **OpenAPI** with \`@znight/openapi\` (\`/openapi.json\`, ${flags.openapiUi === 'none' ? '' : `${OPENAPI_UI_LABELS[flags.openapiUi]} API reference at \`/docs\`, `}options in \`src/openapi.ts\`)`
      : undefined,
    flags.graphql
      ? '- **GraphQL** with `@znight/graphql` (code-first: the schema is derived from `src/app/greeting.resolver.ts`)'
      : undefined,
    flags.websocket
      ? '- **WebSocket** with `@znight/websocket` (`src/app/greeting.gateway.ts`, on the HTTP port at `/ws`)'
      : undefined,
  ].filter(line => line !== undefined)
  const app = [
    flags.config ? 'app.config.ts            # @Config: settings read from the environment' : undefined,
    flags.messaging ? 'greeting.consumer.ts     # @Consumer: handles the "greetings" queue' : undefined,
    'greeting.controller.ts   # @Controller: /greetings routes',
    flags.websocket ? 'greeting.gateway.ts      # @Gateway: the /ws WebSocket endpoint' : undefined,
    flags.graphql ? 'greeting.resolver.ts     # @Resolver: the greeting GraphQL query' : undefined,
    'greeting.schemas.ts      # Zod schemas',
    'greeting.service.ts      # @Injectable',
    'health.controller.ts     # GET /health',
    flags.schedule ? 'heartbeat.jobs.ts        # @Cron: a job every minute' : undefined,
  ].filter(line => line !== undefined)
  const tree = [
    'src/',
    '├─ main.ts                    # Application.create() + plugins + start()',
    flags.openapi
      ? '├─ openapi.ts                 # @OpenApiDocument: title, description, version of openapi.json'
      : undefined,
    '├─ .znight/                   # generated DI container (git-ignored)',
    '└─ app/',
    ...app.map((line, index) => `   ${index === app.length - 1 ? '└─' : '├─'} ${line}`),
    'test/                          # TestBed (unit) and TestApp (HTTP) tests',
    'vite.config.ts                 # znight() plugin: generates the container, server build',
    'znight.config.ts               # compiler options',
    flags.docker ? 'Dockerfile                     # production image (multi-stage, non-root)' : undefined,
  ].filter(line => line !== undefined)
  const configNote = flags.config
    ? `
## Configuration

\`AppConfig\` (\`src/app/app.config.ts\`) reads \`PORT\`, \`APP_GREETING\` and \`NODE_ENV\` from the environment
or from \`.env\` / \`.env.local\` files. Missing or invalid values stop the application at boot with
every problem listed.${
        flags.bun
          ? `

\`bunfig.toml\` turns Bun's own \`.env\` loading off (\`env = false\`): the files are read by
\`@znight/config\`, the same way on Node.js and Bun.`
          : ''
      }
`
    : ''
  const image = dockerTag(options.name)
  const dockerNote = flags.docker
    ? `
## Docker

\`\`\`sh
docker build -t ${image} .
docker run --rm -p 3000:3000 ${image}
\`\`\`

The \`Dockerfile\` builds with every dependency (the Znight compiler runs during the build), then
ships \`dist/\` with the production dependencies only, on ${flags.bun ? 'Bun' : 'Node.js'}, as a non-root user, with
\`NODE_ENV=production\` and a health check on \`GET /health\`. Installs are frozen: the lockfile of
\`${flags.pm} install\` must exist.
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
${
  flags.openapi
    ? `| \`${run('openapi')}\` | Write \`openapi.json\` (commit it; \`${run('openapi:check')}\` in CI) |
`
    : ''
}
\`\`\`sh
${run('dev')}
curl localhost:3000/health
curl localhost:3000/greetings/Ada?excited=true
curl -X POST localhost:3000/greetings -H 'content-type: application/json' -d '{"name":"Grace"}'${flags.openapi ? `\ncurl localhost:3000/openapi.json${flags.openapiUi === 'none' ? '' : '        # the API reference is at http://localhost:3000/docs'}` : ''}${flags.graphql ? `\ncurl localhost:3000/graphql -H 'content-type: application/json' -d '{"query":"{ greeting(name: \\"Ada\\") { message } }"}'` : ''}
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
${znight} g controller users/user     # src/users/user.controller.ts${flags.schedule ? `\n${znight} g job reports/digest        # src/reports/digest.jobs.ts` : ''}
\`\`\`
${configNote}${dockerNote}
## Tests

${testNote}

## Learn more

- [Znight documentation](https://github.com/znight-org/znight#readme)
`
}
