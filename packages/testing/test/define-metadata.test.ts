import { Container, ErrorCode, METADATA_VERSION, type ZnightError } from '@znight/core'

import { createMetadata, defineTestMetadata, testToken } from '../src/index.ts'
import { describe, expect, test as it } from 'bun:test'

class Clock {
  now(): number {
    return 42
  }
}
class Repository {
  constructor(readonly clock: Clock) {}
}
class Service {
  constructor(
    readonly repository: Repository,
    readonly clock: Clock,
  ) {}
}
abstract class Port {}
class Adapter extends Port {}

function caught(fn: () => unknown): ZnightError {
  try {
    fn()
  } catch (error) {
    return error as ZnightError
  }
  throw new Error('expected an error')
}

describe('createMetadata', () => {
  it('fills the version and a topological resolution order', () => {
    const metadata = createMetadata({
      'src/b.ts#B': { scope: 'singleton', deps: ['src/a.ts#A', { lazy: 'src/c.ts#C' }], factory: () => 'b' },
      'src/c.ts#C': { scope: 'singleton', deps: ['src/b.ts#B'], factory: () => 'c' },
      'src/a.ts#A': { scope: 'singleton', deps: [{ token: 'src/x.ts#X', optional: true }], factory: () => 'a' },
    })
    expect(metadata.version).toBe(METADATA_VERSION)
    expect(metadata.resolutionOrder).toEqual(['src/a.ts#A', 'src/b.ts#B', 'src/c.ts#C'])
    expect(metadata.aliases).toBeUndefined()
    expect(metadata.externals).toBeUndefined()
  })

  it('accepts aliases, externals (tokens or definitions), extensions and an explicit order', () => {
    const metadata = createMetadata(
      { 'src/a.ts#A': { scope: 'singleton', deps: [], factory: () => 'a' } },
      {
        aliases: { 'src/port.ts#Port': 'src/a.ts#A' },
        externals: ['@acme/x#X', { token: '@acme/y#Y', scope: 'request', providedBy: 'YPlugin' }],
        extensions: { custom: { enabled: true } },
        resolutionOrder: ['src/a.ts#A'],
      },
    )
    expect(metadata.aliases).toEqual({ 'src/port.ts#Port': 'src/a.ts#A' })
    expect(metadata.externals).toEqual([
      { token: '@acme/x#X' },
      { token: '@acme/y#Y', scope: 'request', providedBy: 'YPlugin' },
    ])
    expect(metadata.extensions).toEqual({ custom: { enabled: true } })
  })

  it('keeps cycles for the container to report', async () => {
    const metadata = createMetadata({
      'src/a.ts#A': { scope: 'singleton', deps: ['src/b.ts#B'], factory: () => 'a' },
      'src/b.ts#B': { scope: 'singleton', deps: ['src/a.ts#A'], factory: () => 'b' },
    })
    expect(metadata.resolutionOrder).toHaveLength(2)
    const error = await Container.create(metadata)
      .init()
      .then(
        () => undefined,
        (reason: unknown) => reason as ZnightError,
      )
    expect(error?.code).toBe(ErrorCode.CircularDependency)
  })

  it('rejects malformed definitions', () => {
    expect(caught(() => createMetadata({ 'src/a.ts#A': { scope: 'singleton' } as never })).code).toBe(
      ErrorCode.InvalidDecorator,
    )
    expect(() => createMetadata(null as never)).toThrow(TypeError)
  })
})

