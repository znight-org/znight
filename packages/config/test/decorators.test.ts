import { Config, Default, Env, Key, Secret } from '../src/index.ts'
import { expect, it } from 'bun:test'

@Config('database')
class DatabaseConfig {
  @Env('DB_HOST')
  @Default('localhost')
  host!: string

  @Key('db.port')
  port = 5432

  @Secret('DB_PASSWORD')
  password!: string

  @Secret()
  apiKey?: string

  @Default(['a', 'b'])
  tags!: string[]

  @Default({ nested: { value: 1 } })
  options!: Record<string, unknown>
}

@Config()
class NoPrefix {
  @Default(null)
  value!: string | null
}

it('decorators are no-op markers', () => {
  const config = new DatabaseConfig()
  expect(config.port).toBe(5432)
  expect(config.host).toBeUndefined()
  expect(new NoPrefix().value).toBeUndefined()
})

it('every marker factory returns the same shared function', () => {
  expect(Config()).toBe(Config('x'))
  expect(Env('A')).toBe(Secret())
  expect(Default(1)).toBe(Key('a.b'))
  expect(Env('A')(undefined, 'name')).toBeUndefined()
})
