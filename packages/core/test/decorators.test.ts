import {
  Factory,
  Inject,
  Injectable,
  Intercept,
  type MethodInterceptor,
  type MethodInvocation,
  Named,
  Optional,
  Primary,
  Provides,
} from '../src/index.ts'
import { describe, expect, it } from 'bun:test'

class LogInterceptor implements MethodInterceptor<{ level: 'debug' | 'info' }> {
  intercept(invocation: MethodInvocation, _options: { level: 'debug' | 'info' }): unknown {
    return invocation.proceed()
  }
}

class OptionalOptionsInterceptor implements MethodInterceptor<{ label?: string } | undefined> {
  intercept(invocation: MethodInvocation): unknown {
    return invocation.proceed()
  }
}

class Database {
  readonly url = 'memory://'
}

@Injectable({ scope: 'request', name: 'users', primary: true })
@Named('users')
@Primary()
class UserService {
  readonly db: Database
  readonly label: string | undefined

  constructor(db: Database, @Inject('label') @Optional() label?: string) {
    this.db = db
    this.label = label
  }

  @Intercept(LogInterceptor, { level: 'debug' })
  @Intercept(OptionalOptionsInterceptor)
  find(@Inject('id') id: string): string {
    return `${this.db.url}${id}`
  }

  static create(): UserService {
    return new UserService(new Database())
  }
}

@Factory()
class DbFactory {
  @Provides({ scope: 'singleton', name: 'main', primary: true, dispose: 'close' })
  @Named('main')
  @Primary()
  createDatabase(@Inject('url') @Optional() _url?: string): Database {
    return new Database()
  }
}

describe('marker decorators', () => {
  it('leave decorated classes, methods and parameters untouched', () => {
    const service = new UserService(new Database(), 'x')
    expect(service.find('42')).toBe('memory://42')
    expect(service.label).toBe('x')
    expect(UserService.create()).toBeInstanceOf(UserService)
    expect(new DbFactory().createDatabase()).toBeInstanceOf(Database)
    expect(Object.getOwnPropertyNames(UserService.prototype).sort()).toEqual(['constructor', 'find'])
    expect(Object.getOwnPropertyNames(service).sort()).toEqual(['db', 'label'])
  })

  it('return one shared no-op function per position (no allocation)', () => {
    expect(Injectable()).toBe(Injectable({ scope: 'transient' }))
    expect(Injectable()).toBe(Factory())
    expect(Provides()).toBe(Intercept(LogInterceptor, { level: 'info' }))
    expect(Inject('a')).toBe(Optional())
    expect(Named('a')).toBe(Primary())
  })

  it('return undefined when applied, so the class/descriptor is kept as is', () => {
    const decorator = Injectable() as (...args: unknown[]) => unknown
    expect(decorator(UserService)).toBeUndefined()
    const descriptor = Object.getOwnPropertyDescriptor(UserService.prototype, 'find')
    expect((Provides() as (...args: unknown[]) => unknown)(UserService.prototype, 'find', descriptor)).toBeUndefined()
    expect((Inject('x') as (...args: unknown[]) => unknown)(UserService, undefined, 0)).toBeUndefined()
  })

  it('type options precisely', () => {
    // @ts-expect-error unknown scope
    Injectable({ scope: 'session' })
    // @ts-expect-error interceptor options are required when they do not accept undefined
    Intercept(LogInterceptor)
    // @ts-expect-error wrong interceptor options
    Intercept(LogInterceptor, { level: 'trace' })
    Intercept(OptionalOptionsInterceptor)
    Intercept(OptionalOptionsInterceptor, { label: 'x' })
    // @ts-expect-error qualifiers are strings
    Inject(42)
    expect(true).toBe(true)
  })
})
