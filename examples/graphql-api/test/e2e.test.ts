/**
 * End-to-end test (opt-in, `ZNIGHT_E2E=1`, `bun run test:e2e`): builds the application for
 * production with `znight build`, then starts the bundle with Node.js and with Bun as a separate
 * process configured through environment variables, and talks to it over real HTTP: a query, a
 * mutation with an API key, a subscription over Server-Sent Events receiving the added book, and a
 * SIGTERM while the subscription streams (the stream ends without `complete`, exit code 0).
 *
 * In this repository the build imports the @znight/* packages from their `dist` (like packages
 * installed from npm): run `bun run build` at the repository root first.
 */
import type { SseItem } from '@znight/http'

import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSseStream } from '@znight/http'

import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

const ENABLED = process.env.ZNIGHT_E2E === '1'
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const EDITOR_KEY = 'e2e-editor-key'
const READER_KEY = 'e2e-reader-key'
const TIMEOUT = 60_000

/** A JSON log line of the application. */
interface LogEntry {
  readonly level: number
  readonly msg: string
  readonly [field: string]: unknown
}

interface Exit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

/** A GraphQL result over the wire. */
interface Result {
  readonly data?: Record<string, unknown> | null
  readonly errors?: readonly { readonly message: string; readonly extensions?: { readonly code?: string } }[]
}

/** The application running in a child process. */
class AppProcess {
  readonly #child: ChildProcess
  readonly exited: Promise<Exit>
  #output = ''

  constructor(command: string, args: readonly string[], env: Record<string, string>) {
    this.#child = spawn(command, [...args], {
      cwd: ROOT,
      env: { ...process.env, NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.#child.stdout?.on('data', chunk => {
      this.#output += chunk
    })
    this.#child.stderr?.on('data', chunk => {
      this.#output += chunk
    })
    this.exited = new Promise(resolve => this.#child.once('exit', (code, signal) => resolve({ code, signal })))
  }

  /** The JSON log lines written so far. */
  logs(): LogEntry[] {
    return this.#output
      .split('\n')
      .filter(line => line.startsWith('{'))
      .flatMap(line => {
        try {
          return [JSON.parse(line) as LogEntry]
        } catch {
          return []
        }
      })
  }

  /** Waits for a log entry whose message is `message` (fails early when the process exits). */
  async waitForLog(message: string, timeoutMs = TIMEOUT): Promise<LogEntry> {
    const deadline = Date.now() + timeoutMs
    let exited = false
    void this.exited.then(() => {
      exited = true
    })
    while (Date.now() < deadline) {
      const entry = this.logs().find(log => log.msg === message)
      if (entry !== undefined) return entry
      if (exited) throw new Error(`The application exited before logging "${message}":\n${this.#output}`)
      await Bun.sleep(50)
    }
    throw new Error(`The application did not log "${message}" within ${timeoutMs} ms:\n${this.#output}`)
  }

  /** Sends SIGTERM and waits for the process to exit. */
  async stop(): Promise<Exit> {
    this.#child.kill('SIGTERM')
    return await this.exited
  }

  kill(): void {
    if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill('SIGKILL')
  }
}

function run(command: string, args: readonly string[]): Promise<{ code: number | null; output: string }> {
  return new Promise(resolve => {
    const child = spawn(command, [...args], { cwd: ROOT, env: { ...process.env, NO_COLOR: '1' } })
    let output = ''
    child.stdout.on('data', chunk => {
      output += chunk
    })
    child.stderr.on('data', chunk => {
      output += chunk
    })
    child.once('exit', code => resolve({ code, output }))
  })
}

