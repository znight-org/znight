/**
 * Code generators of `znight g <schematic> <name>`: one file per schematic, kebab-case file names
 * (`user-profile.service.ts`), PascalCase classes (`UserProfileService`). Pure: {@link planSchematic}
 * computes the file, the command writes it.
 */
import { dirname, isAbsolute, join, normalize, relative } from 'node:path'

import { camelCase, constantCase, kebabCase, pascalCase } from '../names.ts'

/** Available schematics. */
export type SchematicName =
  | 'service'
  | 'controller'
  | 'consumer'
  | 'config'
  | 'guard'
  | 'interceptor'
  | 'factory'
  | 'job'

/** Names derived from the user input. */
export interface SchematicNames {
  /** `user-profile` */
  readonly kebab: string
  /** `UserProfile` */
  readonly pascal: string
  /** `userProfile` */
  readonly camel: string
  /** `UserProfileService` */
  readonly className: string
  /**
   * Dotted name of the element in the application: the directories of its file relative to `src/`
   * (or to the project root, for a `--path` outside `src/`) and its kebab name, without the directory
   * named after it (`reports.digest` for `src/reports/digest.jobs.ts`, `digest` for
   * `src/digest/digest.jobs.ts`). Unlike `kebab`, it tells apart elements of the same name in different
   * directories: the default name of a job (job names are unique in the application).
   */
  readonly qualified: string
}

/** Project facts that change the generated code. */
export interface SchematicContext {
  /** The project depends on `zod`: consumers get a message schema. */
  readonly zod: boolean
  /** `interceptor` only: a method interceptor (`@Intercept`, AOP) instead of an HTTP interceptor. */
  readonly aop: boolean
}

/** A schematic. */
export interface Schematic {
  readonly name: SchematicName
  readonly aliases: readonly string[]
  readonly description: string
  /** File and class suffix (`service` → `user.service.ts`, `UserService`). */
  readonly suffix: string
  render(names: SchematicNames, context: SchematicContext): string
  /** What to do next, printed after the file is created. */
  hint?(names: SchematicNames, context: SchematicContext): string | undefined
}

const service: Schematic = {
  name: 'service',
  aliases: ['s'],
  description: 'An @Injectable() provider',
  suffix: 'service',
  render: names => `import { Injectable } from '@znight/core'

@Injectable()
export class ${names.className} {
  // Declare dependencies as constructor parameters: the compiler resolves them from their types.
  // constructor(private readonly repository: ${names.pascal}Repository) {}
}
`,
}

const controller: Schematic = {
  name: 'controller',
  aliases: ['co'],
  description: 'An HTTP @Controller() with two routes',
  suffix: 'controller',
  render: names => `import { Controller, Get, Param } from '@znight/http'

@Controller('/${names.kebab}')
export class ${names.className} {
  /** GET /${names.kebab} */
  @Get()
  list(): unknown[] {
    return []
  }

  /** GET /${names.kebab}/:id */
  @Get('/:id')
  find(@Param('id') id: string): { id: string } {
    return { id }
  }
}
`,
}

const consumer: Schematic = {
  name: 'consumer',
  aliases: ['cs'],
  description: 'A message @Consumer() (@znight/messaging)',
  suffix: 'consumer',
  render: (names, context) =>
    context.zod
      ? `import { Consumer, Message, OnMessage, Retry } from '@znight/messaging'
import { z } from 'zod'

export const ${names.pascal}Message = z.object({
  id: z.string(),
})
export type ${names.pascal}Message = z.output<typeof ${names.pascal}Message>

/**
 * Consumes the "${names.kebab}" queue.
 * Delivery is at-least-once: make the handler idempotent. Throw to retry, throw a NonRetryableError
 * to dead-letter the message right away.
 */
@Consumer('${names.kebab}')
export class ${names.className} {
  @OnMessage()
  @Retry({ attempts: 3, backoff: 'exponential', delay: 1000 })
  handle(@Message(${names.pascal}Message) message: ${names.pascal}Message): void {
    console.log('received', message.id)
  }
}
`
      : `import { Consumer, Ctx, type InboundMessage, OnMessage, Retry } from '@znight/messaging'

/**
 * Consumes the "${names.kebab}" queue.
 * Delivery is at-least-once: make the handler idempotent. Throw to retry, throw a NonRetryableError
 * to dead-letter the message right away.
 */
@Consumer('${names.kebab}')
export class ${names.className} {
  @OnMessage()
  @Retry({ attempts: 3, backoff: 'exponential', delay: 1000 })
  handle(@Ctx() message: InboundMessage): void {
    console.log('received', message.id, message.payload)
  }
}
`,
  hint: () => 'consumers run with MessagingPlugin.configure({ driver }) in src/main.ts',
}

