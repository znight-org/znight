---
description: Use any database client or ORM with Znight - provide it with @Factory/@Provides (async init, migrations, disposal), keep repositories behind interfaces, run transactions and test with mocks or a real database. Drizzle is the recommended choice for SQL.
---

# Data access

Znight does not ship an ORM or a database layer. A database client is a third-party object like any
other: a [factory](./dependency-injection#factories-factory-and-provides) creates it at boot,
repositories inject it, and the compiler checks the wiring. You keep the data library that fits your
data, its query language and its migrations.

For **SQL databases, we strongly recommend [Drizzle ORM](https://orm.drizzle.team)**: typed queries
in plain TypeScript, a schema that is ordinary code (no decorators, no generated client), SQL
migrations, and drivers for PostgreSQL, MySQL and SQLite on Node.js and Bun. The
[`rest-api` example](https://github.com/znight-org/znight/tree/main/examples/rest-api) is the
reference: the factory, repository and test samples below are its files.

::: info No SQL decorators
Znight will not add entity, column, repository or query decorators (`@Entity()`, `@Column()`, SQL
strings in decorators of repository methods...). Decorators in Znight describe wiring and transport;
your schema belongs to your data library. See the [roadmap](/roadmap#not-planned).
:::

The pattern, whatever the library:

1. A `@Factory()` **provides the client**: created (and connected) at boot, closed on shutdown.
2. The injected database gets a **named type** the compiler can match.
3. **Repositories** implement interfaces; services depend on the interfaces, never on the library.
4. **Transactions** wrap service methods, not requests.
5. **Tests** mock the repository interfaces, and run the repositories against a real database.

## Provide the client with a factory {#factory}

A client is not one of your classes, so the compiler cannot construct it. A `@Factory()` class does:
each `@Provides()` method is the provider of its **return type**, and its parameters are injected
like constructor parameters. This is the data layer of `rest-api`:

::: code-group

```ts [src/db/database.factory.ts]
import type { Logger } from '@znight/observability'
import type { DatabaseConfig } from '../config/database.config.js'
import type { Database } from './database.js'

import { PGlite } from '@electric-sql/pglite'
import { Factory, Provides } from '@znight/core'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'

import * as schema from './schema.js'

@Factory()
export class DatabaseFactory {
  @Provides({ dispose: 'close' })
  async client(config: DatabaseConfig, logger: Logger): Promise<PGlite> {
    const client = await PGlite.create(config.dataDir)
    logger.info('Database opened', { dataDir: config.dataDir })
    return client
  }

  @Provides()
  async database(client: PGlite, config: DatabaseConfig, logger: Logger): Promise<Database> {
    const db = drizzle(client, { schema })
    // Applies the pending migrations of the folder (drizzle-kit layout) and records them in the
    // drizzle.__drizzle_migrations table: restarting on an existing database applies nothing.
    await migrate(db, { migrationsFolder: config.migrationsFolder })
    logger.info('Database migrated', { migrationsFolder: config.migrationsFolder })
    return db
  }
}
```

```ts [src/db/database.ts]
import type { PgliteDatabase } from 'drizzle-orm/pglite'
import type * as schema from './schema.js'

/**
 * The Drizzle database of the application: the type repositories inject, provided by
 * `DatabaseFactory.database()`.
 */
export interface Database extends PgliteDatabase<typeof schema> {}
```

```ts [src/config/database.config.ts]
import { Config } from '@znight/config'

/** DATABASE_DATA_DIR, DATABASE_MIGRATIONS_FOLDER, DATABASE_SEED */
@Config('database')
export class DatabaseConfig {
  /** `memory://` (lost on exit) or a directory persisted on disk (`./data/bookshelf`). */
  dataDir = 'memory://'

  /** Folder of the SQL migrations applied at startup, relative to the working directory. */
  migrationsFolder = 'drizzle'

  /** Insert a few sample books when the database is empty. */
  seed = false
}
```

:::

- **Async init.** `Promise<T>` makes a provider async: the container awaits it during
  `Application.create()`, in dependency order, and consumers receive `T`. Independent async
  singletons start concurrently (a database and a Redis client connect in parallel). Async factories
  are singletons only ([`ZNIGHT014`](/reference/error-codes#znight014)).
- **Migrations before the first query.** `database()` depends on the client and migrates before
  returning: no provider can receive a `Database` that is not migrated.
- **Disposal.** `@Provides({ dispose: 'close' })` calls `client.close()` on shutdown, after every
  provider that depends on it has stopped, and also when the boot fails half-way. Without `dispose`,
  `[Symbol.asyncDispose]()` / `[Symbol.dispose]()` are used when the object has them. See
  [Lifecycle](./lifecycle#disposal).
- **Fail fast.** A database that cannot be reached fails the boot with the dependency path, instead
  of failing the first request.

### Give the injected type a name {#named-type}

Injection is resolved by type at build time, so an injected type needs a stable name. Drizzle's
database type is generic (`PgliteDatabase<typeof schema>`): `database.ts` gives it one,
`interface Database`, which the factory returns and repositories inject. Use an interface, not a type
alias: an alias is expanded to the generic type, and `typeof` types cannot be compared by the
compiler. Clients that are plain classes (`PGlite`, `pg.Pool`, `MongoClient`) are injected as they
are.

## Drizzle (recommended for SQL) {#drizzle}

The schema is TypeScript, used to build type-safe queries:

```ts [src/db/schema.ts (excerpt)]
import { sql } from 'drizzle-orm'
import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export const books = pgTable(
  'books',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    isbn: text('isbn').notNull().unique(),
    title: text('title').notNull(),
    author: text('author').notNull(),
    publishedYear: integer('published_year'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [index('books_author_idx').on(table.author)],
)
```

Services depend on a repository **interface**, written in the terms of the domain:

::: code-group

```ts [src/books/book.repository.ts]
import type { Book, BookChanges, BookQuery, Cover, NewBook, Page } from './book.js'

export interface BookRepository {
  list(query: BookQuery): Promise<Page<Book>>
  findById(id: number): Promise<Book | undefined>
  /** @throws DuplicateIsbnError */
  create(book: NewBook, createdBy: string): Promise<Book>
  /** `undefined` when the book does not exist. @throws DuplicateIsbnError */
  update(id: number, changes: BookChanges): Promise<Book | undefined>
  /** `false` when the book does not exist. */
  delete(id: number): Promise<boolean>
  saveCover(id: number, cover: Omit<Cover, 'updatedAt'>): Promise<boolean>
  findCover(id: number): Promise<Cover | undefined>
}
```

```ts [src/books/drizzle-book.repository.ts (excerpt)]
import type { Database } from '../db/database.js'
import type { BookRepository } from './book.repository.js'

import { Injectable } from '@znight/core'
import { eq } from 'drizzle-orm'

import { books } from '../db/schema.js'
import { type Book, DuplicateIsbnError, type NewBook } from './book.js'

/** PostgreSQL error code (https://www.postgresql.org/docs/current/errcodes-appendix.html). */
const UNIQUE_VIOLATION = '23505'

@Injectable()
export class DrizzleBookRepository implements BookRepository {
  constructor(private readonly db: Database) {}

  async create(book: NewBook, createdBy: string): Promise<Book> {
    try {
      const [created] = await this.db
        .insert(books)
        .values({ ...book, tags: book.tags ? [...book.tags] : [], createdBy })
        .returning()
      if (created === undefined) throw new Error('INSERT returned no row')
      return { ...created, coverUpdatedAt: null }
    } catch (error) {
      // a database error becomes a domain error: the service and the HTTP layer never see SQL
      if (pgErrorCode(error) === UNIQUE_VIOLATION) throw new DuplicateIsbnError(book.isbn)
      throw error
    }
  }

  async delete(id: number): Promise<boolean> {
    if (!isBookId(id)) return false
    const deleted = await this.db.delete(books).where(eq(books.id, id)).returning({ id: books.id })
    return deleted.length > 0
  }

  // list(), findById(), update(), saveCover(), findCover()...
}

/** Ids are PostgreSQL `integer`s: anything else cannot exist (and would fail the query). */
function isBookId(id: number): boolean {
  return Number.isSafeInteger(id) && id >= 1 && id <= 2_147_483_647
}

/** SQLSTATE of a database error: Drizzle wraps driver errors and keeps the original as `cause`. */
function pgErrorCode(error: unknown): string | undefined {
  for (let current = error, depth = 0; current instanceof Error && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string') return code
    current = current.cause
  }
  return undefined
}
```

```ts [src/books/book.service.ts (excerpt)]
import type { BookRepository } from './book.repository.js'

import { Injectable } from '@znight/core'
import type { Logger } from '@znight/observability'

import { BookNotFoundError } from './book.js'

@Injectable()
export class BookService {
  constructor(
    private readonly books: BookRepository, // bound to DrizzleBookRepository by the compiler
    private readonly logger: Logger,
  ) {}

  async remove(id: number): Promise<void> {
    if (!(await this.books.delete(id))) throw new BookNotFoundError(id)
    this.logger.info('Book removed', { bookId: id })
  }
}
```

:::

`DrizzleBookRepository` is the only class implementing `BookRepository`, so the compiler binds every
`BookRepository` injection to it ([how](./dependency-injection#injecting-interfaces-and-base-classes)).
The service throws domain errors; an [exception mapper](/packages/http#errors) turns them into
`404` / `409` responses.

### Migrations

`rest-api` keeps its SQL migrations in `drizzle/`, in the folder layout of
[drizzle-kit](https://orm.drizzle.team/docs/kit-overview), and applies them at startup with Drizzle's
migrator (above). In your project, add `drizzle-kit` and generate them from the schema
(`drizzle-kit generate`). Migrating at startup suits a single instance and tests; with several
instances, run the migrations once per release instead (a job of your deployment running
`drizzle-kit migrate`, or a small script calling `migrate()`), and keep the factory to the
connection.

### A PostgreSQL server

`rest-api` runs on [PGlite](https://pglite.dev) (PostgreSQL compiled to WebAssembly) so that it needs
no server. For a PostgreSQL server, only the factory and the named type change; repositories,
services and tests stay the same:

::: code-group

```ts [src/db/database.factory.ts]
import type { DatabaseConfig } from '../config/database.config.js'
import type { Database } from './database.js'

import { Factory, Provides } from '@znight/core'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'

import * as schema from './schema.js'

@Factory()
export class DatabaseFactory {
  @Provides({ dispose: 'end' }) // pool.end() on shutdown
  async pool(config: DatabaseConfig): Promise<Pool> {
    const pool = new Pool({ connectionString: config.url })
    await pool.query('select 1') // fail fast at boot
    return pool
  }

  @Provides()
  async database(pool: Pool, config: DatabaseConfig): Promise<Database> {
    const db = drizzle(pool, { schema })
    await migrate(db, { migrationsFolder: config.migrationsFolder })
    return db
  }
}
```

```ts [src/db/database.ts]
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from './schema.js'

export interface Database extends NodePgDatabase<typeof schema> {}
```

```ts [src/config/database.config.ts]
import { Config, Secret } from '@znight/config'

@Config('database')
export class DatabaseConfig {
  /** `postgres://user:password@host:5432/db`: a secret, never printed. */
  @Secret('DATABASE_URL')
  url!: string

  migrationsFolder = 'drizzle'
}
```

:::

On Bun, `drizzle-orm/bun-sql` uses Bun's built-in PostgreSQL client instead of `pg`.

## Transactions

When a unit of work stays inside one repository method, use the library directly:
`this.db.transaction(async tx => { ... })` with Drizzle.

When it spans several repositories, the service decides, and the repositories must run their queries
on the transaction in progress. A small provider carries the transaction with `AsyncLocalStorage`, and
a [method interceptor](./aop) opens it around a service method:

::: code-group

```ts [src/db/database.ts]
import type { PgDatabase } from 'drizzle-orm/pg-core'
import type { PgliteDatabase, PgliteQueryResultHKT } from 'drizzle-orm/pglite'
import type * as schema from './schema.js'

export interface Database extends PgliteDatabase<typeof schema> {}

/** What a query runs on: the database, or the transaction in progress (a `PgTransaction` is a `PgDatabase`). */
export type Executor = PgDatabase<PgliteQueryResultHKT, typeof schema>
```

```ts [src/db/transactions.ts]
import type { Database, Executor } from './database.js'

import { AsyncLocalStorage } from 'node:async_hooks'
import { Injectable } from '@znight/core'

@Injectable()
export class Transactions {
  readonly #current = new AsyncLocalStorage<Executor>()

  constructor(private readonly db: Database) {}

  /** The transaction in progress, or the database outside of one. */
  get executor(): Executor {
    return this.#current.getStore() ?? this.db
  }

  /** Runs `work` in a transaction: committed when it resolves, rolled back when it throws. Nested calls join the current one. */
  run<T>(work: () => Promise<T>): Promise<T> {
    if (this.#current.getStore() !== undefined) return work()
    return this.db.transaction(tx => this.#current.run(tx, work))
  }
}
```

```ts [src/db/transactional.interceptor.ts]
import { Injectable, type MethodInterceptor, type MethodInvocation } from '@znight/core'

import { Transactions } from './transactions.js'

@Injectable()
export class TransactionalInterceptor implements MethodInterceptor {
  constructor(private readonly transactions: Transactions) {}

  intercept(invocation: MethodInvocation) {
    if (!invocation.isAsync) {
      throw new Error(`${invocation.className}.${invocation.methodName}() must be async to run in a transaction`)
    }
    return this.transactions.run(() => invocation.proceed() as Promise<unknown>)
  }
}
```

```ts [src/orders/order.service.ts]
import { Injectable, Intercept } from '@znight/core'

import { TransactionalInterceptor } from '../db/transactional.interceptor.js'

@Injectable()
export class OrderService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly stock: StockRepository,
  ) {}

  @Intercept(TransactionalInterceptor)
  async place(order: NewOrder): Promise<Order> {
    await this.stock.reserve(order.items) // same transaction...
    return await this.orders.create(order) // ...rolled back together if this throws
  }
}
```

```ts [src/orders/drizzle-order.repository.ts (excerpt)]
import { Injectable } from '@znight/core'

import { orders } from '../db/schema.js'
import { Transactions } from '../db/transactions.js'

@Injectable()
export class DrizzleOrderRepository implements OrderRepository {
  constructor(private readonly transactions: Transactions) {}

  async create(order: NewOrder): Promise<Order> {
    const [created] = await this.transactions.executor.insert(orders).values(order).returning()
    // ...
  }
}
```

:::

- The transaction commits when the method resolves and rolls back when it throws. A transactional
  method called from another one joins its transaction.
- `AsyncLocalStorage` (`node:async_hooks`) works the same on Node.js and Bun: concurrent requests
  never see each other's transaction.
- Keep transactions short: no HTTP call nor message publication inside. To publish an event with the
  data it describes, write it to an outbox table in the same transaction (the
  [`uptime-monitor` example](https://github.com/znight-org/znight/tree/main/examples/uptime-monitor)
  has an outbox).
- In unit tests, `TestBed` does not apply method interceptors unless `aop: 'real'`
  ([Testing](./testing#testbed-unit-tests-with-auto-mocks)).

::: details A whole HTTP request in one transaction
An [HTTP interceptor](/packages/http#interceptors) can wrap the handler instead
(`@UseInterceptor(TransactionPerRequest)` on a controller or a route):

```ts
import { Injectable } from '@znight/core'
import type { CallHandler, HttpContext, HttpInterceptor } from '@znight/http'

import { Transactions } from '../db/transactions.js'

@Injectable()
export class TransactionPerRequest implements HttpInterceptor {
  constructor(private readonly transactions: Transactions) {}

  intercept(_ctx: HttpContext, next: CallHandler) {
    return this.transactions.run(next)
  }
}
```

`next()` resolves with the handler result before it is serialised, so the transaction commits before
the response is written. Do not use it for streamed responses (`HttpResponse.stream()`, Server-Sent
Events): they would read after the commit.
:::

::: tip Why not a request-scoped provider?
[Request-scoped providers](./scopes) are the right place for per-request data (the current user, a
tenant), not for a transaction: their factory cannot be async
([`ZNIGHT014`](/reference/error-codes#znight014)), and when the scope closes their disposal does not
know whether the request failed. An interceptor sees the outcome.
:::

## Testing

### Unit tests: mock the repository

Services depend on interfaces, so their tests need no database. `TestBed` builds the real service
with its generated factory and auto-mocks its dependencies; an interface's mock is looked up by name:

```ts [test/book.service.test.ts]
import type { BookRepository } from '../src/books/book.repository.js'

import { Logger } from '@znight/observability'
import { TestBed } from '@znight/testing'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { BookNotFoundError } from '../src/books/book.js'
import { BookService } from '../src/books/book.service.js'
import { describe, expect, test as it } from 'bun:test'

async function setup() {
  const { instance, mocks } = await TestBed.create(BookService, { metadata })
  return { service: instance, repository: mocks.get<BookRepository>('BookRepository'), logger: mocks.get(Logger) }
}

describe('BookService', () => {
  it('removes a book and logs it', async () => {
    const { service, repository, logger } = await setup()
    repository.delete.mockResolvedValue(true)

    await service.remove(3)

    expect(logger.info).toHaveBeenCalledWith('Book removed', { bookId: 3 })
  })

  it('refuses to remove an unknown book', async () => {
    const { service, repository } = await setup()
    repository.delete.mockResolvedValue(false)

    await expect(service.remove(3)).rejects.toBeInstanceOf(BookNotFoundError)
  })
})
```

### Repository tests on a real database

Mocking the database tells you nothing about your SQL. Test repositories against a real one. With
PGlite, every test gets a fresh, migrated PostgreSQL in a few milliseconds, in-process. Providers are
plain classes, so the test builds them with the application's own factory, without a container:

::: code-group

```ts [test/support/database.ts]
import type { PGlite } from '@electric-sql/pglite'
import type { Logger } from '@znight/observability'
import type { Database } from '../../src/db/database.js'

import { createMock } from '@znight/testing'

import { DatabaseConfig } from '../../src/config/database.config.js'
import { DatabaseFactory } from '../../src/db/database.factory.js'
import { MIGRATIONS_FOLDER } from './fixtures.js'

export interface TestDatabase {
  readonly db: Database
  readonly client: PGlite
  close(): Promise<void>
}

/** A fresh in-memory PostgreSQL, migrated with the application's own factory. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const config = Object.assign(new DatabaseConfig(), { migrationsFolder: MIGRATIONS_FOLDER })
  const logger = createMock<Logger>()
  const factory = new DatabaseFactory()
  const client = await factory.client(config, logger)
  const db = await factory.database(client, config, logger)
  return { db, client, close: () => client.close() }
}
```

```ts [test/drizzle-book.repository.test.ts (excerpt)]
import { DuplicateIsbnError, type NewBook } from '../src/books/book.js'
import { DrizzleBookRepository } from '../src/books/drizzle-book.repository.js'
import { createTestDatabase, type TestDatabase } from './support/database.js'
import { afterEach, beforeEach, describe, expect, test as it } from 'bun:test'

describe('DrizzleBookRepository', () => {
  let database: TestDatabase
  let repository: DrizzleBookRepository

  beforeEach(async () => {
    database = await createTestDatabase()
    repository = new DrizzleBookRepository(database.db)
  })

  afterEach(async () => {
    await database.close()
  })

  const hobbit: NewBook = { isbn: '9780547928227', title: 'The Hobbit', author: 'J. R. R. Tolkien' }

  it('turns a unique violation into a domain error', async () => {
    await repository.create(hobbit, 'admin')

    await expect(repository.create({ ...hobbit, title: 'Again' }, 'admin')).rejects.toBeInstanceOf(DuplicateIsbnError)
  })
})
```

:::

For a database server (PostgreSQL, MySQL, MongoDB...), start one per test run with
[Testcontainers](https://testcontainers.com) and create a schema or a database per test file. The
`uptime-monitor` example tests its Redis lock store this way (`bun run test:integration`).

### Application tests

[`TestApp`](./testing#testapp-end-to-end-tests) boots the real application, database included. Point
the configuration at a throwaway database: `rest-api` passes `inline({ DATABASE_MIGRATIONS_FOLDER:
... })` to `ConfigPlugin` and keeps the default `memory://` data directory, so every `TestApp` gets its
own migrated in-memory database. To share one database between two applications (two instances of a
service), override the client with a value: `overrides: [[PGlite, client]]`. Values are never
disposed by the container, so the test closes the client itself.

## Other libraries {#other-libraries}

The same pattern applies to any client: a factory provides it, a named type when it is generic,
repositories behind interfaces.

- **Prisma.** Provide the generated `PrismaClient` from an async `@Provides()` method that creates it
  the way your Prisma version expects (with its driver adapter in recent versions), awaits
  `$connect()` and returns it, with `dispose: '$disconnect'`. Repositories inject `PrismaClient`, a
  class with a stable name. Transactions use `prisma.$transaction(async tx => ...)`. Run
  `prisma generate` before `znight build` (the client is generated code), and `prisma migrate deploy`
  as a release step.
- **Kysely.** `Kysely<DB>` is generic: give it a name, as with Drizzle
  (`export interface Db extends Kysely<DB> {}`), and provide it with `dispose: 'destroy'`. Kysely's
  own `Migrator` runs the migrations, `db.transaction().execute(async trx => ...)` the transactions.
- **MongoDB.** Provide the official driver's `MongoClient` from an async method
  (`await client.connect()`, `dispose: 'close'`) and the `Db` from a second `@Provides()` method
  (`client.db(name)`). Repositories inject `Db` and use typed collections; validate documents at the
  boundary with the schemas you already use for HTTP (Zod, Valibot...).
- **Redis.** Provide the client (ioredis, node-redis or Bun's built-in `RedisClient`) the same way,
  closing it on shutdown (`dispose: 'quit'` for ioredis, `'close'` for Bun's client). For caching,
  put it behind the `CacheStore` interface of the [cache recipe](./aop#cache); for distributed locks
  of scheduled jobs, see the [Redis lock store](./scheduling#redis-lock-store).

Several databases in one application are several providers of the same type: name them with
`@Provides({ name })` and choose with a [qualifier](./dependency-injection#qualifiers-named-and-inject),
or give each its own named type (`interface ReportingDatabase`).
