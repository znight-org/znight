import { clearMock, createMock, createSpy, isBuiltinSpy, isMock, resetMock } from '../src/index.ts'
import { Database, type Logger, PgUserRepository, type User, UserRepository } from './support/app.ts'
import { describe, expect, test as it, mock } from 'bun:test'

describe('createMock', () => {
  it('every property is a stable spy usable with bun:test matchers', () => {
    const logger = createMock<Logger>()
    expect(logger.info).toBe(logger.info)
    logger.info('hello', { id: 1 })
    expect(logger.info).toHaveBeenCalledWith('hello', { id: 1 })
    expect(logger.info).toHaveBeenCalledTimes(1)
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('unconfigured methods return undefined', () => {
    const repository = createMock<UserRepository>()
    expect(repository.findById('1')).toBeUndefined()
  })

  it('spies can be programmed', async () => {
    const repository = createMock<UserRepository>()
    repository.findById.mockResolvedValueOnce({ id: '1', name: 'Ada' })
    expect(await repository.findById('1')).toEqual({ id: '1', name: 'Ada' })
    expect(await repository.findById('2')).toBeUndefined()
  })

  it('spies are named after the mock and the member', () => {
    const repository = createMock(UserRepository)
    expect(repository.findById.getMockName()).toBe('UserRepository.findById')
    const named = createMock<Logger>(undefined, { name: 'Logger' })
    expect(named.info.getMockName()).toBe('Logger.info')
    expect(createMock<Logger>().info.getMockName()).toBe('mock.info')
  })

  it('is deep: properties of spies are spies', () => {
    const client = createMock<{ pool: { query(sql: string): unknown } }>()
    client.pool.query.mockReturnValue(['row'])
    expect(client.pool.query('select')).toEqual(['row'])
    expect(client.pool.query).toHaveBeenCalledWith('select')
    expect(client.pool).not.toHaveBeenCalled()
  })

  it('untyped mocks are deep mocks', () => {
    const anything = createMock()
    anything['a']?.['b']?.['c']?.(1)
    expect(anything['a']?.['b']?.['c']).toHaveBeenCalledWith(1)
  })

  it('{ deep: true } makes unconfigured methods return the same deep mock', () => {
    interface Query {
      where(clause: string): Query
      orderBy(column: string): Query
      run(): Promise<unknown[]>
    }
    const db = createMock<{ select(table: string): Query }>(undefined, { deep: true })
    const query = db.select('users')
    expect(isMock(query)).toBe(true)
    expect(db.select('other')).toBe(query)
    query.where('id = 1').orderBy('name')
    expect(query.where).toHaveBeenCalledWith('id = 1')
    expect(query.where('x').orderBy).toHaveBeenCalledWith('name')
    db.select.mockReturnValueOnce('configured' as never)
    expect(db.select('users') as unknown).toBe('configured')
  })

  it('is not thenable: awaiting a mock (or a deep return) yields the mock itself', async () => {
    const repository = createMock<UserRepository>()
    expect(await repository).toBe(repository)
    expect(await Promise.resolve(repository)).toBe(repository)
    const deep = createMock<{ load(): object }>(undefined, { deep: true })
    const loaded = deep.load()
    expect(await loaded).toBe(loaded)
    expect((repository.findById as unknown as { then?: unknown }).then).toBeUndefined()
  })

  it('reserved names read as undefined', () => {
    const value = createMock() as unknown as Record<string, unknown>
    for (const key of [
      'then',
      'toJSON',
      'asymmetricMatch',
      '$$typeof',
      'nodeType',
      'tagName',
      '__esModule',
      '_isMockFunction',
      '@@__IMMUTABLE_ITERABLE__@@',
    ]) {
      expect(value[key]).toBeUndefined()
    }
  })

  it('symbols read as undefined unless assigned', () => {
    const value = createMock() as unknown as Record<symbol, unknown>
    expect(value[Symbol.toPrimitive]).toBeUndefined()
    expect(value[Symbol.iterator]).toBeUndefined()
    expect(value[Symbol.asyncDispose]).toBeUndefined()
    const dispose = (): void => undefined
    value[Symbol.asyncDispose] = dispose
    expect(value[Symbol.asyncDispose]).toBe(dispose)
  })

  it('is inert for serialisers and string conversions', () => {
    const value = createMock<Logger>()
    value.info('x')
    expect(JSON.stringify(value)).toBe('{}')
    expect(String(value)).toBe('[object Object]')
    expect(`${value}`).toBe('[object Object]')
    expect(Object.keys(value)).toEqual([])
    expect(Object.hasOwn(value, 'info')).toBe(false)
  })

  it('works with equality matchers', () => {
    const a = createMock<Logger>()
    const spy = mock()
    spy(a)
    expect(spy).toHaveBeenCalledWith(a)
    expect(spy).toHaveBeenCalledWith(expect.anything())
    expect([a]).toContain(a)
    expect({ logger: a }).toEqual({ logger: a })
  })

  it('assigned properties win and can be deleted', () => {
    const config = createMock<{ enabled: boolean; check(): boolean }>()
    expect(typeof config.enabled).toBe('function')
    config.enabled = false
    expect(config.enabled).toBe(false)
    expect(Object.keys(config)).toEqual(['enabled'])
    const replacement = (): boolean => true
    config.check = replacement as never
    expect(config.check).toBe(replacement as never)
    delete (config as { enabled?: boolean }).enabled
    expect(typeof config.enabled).toBe('function')
  })

  it('with a class: instanceof, constructor, getters undefined, methods spied', () => {
    const repository = createMock(PgUserRepository)
    expect(repository).toBeInstanceOf(PgUserRepository)
    expect(repository).toBeInstanceOf(UserRepository)
    expect(repository.constructor).toBe(PgUserRepository)
    expect(repository.table).toBeUndefined()
    expect(repository.findById('1')).toBeUndefined()
    expect(repository.findById).toHaveBeenCalledWith('1')
    expect(isMock(repository.save)).toBe(true)
  })

  it('with a class: data fields are spies (unknown at runtime)', () => {
    const database = createMock(Database)
    expect(typeof database.connected).toBe('function')
    ;(database as { connected: unknown }).connected = false
    expect(database.connected as unknown).toBe(false)
  })

  it('partial implementations: functions become spies, values are set', async () => {
    const user: User = { id: '1', name: 'Ada' }
    const repository = createMock(UserRepository, { findById: async (id: string) => ({ ...user, id }) })
    expect(await repository.findById('2')).toEqual({ id: '2', name: 'Ada' })
    expect(repository.findById).toHaveBeenCalledWith('2')
    const settings = createMock<{ retries: number; label(): string }>({ retries: 3, label: () => 'x' })
    expect(settings.retries).toBe(3)
    expect(settings.label()).toBe('x')
    expect(settings.label).toHaveBeenCalledTimes(1)
  })

  it('partial implementations keyed by symbols are set as is', () => {
    const dispose = (): void => undefined
    const disposable = createMock<{ [Symbol.dispose](): void }>({ [Symbol.dispose]: dispose })
    expect(disposable[Symbol.dispose] as unknown).toBe(dispose)
  })

  it('rejects a non-object partial implementation', () => {
    expect(() => createMock('nope' as never)).toThrow(TypeError)
  })

  it('the mockFn option selects the spy implementation', () => {
    const builtin = createMock<Logger>(undefined, { mockFn: 'builtin' })
    expect(isBuiltinSpy(builtin.info)).toBe(true)
    const factory = mock((implementation?: unknown) => createSpy(implementation as never))
    const custom = createMock<Logger>(undefined, { mockFn: factory })
    custom.info('x')
    expect(factory).toHaveBeenCalledTimes(1)
    expect(isBuiltinSpy(custom.info)).toBe(true)
  })

  it('the built-in spy is deep too', () => {
    const client = createMock<{ pool: { query(): number } }>(undefined, { mockFn: 'builtin' })
    client.pool.query.mockReturnValue(1)
    expect(client.pool.query()).toBe(1)
    expect(client.pool.query.mock.calls).toEqual([[]])
  })

  it('fails clearly when mockFn does not return a function', () => {
    const value = createMock<Logger>(undefined, { mockFn: () => ({}) })
    expect(() => value.info).toThrow('instead of a function')
  })

  it('a frozen spy keeps working without deep members', () => {
    const value = createMock<Logger>(undefined, {
      mockFn: implementation => Object.freeze(createSpy(implementation as never)),
    })
    value.info('x')
    expect(value.info.mock.calls).toEqual([['x']])
  })
})

describe('isMock / clearMock / resetMock', () => {
  it('isMock recognises mocks and their spies', () => {
    const value = createMock<Logger>()
    expect(isMock(value)).toBe(true)
    expect(isMock(value.info)).toBe(true)
    expect(isMock({})).toBe(false)
    expect(isMock(null)).toBe(false)
    expect(isMock(mock())).toBe(false)
  })

  it('clearMock forgets the calls of every spy, keeping implementations', () => {
    const value = createMock<{ a(): number; nested: { b(): number } }>()
    value.a.mockReturnValue(1)
    value.a()
    value.nested.b()
    clearMock(value)
    expect(value.a).not.toHaveBeenCalled()
    expect(value.nested.b).not.toHaveBeenCalled()
    expect(value.a()).toBe(1)
  })

  it('resetMock restores the initial state, including partial implementations and deep returns', () => {
    const value = createMock<{ a(): number; b(): number; c(): object }>({ b: () => 2 }, { deep: true })
    const deep = value.c()
    value.a.mockReturnValue(1)
    value.b.mockReturnValue(20)
    value.a()
    resetMock(value)
    expect(value.a).not.toHaveBeenCalled()
    expect(isMock(value.a())).toBe(true)
    expect(value.b()).toBe(2)
    expect(value.c()).toBe(deep)
  })

  it('reject values that are not mocks', () => {
    expect(() => clearMock({})).toThrow(TypeError)
    expect(() => resetMock(mock())).toThrow(TypeError)
  })
})
