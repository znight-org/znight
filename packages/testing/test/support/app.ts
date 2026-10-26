/**
 * A small application and the metadata the compiler would generate for it (hand-written, same
 * shape as `src/.znight/container.generated.ts`).
 */
import type { Lazy, MethodInterceptor, MethodInvocation, ProviderDefinition, ZnightMetadata } from '@znight/core'

import { Injectable } from '@znight/core'

import { createMetadata } from '../../src/index.ts'

export interface User {
  readonly id: string
  readonly name: string
}

export interface Logger {
  info(message: string, context?: Record<string, unknown>): void
  error(message: string, context?: Record<string, unknown>): void
}

export interface ConfigSource {
  get(key: string): string | undefined
}

@Injectable()
export class Database {
  readonly connected = true

  query(sql: string, params: readonly unknown[] = []): Promise<unknown[]> {
    return Promise.resolve([{ sql, params }])
  }
}

export abstract class UserRepository {
  abstract findById(id: string): Promise<User | undefined>
  abstract save(user: User): Promise<void>
}

@Injectable()
export class PgUserRepository extends UserRepository {
  constructor(private readonly db: Database) {
    super()
  }

  get table(): string {
    return 'users'
  }

  async findById(id: string): Promise<User | undefined> {
    const [row] = await this.db.query('select * from users where id = $1', [id])
    return row as User | undefined
  }

  async save(user: User): Promise<void> {
    await this.db.query('insert into users values ($1, $2)', [user.id, user.name])
  }
}

export class AppConfig {
  name = 'znight'
  port!: number
  debug = false
  tags!: string[]
  apiKey!: string
}

export interface Cache {
  get(key: string): unknown
}

export interface UserListener {
  onUser(user: User): void
}

@Injectable()
export class AuditListener implements UserListener {
  readonly seen: User[] = []
  onUser(user: User): void {
    this.seen.push(user)
  }
}

@Injectable()
export class MailListener implements UserListener {
  onUser(): void {}
}

@Injectable()
export class AuditService {
  record(action: string): string {
    return action
  }
}

@Injectable()
export class TimingInterceptor implements MethodInterceptor<{ label: string }> {
  readonly labels: string[] = []
  constructor(readonly logger: Logger) {}

  async intercept(invocation: MethodInvocation, options: { label: string }): Promise<unknown> {
    this.labels.push(options.label)
    this.logger.info(`${options.label}:start`)
    return { intercepted: await invocation.proceed() }
  }
}

@Injectable()
export class UserService {
  constructor(
    readonly repository: UserRepository,
    readonly logger: Logger,
    readonly config: AppConfig,
    readonly databaseUrl: string,
    readonly cache: Cache | undefined,
    readonly listeners: readonly UserListener[],
    readonly audit: Lazy<AuditService>,
  ) {}

  async findById(id: string): Promise<User | undefined> {
    this.logger.info('find', { id })
    const user = await this.repository.findById(id)
    if (user !== undefined) for (const listener of this.listeners) listener.onUser(user)
    return user
  }

  describe(): string {
    return `${this.config.name}@${this.databaseUrl}`
  }

  track(action: string): string {
    return this.audit.get().record(action)
  }
}

@Injectable()
export class UserController {
  constructor(readonly users: UserService) {}

  getUser(id: string): Promise<User | undefined> {
    return this.users.findById(id)
  }
}

/** A provider whose factory always fails (outside of the controllers' closure). */
@Injectable()
export class BrokenService {
  constructor() {
    throw new Error('broken on purpose')
  }
}

export const T = {
  Database: 'src/db/database.ts#Database',
  UserRepository: 'src/users/user.repository.ts#UserRepository',
  PgUserRepository: 'src/users/pg-user.repository.ts#PgUserRepository',
  AppConfig: 'src/config/app.config.ts#AppConfig',
  DatabaseUrl: 'src/db/db.factory.ts#DbFactory.databaseUrl',
  Cache: 'src/cache/cache.ts#Cache',
  AuditListener: 'src/users/audit.listener.ts#AuditListener',
  MailListener: 'src/users/mail.listener.ts#MailListener',
  AuditService: 'src/audit/audit.service.ts#AuditService',
  TimingInterceptor: 'src/timing.interceptor.ts#TimingInterceptor',
  UserService: 'src/users/user.service.ts#UserService',
  UserController: 'src/users/user.controller.ts#UserController',
  BrokenService: 'src/broken.service.ts#BrokenService',
  Logger: '@znight/observability#Logger',
  ConfigSource: '@znight/config#ConfigSource',
  HttpContext: '@znight/http#HttpContext',
} as const

/** Builds a config instance like `@znight/config`'s `loadConfig` would (reads `ConfigSource`). */
function loadAppConfig(source: ConfigSource): AppConfig {
  const config = new AppConfig()
  config.port = Number(source.get('PORT') ?? 3000)
  config.apiKey = source.get('API_KEY') as string
  return config
}

