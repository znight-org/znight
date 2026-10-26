import type { ConfigSource } from '../src/index.ts'

import { inspect } from 'node:util'

import { createConfigSource, envSource } from '../src/index.ts'
import { lookupPath, nestUnder, sourceEntry } from '../src/source.ts'
import { describe, expect, it } from 'bun:test'

describe('lookupPath', () => {
  const values = {
    DB_HOST: 'flat',
    'flat.dotted': 1,
    database: { host: 'nested', replicas: ['a', 'b'], pool: { max: 10 } },
    'mixed.part': { leaf: true },
    mixed: { part: { leaf: false, other: 'x' } },
    empty: null,
  }

  it('finds own properties first', () => {
    expect(lookupPath(values, 'DB_HOST')).toBe('flat')
    expect(lookupPath(values, 'flat.dotted')).toBe(1)
  })

  it('walks nested objects', () => {
    expect(lookupPath(values, 'database.host')).toBe('nested')
    expect(lookupPath(values, 'database.pool.max')).toBe(10)
    expect(lookupPath(values, 'database.replicas')).toEqual(['a', 'b'])
    expect(lookupPath(values, 'database')).toBe(values.database)
  })

  it('prefers the longest dotted segment, then falls back to shorter ones', () => {
    expect(lookupPath(values, 'mixed.part.leaf')).toBe(true)
    expect(lookupPath(values, 'mixed.part.other')).toBe('x')
  })

  it('returns undefined for unknown paths and never walks into arrays or primitives', () => {
    expect(lookupPath(values, 'missing')).toBeUndefined()
    expect(lookupPath(values, 'database.missing')).toBeUndefined()
    expect(lookupPath(values, 'database.host.length')).toBeUndefined()
    expect(lookupPath(values, 'database.replicas.0')).toBeUndefined()
    expect(lookupPath(values, 'empty.x')).toBeUndefined()
  })

  it('ignores inherited properties', () => {
    expect(lookupPath(values, 'toString')).toBeUndefined()
    expect(lookupPath(values, 'database.constructor')).toBeUndefined()
    expect(lookupPath(values, '__proto__')).toBeUndefined()
  })
})

describe('nestUnder', () => {
  it('mounts values under a key path', () => {
    expect(nestUnder({ host: 'x' }, 'database')).toEqual({ database: { host: 'x' } })
    expect(nestUnder('plain', 'TOKEN')).toEqual({ TOKEN: 'plain' })
    expect(nestUnder({ a: 1 }, undefined)).toEqual({ a: 1 })
    expect(nestUnder('not an object', undefined)).toEqual({})
  })
})

describe('createConfigSource', () => {
  const source = createConfigSource([
    { origin: 'defaults', values: { PORT: '3000', HOST: 'localhost', database: { host: 'file-host', port: 5432 } } },
    { origin: '.env', values: { PORT: '4000', EMPTY: '', NULLED: 'base' } },
    { origin: 'process.env', values: { PORT: '5000', NULLED: null, UNDEF: undefined } },
  ])

  it('reads the value of the last layer defining a key', () => {
    expect(source.get('PORT')).toBe('5000')
    expect(source.origin('PORT')).toBe('process.env')
    expect(source.get('HOST')).toBe('localhost')
    expect(source.origin('HOST')).toBe('defaults')
    expect(source.get('database.port')).toBe(5432)
  })

  it('treats null and undefined as not defined (falls back to earlier layers)', () => {
    expect(source.get('NULLED')).toBe('base')
    expect(source.origin('NULLED')).toBe('.env')
    expect(source.has('UNDEF')).toBe(false)
  })

  it('keeps empty strings', () => {
    expect(source.has('EMPTY')).toBe(true)
    expect(source.get('EMPTY')).toBe('')
  })

  it('reports absent keys', () => {
    expect(source.get('NOPE')).toBeUndefined()
    expect(source.has('NOPE')).toBe(false)
    expect(source.origin('NOPE')).toBeUndefined()
  })

  it('lists keys without duplicates, including nested paths', () => {
    expect(source.keys()).toEqual(['PORT', 'HOST', 'database', 'database.host', 'database.port', 'EMPTY', 'NULLED'])
  })

  it('describes its layers', () => {
    expect(source.describe?.()).toBe('defaults < .env < process.env')
    expect(createConfigSource([]).describe?.()).toBe('no configuration source')
  })

  it('never exposes values when printed or serialised', () => {
    const secret = createConfigSource([{ origin: 'vault:secret/app', values: { DB_PASSWORD: 'hunter2' } }])
    expect(inspect(secret)).not.toContain('hunter2')
    expect(inspect(secret)).toContain('vault:secret/app')
    expect(JSON.stringify(secret)).toBe('{"origins":["vault:secret/app"],"keys":1}')
    expect(String(secret)).toBe('ConfigSource(vault:secret/app)')
    expect(Bun.inspect(secret)).not.toContain('hunter2')
  })

  it('copies the layer list', () => {
    const layers = [{ origin: 'a', values: { A: '1' } }]
    const copy = createConfigSource(layers)
    layers.push({ origin: 'b', values: { A: '2' } })
    expect(copy.get('A')).toBe('1')
  })
})

describe('envSource', () => {
  it('snapshots defined variables', () => {
    const env: Record<string, string | undefined> = { A: '1', B: undefined }
    const source = envSource(env)
    env.A = '2'
    expect(source.get('A')).toBe('1')
    expect(source.has('B')).toBe(false)
    expect(source.origin('A')).toBe('process.env')
  })

  it('defaults to process.env', () => {
    process.env.ZNIGHT_CONFIG_SOURCE_TEST = 'yes'
    try {
      expect(envSource().get('ZNIGHT_CONFIG_SOURCE_TEST')).toBe('yes')
    } finally {
      delete process.env.ZNIGHT_CONFIG_SOURCE_TEST
    }
  })
})

describe('sourceEntry', () => {
  it('supports custom ConfigSource implementations', () => {
    const custom: ConfigSource = {
      get: key => (({ A: 'a', N: null }) as Record<string, unknown>)[key],
      has: key => key === 'A',
      keys: () => ['A'],
      origin: key => (key === 'A' ? 'custom' : undefined),
    }
    expect(sourceEntry(custom, 'A')).toEqual({ value: 'a', origin: 'custom' })
    expect(sourceEntry(custom, 'N')).toBeUndefined()
    expect(sourceEntry(custom, 'B')).toBeUndefined()
    const anonymous: ConfigSource = { ...custom, origin: () => undefined }
    expect(sourceEntry(anonymous, 'A')).toEqual({ value: 'a', origin: 'config source' })
  })
})