describe('defineTestMetadata', () => {
  it('derives tokens from class names and dependencies from classes', async () => {
    const metadata = defineTestMetadata({ providers: [Clock, { class: Repository, deps: [Clock] }] })
    expect(Object.keys(metadata.providers)).toEqual(['test#Clock', 'test#Repository'])
    expect(metadata.providers['test#Repository']?.deps).toEqual(['test#Clock'])
    expect(metadata.providers['test#Clock']?.class).toBe(Clock)
    expect(metadata.resolutionOrder).toEqual(['test#Clock', 'test#Repository'])
    const container = Container.create(metadata)
    await container.init()
    expect(container.get(Repository).clock).toBe(container.get(Clock))
  })

  it('supports explicit tokens, factories, prefixes and every dependency kind', () => {
    const metadata = defineTestMetadata({
      tokenPrefix: 'src/app.ts',
      providers: [
        { class: Clock, token: 'src/clock.ts#Clock' },
        {
          class: Service,
          deps: [{ lazy: Repository }, { token: Clock, optional: true }],
          scope: 'transient',
          name: 'service',
          primary: true,
          dispose: 'close',
          source: { file: 'src/service.ts', line: 1, column: 1 },
          interceptors: { run: { async: false, chain: [] } },
        },
        {
          token: 'src/url.ts#Url',
          factory: () => 'postgres://',
          name: 'url',
          deps: [{ multi: [Clock, 'src/x.ts#X'] }],
        },
        { token: 'src/pool.ts#Pool', factory: () => Promise.resolve({}), async: true },
      ],
    })
    expect(Object.keys(metadata.providers)).toEqual([
      'src/clock.ts#Clock',
      'src/app.ts#Service',
      'src/url.ts#Url',
      'src/pool.ts#Pool',
    ])
    const service = metadata.providers['src/app.ts#Service']
    expect(service?.deps).toEqual([{ lazy: 'src/app.ts#Repository' }, { token: 'src/clock.ts#Clock', optional: true }])
    expect(service).toMatchObject({ scope: 'transient', name: 'service', primary: true, dispose: 'close' })
    expect(metadata.providers['src/url.ts#Url']?.deps).toEqual([{ multi: ['src/clock.ts#Clock', 'src/x.ts#X'] }])
    expect(metadata.providers['src/url.ts#Url']?.class).toBeUndefined()
    expect(metadata.providers['src/pool.ts#Pool']?.async).toBe(true)
  })

  it('the default factory constructs the class with the dependencies', () => {
    const metadata = defineTestMetadata({ providers: [{ class: Service, deps: [Repository, Clock] }] })
    const clock = new Clock()
    const repository = new Repository(clock)
    const service = metadata.providers['test#Service']?.factory([repository, clock]) as Service
    expect(service).toBeInstanceOf(Service)
    expect(service.repository).toBe(repository)
  })

  it('aliases accept pairs of classes or records of tokens', async () => {
    const fromPairs = defineTestMetadata({ providers: [Adapter], aliases: [[Port, Adapter]] })
    expect(fromPairs.aliases).toEqual({ 'test#Port': 'test#Adapter' })
    const fromRecord = defineTestMetadata({ providers: [Adapter], aliases: { 'src/port.ts#Port': Adapter } })
    expect(fromRecord.aliases).toEqual({ 'src/port.ts#Port': 'test#Adapter' })
    const container = Container.create(fromPairs)
    await container.init()
    expect(container.get(Port)).toBeInstanceOf(Adapter)
  })

  it('passes externals, extensions and an explicit order through', () => {
    const metadata = defineTestMetadata({
      providers: [Clock],
      externals: ['@acme/x#X'],
      extensions: { http: { controllers: [] } },
      resolutionOrder: ['test#Clock'],
    })
    expect(metadata.externals).toEqual([{ token: '@acme/x#X' }])
    expect(metadata.extensions).toEqual({ http: { controllers: [] } })
  })

  it('an empty spec is valid metadata', () => {
    expect(defineTestMetadata()).toEqual({ version: METADATA_VERSION, providers: {}, resolutionOrder: [] })
  })

  it('rejects duplicates, providers without class nor token, and invalid dependencies', () => {
    expect(caught(() => defineTestMetadata({ providers: [Clock, Clock] })).code).toBe(ErrorCode.DuplicateProvider)
    expect(() => defineTestMetadata({ providers: [{ deps: [] }] })).toThrow('needs a class or a token')
    expect(() => defineTestMetadata({ providers: [{ token: 'src/x.ts#X' }] })).toThrow('needs a class or a factory')
    expect(() => defineTestMetadata({ providers: [{ class: Clock, deps: [42 as never] }] })).toThrow(
      'invalid dependency',
    )
    expect(() => defineTestMetadata({ providers: [null as never] })).toThrow(TypeError)
  })
})

describe('testToken', () => {
  it('builds <prefix>#<ClassName>', () => {
    expect(testToken(Clock)).toBe('test#Clock')
    expect(testToken(Clock, 'src/clock.ts')).toBe('src/clock.ts#Clock')
  })

  it('rejects anonymous classes', () => {
    expect(() => testToken((() => class {})())).toThrow(TypeError)
  })
})