export interface HttpRouteLike {
  readonly method: string
  readonly path: string
  readonly fullPath: string
  readonly handler: string
  readonly status?: number
  readonly guards: readonly string[]
  readonly interceptors: readonly string[]
  readonly meta: Readonly<Record<string, unknown>>
  readonly params: readonly unknown[]
  invoke(controller: never, ctx: { readonly params: Record<string, string>; readonly body: unknown }): unknown
}

/** The metadata of the application above, as generated by the compiler. */
export function appMetadata(): ZnightMetadata {
  const providers: Record<string, ProviderDefinition> = {
    [T.Database]: { scope: 'singleton', class: Database, deps: [], factory: () => new Database() },
    [T.PgUserRepository]: {
      scope: 'singleton',
      class: PgUserRepository,
      deps: [T.Database],
      factory: d => new PgUserRepository(d[0]),
    },
    [T.AppConfig]: {
      scope: 'singleton',
      class: AppConfig,
      deps: [T.ConfigSource],
      factory: d => loadAppConfig(d[0]),
    },
    [T.DatabaseUrl]: {
      scope: 'singleton',
      deps: [T.AppConfig],
      factory: d => `postgres://${(d[0] as AppConfig).name}`,
      name: 'databaseUrl',
    },
    [T.AuditListener]: { scope: 'singleton', class: AuditListener, deps: [], factory: () => new AuditListener() },
    [T.MailListener]: { scope: 'singleton', class: MailListener, deps: [], factory: () => new MailListener() },
    [T.AuditService]: { scope: 'singleton', class: AuditService, deps: [], factory: () => new AuditService() },
    [T.TimingInterceptor]: {
      scope: 'singleton',
      class: TimingInterceptor,
      deps: [T.Logger],
      factory: d => new TimingInterceptor(d[0]),
    },
    [T.UserService]: {
      scope: 'singleton',
      class: UserService,
      deps: [
        T.PgUserRepository,
        T.Logger,
        T.AppConfig,
        T.DatabaseUrl,
        { token: T.Cache, optional: true },
        { multi: [T.AuditListener, T.MailListener] },
        { lazy: T.AuditService },
        T.TimingInterceptor,
      ],
      factory: d => new UserService(d[0], d[1], d[2], d[3], d[4], d[5], d[6]),
      interceptors: { findById: { async: true, chain: [{ dep: 7, options: { label: 'users.find' } }] } },
      source: { file: 'src/users/user.service.ts', line: 3, column: 1 },
    },
    [T.UserController]: {
      scope: 'singleton',
      class: UserController,
      deps: [T.UserService],
      factory: d => new UserController(d[0]),
    },
    [T.BrokenService]: { scope: 'singleton', class: BrokenService, deps: [], factory: () => new BrokenService() },
  }
  const route: HttpRouteLike = {
    method: 'GET',
    path: '/:id',
    fullPath: '/users/:id',
    handler: 'getUser',
    guards: [],
    interceptors: [],
    meta: {},
    params: [{ index: 0, source: 'param', name: 'id', type: 'string' }],
    invoke: (controller, ctx) => (controller as UserController).getUser(ctx.params['id'] as string),
  }
  return createMetadata(providers, {
    aliases: { [T.UserRepository]: T.PgUserRepository },
    externals: [
      { token: T.Logger, providedBy: 'ObservabilityPlugin' },
      { token: T.ConfigSource, providedBy: 'ConfigPlugin' },
      { token: T.HttpContext, providedBy: 'HttpPlugin', scope: 'request' },
    ],
    extensions: {
      http: {
        controllers: [
          { token: T.UserController, basePath: '/users', guards: [], interceptors: [], meta: {}, routes: [route] },
        ],
      },
      config: {
        configs: [
          {
            token: T.AppConfig,
            prefix: 'app',
            fields: [
              {
                property: 'name',
                env: 'APP_NAME',
                key: 'app.name',
                type: 'string',
                default: 'znight',
                required: true,
                secret: false,
              },
              {
                property: 'port',
                env: 'PORT',
                key: 'app.port',
                type: 'number',
                default: 3000,
                required: true,
                secret: false,
              },
              {
                property: 'debug',
                env: 'DEBUG',
                key: 'app.debug',
                type: 'boolean',
                default: false,
                required: false,
                secret: false,
              },
              {
                property: 'tags',
                env: 'TAGS',
                key: 'app.tags',
                type: 'string[]',
                default: ['a', 'b'],
                required: false,
                secret: false,
              },
              { property: 'apiKey', env: 'API_KEY', key: 'app.apiKey', type: 'string', required: true, secret: true },
            ],
          },
        ],
      },
    },
  })
}
