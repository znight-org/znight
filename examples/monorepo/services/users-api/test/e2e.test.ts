/**
 * End-to-end test of users-api (opt-in: `ZNIGHT_E2E=1 bun test`, or `bun run test:e2e`).
 *
 * `znight build`, then for Node.js and for Bun: `znight start --runtime <runtime>` → CRUD over real
 * HTTP → SIGTERM → exit code 0, shutdown hooks ran (the users snapshot is saved) → second start
 * restores the snapshot.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { executableOf, expectSuccess, fetchWhenUp, freePort, run, type Service, start } from './support/processes.ts'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

const enabled = process.env.ZNIGHT_E2E === '1'
const ROOT = resolve(import.meta.dir, '..')
const ZNIGHT = join(ROOT, 'node_modules/.bin/znight')
const TIMEOUT = 60_000
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

interface UserBody {
  readonly id: string
  readonly email: string
  readonly name: string
}

/** Starts the build with `znight start` (the `start` script) and waits until it answers. */
async function startApi(runtime: string, env: Record<string, string>): Promise<{ api: Service; base: string }> {
  const port = await freePort()
  const api = start(ZNIGHT, ['start', '--runtime', runtime], { cwd: ROOT, env: { ...env, PORT: String(port) } })
  const base = `http://127.0.0.1:${port}`
  await fetchWhenUp(`${base}/health`, api)
  return { api, base }
}

const json = (body: unknown): RequestInit => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

describe.skipIf(!enabled)('users-api end to end (ZNIGHT_E2E=1)', () => {
  let work: string

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'users-api-e2e-'))
    expectSuccess(await run(ZNIGHT, ['build'], { cwd: ROOT }), 'znight build')
    expect(existsSync(join(ROOT, 'dist/main.js'))).toBe(true)
  }, TIMEOUT)

  afterAll(() => {
    rmSync(work, { recursive: true, force: true })
  })

  for (const runtime of ['node', 'bun']) {
    it(
      `${runtime}: CRUD over HTTP, graceful shutdown on SIGTERM, snapshot restored on restart`,
      async () => {
        const snapshot = join(work, `users-${runtime}.json`)
        const env = { USERS_SNAPSHOT_FILE: snapshot, LOG_LEVEL: 'info' }

        // --- first run: CRUD
        const { api, base } = await startApi(runtime, env)
        let ada: UserBody
        try {
          // `znight start` replaced itself with the runtime (execve): same pid, signals go straight to the app
          expect(api.child.pid).toBeDefined()
          expect(executableOf(api.child.pid ?? 0)).toBe(runtime)

          const created = await fetch(`${base}/users`, {
            method: 'POST',
            ...json({ email: 'Ada@Example.com', name: 'Ada' }),
          })
          expect(created.status).toBe(201)
          ada = (await created.json()) as UserBody
          expect(ada.id).toMatch(UUID_V7) // the @Primary SortableIdGenerator, injected into the library's UserDirectory
          expect(created.headers.get('location')).toBe(`/users/${ada.id}`)

          const grace = (await (
            await fetch(`${base}/users`, { method: 'POST', ...json({ email: 'grace@example.com', name: 'Grace' }) })
          ).json()) as UserBody

          const duplicate = await fetch(`${base}/users`, {
            method: 'POST',
            ...json({ email: 'ADA@example.com', name: 'X' }),
          })
          expect(duplicate.status).toBe(409)
          const invalid = await fetch(`${base}/users`, { method: 'POST', ...json({ email: 'nope', name: 'X' }) })
          expect(invalid.status).toBe(400)
          expect(await invalid.json()).toMatchObject({ details: [{ path: 'email', message: 'Invalid email address' }] })

          const page = (await (await fetch(`${base}/users?limit=10`)).json()) as { items: UserBody[] }
          expect(page.items.map(user => user.name)).toEqual(['Ada', 'Grace']) // creation order

          const renamed = await fetch(`${base}/users/${ada.id}`, { method: 'PATCH', ...json({ name: 'Ada Lovelace' }) })
          expect(await renamed.json()).toMatchObject({ id: ada.id, name: 'Ada Lovelace' })
          expect((await fetch(`${base}/users/${grace.id}`, { method: 'DELETE' })).status).toBe(204)
          expect((await fetch(`${base}/users/${grace.id}`)).status).toBe(404)
          expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ status: 'ok', users: 1 })
        } catch (error) {
          await api.stop('SIGKILL')
          throw new Error(`${String(error)}\n--- output ---\n${api.output()}`)
        }

        // --- graceful shutdown: exit code 0, UserSnapshot.onStop() ran after the HTTP drain
        expect(await api.stop('SIGTERM')).toBe(0)
        const messages = api.logs().map(line => line.msg)
        expect(messages).toContain('Received SIGTERM: shutting down gracefully')
        expect(messages.indexOf('Users snapshot saved')).toBeLessThan(messages.indexOf('Application stopped'))
        const saved = JSON.parse(readFileSync(snapshot, 'utf8')) as UserBody[]
        expect(saved).toEqual([expect.objectContaining({ id: ada.id, email: 'ada@example.com', name: 'Ada Lovelace' })])

        // --- second run: UserSnapshot.onStart() restored the users before the server listened
        const second = await startApi(runtime, env)
        try {
          const users = (await (await fetch(`${second.base}/users`)).json()) as { items: UserBody[] }
          expect(users.items).toEqual([expect.objectContaining({ id: ada.id, name: 'Ada Lovelace' })])
          expect(second.api.logs()).toContainEqual(
            expect.objectContaining({ msg: 'Users restored from snapshot', count: 1 }),
          )
        } finally {
          expect(await second.api.stop('SIGTERM')).toBe(0)
        }
      },
      TIMEOUT,
    )
  }
})
