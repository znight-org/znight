import type { ConfigLoader } from '../../src/index.ts'

import { ErrorCode, ZnightError } from '@znight/core'

import { ConfigLoaderError, env, inline, loadConfigSource } from '../../src/index.ts'
import { caught } from '../helpers.ts'
import { describe, expect, it } from 'bun:test'

describe('env()', () => {
  it('snapshots the context environment', async () => {
    const variables: Record<string, string | undefined> = { PORT: '3000', UNSET: undefined }
    const source = await loadConfigSource([env()], { env: variables })
    variables['PORT'] = '4000'
    expect(source.get('PORT')).toBe('3000')
    expect(source.has('UNSET')).toBe(false)
    expect(source.origin('PORT')).toBe('process.env')
  })

  it('reads process.env by default', async () => {
    process.env['ZNIGHT_ENV_LOADER_TEST'] = 'from-process'
    try {
      const source = await loadConfigSource([env()])
      expect(source.get('ZNIGHT_ENV_LOADER_TEST')).toBe('from-process')
    } finally {
      delete process.env['ZNIGHT_ENV_LOADER_TEST']
    }
  })

  it('filters and strips a prefix', async () => {
    const source = await loadConfigSource([env({ prefix: 'APP_' })], {
      env: { APP_DB_HOST: 'db', DB_HOST: 'ignored', APP_: 'empty name', OTHER: 'x' },
    })
    expect(source.get('DB_HOST')).toBe('db')
    expect(source.keys()).toEqual(['DB_HOST'])
    expect(source.origin('DB_HOST')).toBe('process.env (prefix APP_)')
  })

  it('can keep the prefix', async () => {
    const source = await loadConfigSource([env({ prefix: 'APP_', keepPrefix: true })], {
      env: { APP_PORT: '1', PORT: '2' },
    })
    expect(source.keys()).toEqual(['APP_PORT'])
  })

  it('can read explicit variables', async () => {
    const source = await loadConfigSource([env({ env: { A: '1' } })], { env: { A: 'context' } })
    expect(source.get('A')).toBe('1')
    expect(source.origin('A')).toBe('environment')
  })

  it('rejects an invalid prefix', async () => {
    const error = await caught(() => env({ prefix: 1 as unknown as string }))
    expect((error as ZnightError).code).toBe(ErrorCode.InvalidConfig)
  })
})

describe('inline()', () => {
  it('provides fixed values with a custom origin', async () => {
    const source = await loadConfigSource([inline({ PORT: '1' }, { name: 'defaults' }), inline({ HOST: 'h' })], {
      env: {},
    })
    expect(source.get('PORT')).toBe('1')
    expect(source.origin('PORT')).toBe('defaults')
    expect(source.origin('HOST')).toBe('inline')
  })

  it('rejects non-object values', async () => {
    const error = await caught(() => inline([] as unknown as Record<string, unknown>))
    expect((error as ZnightError).code).toBe(ErrorCode.InvalidConfig)
  })
})

describe('loadConfigSource', () => {
  it('runs loaders in order: later loaders override earlier ones', async () => {
    const source = await loadConfigSource([inline({ A: '1', B: '1' }), inline({ B: '2' })], { env: {} })
    expect(source.get('A')).toBe('1')
    expect(source.get('B')).toBe('2')
    expect(source.describe?.()).toBe('inline < inline')
  })

  it('gives each loader the values loaded before it, the cwd and the environment', async () => {
    const seen: unknown[] = []
    const probe: ConfigLoader = {
      name: 'probe',
      load({ source, cwd, env: variables }) {
        seen.push(source.get('A'), cwd, variables['X'])
        return [
          { origin: 'probe-1', values: { B: 'b1' } },
          { origin: 'probe-2', values: { B: 'b2' } },
        ]
      },
    }
    const source = await loadConfigSource([inline({ A: 'a' }), probe], { cwd: '/srv/app', env: { X: 'x' } })
    expect(seen).toEqual(['a', '/srv/app', 'x'])
    expect(source.origin('B')).toBe('probe-2')
  })

  it('accepts loaders returning nothing', async () => {
    const empty: ConfigLoader = { name: 'empty', load: () => undefined }
    const source = await loadConfigSource([empty], { env: {} })
    expect(source.keys()).toEqual([])
  })

  it('defaults cwd to process.cwd()', async () => {
    let cwd: string | undefined
    await loadConfigSource([
      {
        name: 'cwd',
        load: context => {
          cwd = context.cwd
          return undefined
        },
      },
    ])
    expect(cwd).toBe(process.cwd())
  })

  it('wraps loader failures in ConfigLoaderError (ZNIGHT006) keeping the cause', async () => {
    const cause = new Error('boom')
    const failing: ConfigLoader = {
      name: 'consul',
      load: () => {
        throw cause
      },
    }
    const error = await caught(() => loadConfigSource([failing], { env: {} }))
    expect(error).toBeInstanceOf(ConfigLoaderError)
    expect(error.message).toBe('ZNIGHT006: Config loader "consul" failed: boom')
    expect((error as ConfigLoaderError).loader).toBe('consul')
    expect(error.cause).toBe(cause)

    const rejecting: ConfigLoader = { name: 'async', load: () => Promise.reject('text') }
    expect((await caught(() => loadConfigSource([rejecting], { env: {} }))).message).toContain('failed: text')
  })

  it('passes Znight errors through', async () => {
    const original = new ZnightError(ErrorCode.InvalidConfig, 'bad option')
    const error = await caught(() =>
      loadConfigSource([{ name: 'x', load: () => Promise.reject(original) }], { env: {} }),
    )
    expect(error).toBe(original)
  })

  it('rejects invalid loader results', async () => {
    for (const result of [{ values: {} }, { origin: 'x', values: [] }, { origin: 'x', values: null }, 'text']) {
      const loader = { name: 'bad', load: () => result } as unknown as ConfigLoader
      const error = await caught(() => loadConfigSource([loader], { env: {} }))
      expect(error).toBeInstanceOf(ConfigLoaderError)
      expect(error.message).toContain('load() must return')
    }
  })

  it('rejects invalid loaders with ZNIGHT012', async () => {
    for (const loaders of [{}, [{}], [{ name: 'x' }], [null]]) {
      const error = await caught(() => loadConfigSource(loaders as unknown as ConfigLoader[]))
      expect((error as ZnightError).code).toBe(ErrorCode.InvalidConfig)
    }
  })
})