const config: Schematic = {
  name: 'config',
  aliases: ['cf'],
  description: 'A @Config() class read from the environment (@znight/config)',
  suffix: 'config',
  render: names => `import { Config } from '@znight/config'

/**
 * Settings read from the ${constantCase(names.camel)}_* environment variables (or .env files).
 * Validated at boot by ConfigPlugin: the type of a property selects its coercion, an initializer
 * makes it optional.
 */
@Config('${names.camel}')
export class ${names.className} {
  /** ${constantCase(names.camel)}_ENABLED */
  enabled = true
}
`,
  hint: names => `inject ${names.className} anywhere; values are loaded by ConfigPlugin.configure() in src/main.ts`,
}

const guard: Schematic = {
  name: 'guard',
  aliases: ['gu'],
  description: 'An HTTP guard (CanActivate)',
  suffix: 'guard',
  render: names => `import type { CanActivate, HttpContext } from '@znight/http'

import { Injectable } from '@znight/core'

@Injectable()
export class ${names.className} implements CanActivate {
  // The route decisions this guard enforces (createRouteDecorator groups, see "Route decisions" in
  // the @znight/http README): the boot fails when a route of a required group has no guard
  // enforcing its decision.
  // static readonly enforces = [Public, Roles]

  canActivate(ctx: HttpContext): boolean | Promise<boolean> {
    // Return false (403 Forbidden) or throw an HttpException (UnauthorizedException...) to reject
    // the request, e.g. return ctx.header('authorization') !== undefined
    return true
  }
}
`,
  hint: names =>
    `use it with @UseGuard(${names.className}) on a controller or a route, or HttpPlugin.configure({ guards: [${names.className}] })`,
}

const interceptor: Schematic = {
  name: 'interceptor',
  aliases: ['itc'],
  description: 'An HTTP interceptor (HttpInterceptor), or a method interceptor with --aop',
  suffix: 'interceptor',
  render: (names, context) =>
    context.aop
      ? `import { Injectable, type MethodInterceptor, type MethodInvocation } from '@znight/core'

@Injectable()
export class ${names.className} implements MethodInterceptor {
  intercept(invocation: MethodInvocation): unknown {
    // Runs around every intercepted call. For a synchronous method, return synchronously.
    return invocation.proceed()
  }
}
`
      : `import type { CallHandler, HttpContext, HttpInterceptor } from '@znight/http'

import { Injectable } from '@znight/core'

@Injectable()
export class ${names.className} implements HttpInterceptor {
  async intercept(ctx: HttpContext, next: CallHandler): Promise<unknown> {
    const started = performance.now()
    try {
      // the handler result (before serialisation): return it, transform it or replace it
      return await next()
    } finally {
      ctx.setHeader('server-timing', \`app;dur=\${(performance.now() - started).toFixed(1)}\`)
    }
  }
}
`,
  hint: (names, context) =>
    context.aop
      ? `use it with @Intercept(${names.className}) on any provider method`
      : `use it with @UseInterceptor(${names.className}) on a controller or a route, or HttpPlugin.configure({ interceptors: [${names.className}] })`,
}

const factory: Schematic = {
  name: 'factory',
  aliases: ['f'],
  description: 'A @Factory() whose @Provides() methods provide objects you do not own',
  suffix: 'factory',
  render: names => `import { Factory, Provides } from '@znight/core'

/** Replace with the type you provide: a database pool, an SDK client... */
export class ${names.pascal}Client {
  close(): void {}
}

/**
 * @Provides methods create providers for classes you cannot decorate. Their parameters are injected,
 * their explicit return type is the provided type (Promise<T> for an async initialisation).
 */
@Factory()
export class ${names.className} {
  @Provides({ dispose: 'close' })
  create${names.pascal}Client(): ${names.pascal}Client {
    return new ${names.pascal}Client()
  }
}
`,
}

const job: Schematic = {
  name: 'job',
  aliases: ['j'],
  description: 'Scheduled jobs: @Cron, @Interval, @Timeout methods (@znight/schedule)',
  suffix: 'jobs',
  render: names => `import { Cron, type JobContext } from '@znight/schedule'

/**
 * Scheduled jobs. A class with @Cron, @Interval or @Timeout methods becomes a singleton provider
 * (no decorator needed): declare its dependencies as constructor parameters.
 */
export class ${names.className} {
  /** Every day at 03:00 UTC (set timeZone to follow a local clock). A run still running is skipped. */
  @Cron('0 3 * * *', { name: '${names.qualified}.daily' })
  daily(ctx: JobContext): void {
    // checkpoint: throws when the run is aborted (shutdown, maxDuration or a lost lock)
    ctx.signal.throwIfAborted()
  }
}
`,
  hint: () =>
    'jobs run with SchedulePlugin.configure() in src/main.ts; test them with createTestClock() from @znight/schedule/testing',
}

/** Every schematic, in display order. */
export const SCHEMATICS: readonly Schematic[] = [
  service,
  controller,
  consumer,
  config,
  guard,
  interceptor,
  factory,
  job,
]