/** POSTs an operation to `/graphql`. */
async function graphql(
  url: string,
  query: string,
  variables: Record<string, unknown> = {},
  key?: string,
): Promise<{ status: number; result: Result }> {
  const response = await fetch(`${url}/graphql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/graphql-response+json',
      ...(key === undefined ? {} : { 'x-api-key': key }),
    },
    body: JSON.stringify({ query, variables }),
  })
  return { status: response.status, result: (await response.json()) as Result }
}

const ADD_BOOK = 'mutation Add($input: NewBookInput!) { addBook(input: $input) { id title author { name } } }'

/** A new book for each call. */
let added = 0
function newBook(): Record<string, unknown> {
  added++
  return { title: `Fantasy ${added}`, isbn: String(9_780_000_000_000 + added), authorId: 'a3', genre: 'Fantasy' }
}

describe.skipIf(!ENABLED)('end to end (production build)', () => {
  const running: AppProcess[] = []

  function start(runtime: 'node' | 'bun'): AppProcess {
    const args = runtime === 'node' ? ['--enable-source-maps', 'dist/main.js'] : ['dist/main.js']
    const app = new AppProcess(runtime, args, {
      NODE_ENV: 'production',
      EDITOR_API_KEY: EDITOR_KEY,
      READER_API_KEY: READER_KEY,
      HOST: '127.0.0.1',
      PORT: '0', // a free port: the actual URL is read from the "ready" log line
      LOG_LEVEL: 'info',
    })
    running.push(app)
    return app
  }

  beforeAll(async () => {
    const cli = join(ROOT, 'node_modules/@znight/cli/dist/cli.mjs')
    if (!existsSync(cli)) {
      throw new Error('The @znight/* packages are not built: run `bun run build` at the repository root')
    }
    // `npm run build`: the CLI runs on Node.js, Vite builds src/main.ts into dist/main.js
    const build = await run('node', [cli, 'build'])
    if (build.code !== 0) throw new Error(`znight build failed:\n${build.output}`)
    expect(existsSync(join(ROOT, 'dist/main.js'))).toBe(true)
  }, TIMEOUT)

  afterAll(() => {
    for (const app of running) app.kill()
  })

  it.each(['node', 'bun'] as const)(
    'serves queries, mutations and subscriptions on %s',
    async runtime => {
      const app = start(runtime)
      const ready = await app.waitForLog('Book catalog ready')
      const url = String(ready.url)
      expect(await app.waitForLog('GraphQL endpoint ready')).toMatchObject({ path: '/graphql' })

      // a query, anonymous
      const books = await graphql(url, '{ books(genre: Fantasy) { total items { title author { name } } } }')
      expect(books.status).toBe(200)
      expect(books.result).toEqual({
        data: {
          books: {
            total: 2,
            items: [
              { title: 'A Wizard of Earthsea', author: { name: 'Ursula K. Le Guin' } },
              { title: 'The Hobbit', author: { name: 'J. R. R. Tolkien' } },
            ],
          },
        },
      })

      // production defaults: no introspection
      const introspection = await graphql(url, '{ __schema { queryType { name } } }')
      expect(introspection.status).toBe(400)

      // a mutation needs the editor key
      const anonymous = await graphql(url, ADD_BOOK, { input: newBook() })
      const reader = await graphql(url, ADD_BOOK, { input: newBook() }, READER_KEY)
      expect(anonymous.result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED')
      expect(reader.result.errors?.[0]?.extensions?.code).toBe('FORBIDDEN')
      expect((await graphql(url, '{ books { total } }', {}, 'wrong-key')).status).toBe(401)
      const book = newBook()
      const created = await graphql(url, ADD_BOOK, { input: book }, EDITOR_KEY)
      expect(created.result).toEqual({
        data: { addBook: { id: 'b7', title: book.title, author: { name: 'J. R. R. Tolkien' } } },
      })

      // a subscription over SSE: the reader follows the fantasy books
      const controller = new AbortController()
      const response = await fetch(`${url}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'x-api-key': READER_KEY },
        body: JSON.stringify({ query: 'subscription { bookAdded(genre: Fantasy) { title author { name } } }' }),
        signal: controller.signal,
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
      const items: SseItem[] = []
      const reading = (async () => {
        for await (const item of parseSseStream(response.body as ReadableStream<Uint8Array>)) items.push(item)
      })().catch(() => undefined) // aborted at the end
      const nextEvents = (): SseItem[] => items.filter(item => item.type === 'event' && item.event === 'next')

      // the headers arrive once the resolver's generator has subscribed to the PubSub: publish now
      const input = newBook()
      expect((await graphql(url, ADD_BOOK, { input }, EDITOR_KEY)).result.errors).toBeUndefined()
      for (let wait = 0; wait < 200 && nextEvents().length === 0; wait++) await Bun.sleep(25)
      const [event] = nextEvents()
      expect(event?.type === 'event' ? JSON.parse(event.data) : undefined).toEqual({
        data: { bookAdded: { title: input.title, author: { name: 'J. R. R. Tolkien' } } },
      })

      // SIGTERM while the subscription streams: the stream ends without `complete`, the process exits
      const exit = await app.stop()
      await reading
      controller.abort()

      expect(exit).toEqual({ code: 0, signal: null })
      expect(items.some(item => item.type === 'event' && item.event === 'complete')).toBe(false)
      const messages = app.logs().map(log => log.msg)
      expect(messages).toContain('Book added')
      expect(messages).toContain('Book catalog stopping')
      expect(app.logs().filter(log => log.level >= 50)).toEqual([]) // no error during the whole run
    },
    TIMEOUT,
  )
})
