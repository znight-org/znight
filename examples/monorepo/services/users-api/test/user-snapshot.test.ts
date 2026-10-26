import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Logger } from '@znight/observability'
import { TestBed } from '@znight/testing'
import { type User, UserDirectory } from '@znight-examples/shared'

import { __ZNIGHT_METADATA__ as metadata } from '../src/.znight/container.generated.js'
import { UserSnapshot } from '../src/users/user-snapshot.js'
import { afterEach, beforeEach, describe, expect, test as it } from 'bun:test'

const ada: User = {
  id: '0191d2b1-6a2c-7000-8000-000000000001',
  email: 'ada@example.com',
  name: 'Ada',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

// TestBed: the real UserSnapshot, an auto-mocked UserDirectory (a library provider) and Logger, and
// a real ApiConfig instance with the values given in `config` (keyed by its @Config prefix).
describe('UserSnapshot', () => {
  let directory: string
  let file: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'users-api-'))
    file = join(directory, 'snapshots', 'users.json')
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  const create = () => TestBed.create(UserSnapshot, { metadata, config: { api: { snapshotFile: file } } })

  it('onStop saves every user', async () => {
    const { instance, mocks } = await create()
    mocks.get(UserDirectory).all.mockReturnValue([ada])

    await instance.onStop()

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([ada])
    expect(mocks.get(Logger).info).toHaveBeenCalledWith('Users snapshot saved', { file, count: 1 })
  })

  it('onStart restores the saved users, validated by the shared User schema', async () => {
    const { instance, mocks } = await create()
    mocks.get(UserDirectory).all.mockReturnValue([ada])
    await instance.onStop()

    await instance.onStart()

    expect(mocks.get(UserDirectory).upsert).toHaveBeenCalledWith(ada)
  })

  it('onStart refuses a corrupted snapshot', async () => {
    const { instance } = await create()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify([{ ...ada, email: 'nope' }]))

    await expect(instance.onStart()).rejects.toThrow('record 0: email: Invalid email address')
  })

  it('does nothing without USERS_SNAPSHOT_FILE', async () => {
    const { instance, mocks } = await TestBed.create(UserSnapshot, { metadata })

    await instance.onStart()
    await instance.onStop()

    expect(mocks.get(UserDirectory).all).not.toHaveBeenCalled()
  })
})
