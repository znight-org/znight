import { inspect } from 'node:util'

import { loadConfig, SECRET_MASK } from '../src/index.ts'
import { field, source } from './helpers.ts'
import { describe, expect, it } from 'bun:test'

class DatabaseConfig {
  host!: string
  password!: string
  apiKey?: string
  url!: URL
}

const fields = [
  field('host'),
  field('password', 'string', { env: 'DB_PASSWORD', secret: true }),
  field('apiKey', 'string', { env: 'API_KEY', secret: true, required: false }),
  field('url', 'url', { secret: false }),
]

function load(values: Record<string, unknown> = {}): DatabaseConfig {
  return loadConfig(
    DatabaseConfig,
    source({ HOST: 'db.internal', DB_PASSWORD: 'hunter2', URL: 'postgres://db.internal/app', ...values }),
    fields,
  )
}

describe('secret masking', () => {
  it('keeps the real values on the properties', () => {
    const config = load()
    expect(config.password).toBe('hunter2')
    expect({ ...config }.password).toBe('hunter2')
  })

  it('masks JSON.stringify', () => {
    const config = load({ API_KEY: 'key-123' })
    const json = JSON.stringify(config)
    expect(json).not.toContain('hunter2')
    expect(json).not.toContain('key-123')
    expect(JSON.parse(json)).toEqual({
      host: 'db.internal',
      password: SECRET_MASK,
      apiKey: SECRET_MASK,
      url: 'postgres://db.internal/app',
    })
    expect(JSON.stringify({ nested: config })).not.toContain('hunter2')
  })

  it('leaves unset secrets visible as undefined', () => {
    const config = load()
    expect(JSON.parse(JSON.stringify(config))).not.toHaveProperty('apiKey')
    expect(inspect(config)).not.toContain(SECRET_MASK.repeat(2))
  })

  it('masks util.inspect, console output and Bun.inspect, with the class name', () => {
    const config = load()
    const printed = inspect(config)
    expect(printed).toStartWith('DatabaseConfig {')
    expect(printed).toContain(`password: '${SECRET_MASK}'`)
    expect(printed).toContain("host: 'db.internal'")
    expect(printed).not.toContain('hunter2')
    expect(inspect({ deep: { config } }, { depth: 5 })).not.toContain('hunter2')
    expect(inspect(config, { colors: true })).not.toContain('hunter2')
    expect(Bun.inspect(config)).not.toContain('hunter2')
    expect(Bun.inspect(config)).toContain(SECRET_MASK)
  })

  it('masks toString and template literals', () => {
    const config = load()
    expect(String(config)).toStartWith('DatabaseConfig {')
    expect(`${config}`).not.toContain('hunter2')
    expect(`${config}`).toContain(SECRET_MASK)
  })

  it('installs non-enumerable helpers only', () => {
    const config = load()
    expect(Object.keys(config)).toEqual(['host', 'password', 'apiKey', 'url'])
    expect(Object.getOwnPropertyDescriptor(config, 'toJSON')?.enumerable).toBe(false)
  })

  it('reflects later changes of the instance', () => {
    const config = load()
    config.host = 'changed'
    config.password = 'rotated'
    expect(JSON.stringify(config)).toContain('changed')
    expect(JSON.stringify(config)).not.toContain('rotated')
  })

  it('installs nothing when the class has no secret', () => {
    class Plain {
      host!: string
    }
    const config = loadConfig(Plain, source({ HOST: 'x' }), [field('host')])
    expect(Object.getOwnPropertyNames(config)).toEqual(['host'])
    expect(JSON.stringify(config)).toBe('{"host":"x"}')
  })

  it('keeps serialisation methods defined by the class', () => {
    class Custom {
      token!: string
      toJSON(): object {
        return { custom: true }
      }
      toString(): string {
        return 'custom'
      }
    }
    const config = loadConfig(Custom, source({ TOKEN: 'secret-token' }), [field('token', 'string', { secret: true })])
    expect(JSON.stringify(config)).toBe('{"custom":true}')
    expect(String(config)).toBe('custom')
    expect(inspect(config)).not.toContain('secret-token')
  })
})
