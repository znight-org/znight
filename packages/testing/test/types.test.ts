/**
 * Compile-time checks of the public types (verified by `bun run typecheck`), executed as a smoke
 * test at runtime.
 */

import { token } from '@znight/core'

import {
  createMock,
  createSpy,
  type DeepMock,
  type Mocked,
  type MockFunction,
  override,
  TestBed,
} from '../src/index.ts'
import { appMetadata, type Logger, PgUserRepository, type User, UserRepository, UserService } from './support/app.ts'
import { expect, test as it } from 'bun:test'

const metadata = appMetadata()

it('TestBed results and mocks are typed from classes', async () => {
  const { instance, mocks } = await TestBed.create(UserService, {
    metadata,
    provide: { 'DbFactory.databaseUrl': 'postgres://' },
  })
  const service: UserService = instance
  const repository: Mocked<UserRepository> = mocks.get(UserRepository)
  repository.findById.mockResolvedValue({ id: '1', name: 'Ada' })
  // @ts-expect-error the resolved value must be a User
  repository.findById.mockResolvedValue(42)
  // a mock is assignable to the mocked type, private members included
  const concrete: PgUserRepository = mocks.get(PgUserRepository)
  const asRepository: UserRepository = repository
  const untyped: DeepMock = mocks.get('Logger')
  untyped.info?.mockReturnValue(undefined)
  const logger: Mocked<Logger> = mocks.get(token<Logger>('@znight/observability#Logger'))
  logger.info.mockImplementation(() => undefined)
  const explicit: Mocked<Logger> = mocks.get<Logger>('Logger')
  expect([service, concrete, asRepository, explicit]).toHaveLength(4)
})

it('createMock and createSpy are typed', () => {
  const repository = createMock(UserRepository)
  const find: MockFunction<(id: string) => Promise<User | undefined>> = repository.findById
  find.mockResolvedValueOnce(undefined)
  const logger = createMock<Logger>()
  logger.error.mockReturnValue(undefined)
  const deep: DeepMock = createMock()
  const spy = createSpy((a: number, b: number) => a + b)
  const sum: number = spy(1, 2)
  // @ts-expect-error arguments are typed
  spy('1', 2)
  const calls: [number, number][] = spy.mock.calls
  expect([deep, sum, calls]).toHaveLength(3)
})

it('override checks the value against the key', () => {
  const entry = override(UserRepository, createMock(UserRepository))
  // @ts-expect-error not a UserRepository
  override(UserRepository, 42)
  expect(entry).toHaveLength(2)
})