/** Finds a schematic by name or alias. */
export function findSchematic(name: string): Schematic | undefined {
  const key = name.toLowerCase()
  return SCHEMATICS.find(schematic => schematic.name === key || schematic.aliases.includes(key))
}

/** Parsed `<name>` argument: optional directories and the base name. */
export interface ParsedSchematicName {
  /** Directory segments (`users/admin` → `['users']`), kebab-cased. */
  readonly directories: readonly string[]
  readonly names: SchematicNames
}

/**
 * Parses `users/user-profile`, `UserProfile`, `user_profile.service.ts`... A trailing suffix
 * matching the schematic (`user-service`, `UserService`, `user.service`) is dropped.
 *
 * @throws Error with a user-facing message when the name is invalid.
 */
export function parseSchematicName(input: string, schematic: Schematic): ParsedSchematicName {
  const segments = input
    .trim()
    .split(/[\\/]+/)
    .filter(segment => segment !== '')
  if (segments.length === 0) throw new Error('the name cannot be empty')
  if (isAbsolute(input) || segments.some(segment => segment === '.' || segment === '..')) {
    throw new Error(`invalid name "${input}": use a path relative to src/ without "." or ".." segments`)
  }
  const last = (segments.at(-1) ?? '').replace(/\.[cm]?tsx?$/, '')
  let words = kebabCase(last)
  for (const suffix of [`-${schematic.suffix}`, `.${schematic.suffix}`]) {
    if (words.endsWith(suffix) && words !== suffix.slice(1)) words = words.slice(0, -suffix.length)
  }
  if (words === '') throw new Error(`invalid name "${input}"`)
  if (!/^[a-z]/.test(words)) throw new Error(`invalid name "${input}": it must start with a letter`)
  const directories = segments.slice(0, -1).map(segment => kebabCase(segment))
  if (directories.some(directory => directory === '')) throw new Error(`invalid name "${input}"`)
  const pascal = pascalCase(words)
  return {
    directories,
    names: {
      kebab: words,
      pascal,
      camel: camelCase(words),
      className: `${pascal}${pascalCase(schematic.suffix)}`,
      qualified: qualifiedName(directories, words),
    },
  }
}

/** `reports` + `digest` → `reports.digest`; the directory named after the element is left out. */
function qualifiedName(directories: readonly string[], kebab: string): string {
  const segments = directories.at(-1) === kebab ? directories.slice(0, -1) : directories
  return [...segments, kebab].join('.')
}

/**
 * Directories of `directory` relative to `<root>/src`, or to `root` outside `src/`, kebab-cased
 * (`undefined` outside the project).
 */
function sourceDirectories(root: string, directory: string): string[] | undefined {
  for (const base of [join(root, 'src'), root]) {
    const path = relative(base, directory)
    if (isAbsolute(path) || path === '..' || /^\.\.[\\/]/.test(path)) continue
    return path
      .split(/[\\/]+/)
      .map(segment => kebabCase(segment))
      .filter(segment => segment !== '')
  }
  return undefined
}

/** Where and what to generate. */
export interface SchematicPlan {
  readonly schematic: Schematic
  readonly names: SchematicNames
  /** Absolute path of the file. */
  readonly file: string
  readonly content: string
  readonly hint: string | undefined
}

/** Inputs of {@link planSchematic}. */
export interface PlanSchematicOptions {
  readonly schematic: Schematic
  readonly name: string
  /** Project root (contains `src/`). */
  readonly root: string
  /** Directory of `--path` (absolute), replacing `<root>/src`. */
  readonly path?: string | undefined
  /** Do not create a directory named after the element. */
  readonly flat?: boolean
  readonly context: SchematicContext
}

/**
 * Computes the file of a schematic:
 *
 * | Input                        | File                                  |
 * | ---------------------------- | ------------------------------------- |
 * | `service user`               | `src/user/user.service.ts`            |
 * | `service users/user`         | `src/users/user.service.ts`           |
 * | `service user --flat`        | `src/user.service.ts`                 |
 * | `service user --path lib/x`  | `lib/x/user.service.ts`               |
 */
export function planSchematic(options: PlanSchematicOptions): SchematicPlan {
  const { schematic, context } = options
  const parsed = parseSchematicName(options.name, schematic)
  const base = options.path ?? join(options.root, 'src')
  let directories = [...parsed.directories]
  if (directories.length === 0 && options.path === undefined && options.flat !== true)
    directories = [parsed.names.kebab]
  const file = normalize(join(base, ...directories, `${parsed.names.kebab}.${schematic.suffix}.ts`))
  // --path: the location of the file qualifies the name (src/emails/ → emails.digest)
  const located = options.path === undefined ? undefined : sourceDirectories(options.root, dirname(file))
  const names =
    located === undefined ? parsed.names : { ...parsed.names, qualified: qualifiedName(located, parsed.names.kebab) }
  return {
    schematic,
    names,
    file,
    content: schematic.render(names, context),
    hint: schematic.hint?.(names, context),
  }
}
