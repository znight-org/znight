import { ErrorCode, type ZnightError } from '@znight/core'

import { ConfigLoaderError, dotenv, dotenvFiles, env, json, loadConfigSource, yaml } from '../../src/index.ts'
import { importOptionalPeer } from '../../src/loaders/shared.ts'
import { caught, tempDir } from '../helpers.ts'
import { afterEach, describe, expect, it } from 'bun:test'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

async function project(files: Record<string, string>): Promise<string> {
  const { dir, cleanup } = await tempDir(files)
  cleanups.push(cleanup)
  return dir
}

describe('dotenvFiles', () => {
  it('follows the .env conventions', () => {
    expect(dotenvFiles(undefined)).toEqual(['.env', '.env.local'])
    expect(dotenvFiles('')).toEqual(['.env', '.env.local'])
    expect(dotenvFiles('production')).toEqual(['.env', '.env.local', '.env.production', '.env.production.local'])
    expect(dotenvFiles('test')).toEqual(['.env', '.env.test', '.env.test.local'])
  })
})

describe('dotenv()', () => {
  const files = {
    '.env':
      '# base\nPORT=3000\nHOST=localhost\nexport EXPORTED=yes\nQUOTED="two words"\nMULTI="line1\nline2"\nEMPTY=\n',
    '.env.local': 'HOST=local-host\n',
    '.env.production': 'PORT=80\nMODE=prod\n',
    '.env.production.local': 'MODE=prod-local\n',
    '.env.test': 'MODE=test\n',
  }

  it('loads the conventional files in precedence order, each one as a layer', async () => {
    const cwd = await project(files)
    const source = await loadConfigSource([dotenv()], { cwd, env: { NODE_ENV: 'production' } })
    expect(source.get('PORT')).toBe('80')
    expect(source.origin('PORT')).toBe('.env.production')
    expect(source.get('HOST')).toBe('local-host')
    expect(source.origin('HOST')).toBe('.env.local')
    expect(source.get('MODE')).toBe('prod-local')
    expect(source.get('EXPORTED')).toBe('yes')
    expect(source.get('QUOTED')).toBe('two words')
    expect(source.get('MULTI')).toBe('line1\nline2')
    expect(source.get('EMPTY')).toBe('')
    expect(source.describe?.()).toBe('.env < .env.local < .env.production < .env.production.local')
  })

  it('skips .env.local in test mode and missing conventional files', async () => {
    const cwd = await project(files)
    const source = await loadConfigSource([dotenv()], { cwd, env: { NODE_ENV: 'test' } })
    expect(source.get('HOST')).toBe('localhost')
    expect(source.get('MODE')).toBe('test')
    expect(source.describe?.()).toBe('.env < .env.test')
  })

  it('works without any file', async () => {
    const cwd = await project({})
    const source = await loadConfigSource([dotenv()], { cwd, env: {} })
    expect(source.keys()).toEqual([])
  })

  it('accepts an explicit mode', async () => {
    const cwd = await project(files)
    const source = await loadConfigSource([dotenv({ nodeEnv: 'production' })], { cwd, env: { NODE_ENV: 'test' } })
    expect(source.get('MODE')).toBe('prod-local')
  })

  it('loads explicit paths, required unless optional', async () => {
    const cwd = await project({ 'config/app.env': 'A=1\n', 'config/secret.env': 'A=2\nB=3\n' })
    const source = await loadConfigSource([dotenv({ path: ['config/app.env', `${cwd}/config/secret.env`] })], {
      cwd,
      env: {},
    })
    expect(source.get('A')).toBe('2')
    expect(source.get('B')).toBe('3')

    const error = await caught(() => loadConfigSource([dotenv({ path: 'missing.env' })], { cwd, env: {} }))
    expect(error).toBeInstanceOf(ConfigLoaderError)
    expect(error.message).toContain('Config loader "dotenv" failed: file not found:')
    expect(error.message).toContain('missing.env')

    const optional = await loadConfigSource([dotenv({ path: 'missing.env', optional: true })], { cwd, env: {} })
    expect(optional.keys()).toEqual([])
  })

  it('strips a UTF-8 BOM', async () => {
    const cwd = await project({ '.env': '﻿FIRST=1\n' })
    const source = await loadConfigSource([dotenv()], { cwd, env: {} })
    expect(source.get('FIRST')).toBe('1')
  })

  it('reports unreadable files', async () => {
    const cwd = await project({ '.env/nested': 'x' }) // .env is a directory
    const error = await caught(() => loadConfigSource([dotenv()], { cwd, env: {} }))
    expect(error).toBeInstanceOf(ConfigLoaderError)
    expect(error.message).toContain('cannot read .env')
  })

  it('leaves the environment untouched by default; env() loaded after wins', async () => {
    const cwd = await project(files)
    const variables: Record<string, string | undefined> = { PORT: '9999' }
    const source = await loadConfigSource([dotenv(), env()], { cwd, env: variables })
    expect(variables).toEqual({ PORT: '9999' })
    expect(source.get('PORT')).toBe('9999')
    expect(source.origin('PORT')).toBe('process.env')
    expect(source.get('HOST')).toBe('local-host')
  })

  it('populates missing variables (merged values of every file)', async () => {
    const cwd = await project(files)
    const variables: Record<string, string | undefined> = { PORT: '9999', NODE_ENV: 'production' }
    await loadConfigSource([dotenv({ populate: true })], { cwd, env: variables })
    expect(variables['PORT']).toBe('9999')
    expect(variables['HOST']).toBe('local-host')
    expect(variables['MODE']).toBe('prod-local')
  })

  it('overrides existing variables with override: true', async () => {
    const cwd = await project(files)
    const variables: Record<string, string | undefined> = { PORT: '9999' }
    const source = await loadConfigSource([dotenv({ override: true }), env()], { cwd, env: variables })
    expect(variables['PORT']).toBe('3000')
    expect(source.get('PORT')).toBe('3000')
  })

  it('rejects invalid paths', async () => {
    for (const path of ['', [''], [1]]) {
      const error = await caught(() => dotenv({ path: path as string }))
      expect((error as ZnightError).code).toBe(ErrorCode.InvalidConfig)
    }
  })
})

describe('json()', () => {
  it('loads nested and flat values', async () => {
    const cwd = await project({
      'config/app.json': JSON.stringify({
        database: { host: 'db', port: 5432, replicas: ['a', 'b'] },
        DB_PASSWORD: 'x',
      }),
    })
    const source = await loadConfigSource([json('config/app.json')], { cwd, env: {} })
    expect(source.get('database.host')).toBe('db')
    expect(source.get('database.port')).toBe(5432)
    expect(source.get('database.replicas')).toEqual(['a', 'b'])
    expect(source.get('DB_PASSWORD')).toBe('x')
    expect(source.origin('database.host')).toBe('config/app.json')
  })

  it('mounts the content under a key', async () => {
    const cwd = await project({ 'db.json': '{"host":"db"}', 'list.json': '[1,2]' })
    const source = await loadConfigSource([json('db.json', { key: 'database' }), json('list.json', { key: 'ports' })], {
      cwd,
      env: {},
    })
    expect(source.get('database.host')).toBe('db')
    expect(source.get('ports')).toEqual([1, 2])
  })

  it('requires the file unless optional', async () => {
    const cwd = await project({})
    const error = await caught(() => loadConfigSource([json('missing.json')], { cwd, env: {} }))
    expect(error).toBeInstanceOf(ConfigLoaderError)
    expect(error.message).toContain('Config loader "json" failed: file not found:')
    const source = await loadConfigSource([json('missing.json', { optional: true })], { cwd, env: {} })
    expect(source.keys()).toEqual([])
  })

  it('reports syntax errors and non-object roots', async () => {
    const cwd = await project({ 'bad.json': '{ nope', 'array.json': '[1]', 'null.json': 'null' })
    const syntax = await caught(() => loadConfigSource([json('bad.json')], { cwd, env: {} }))
    expect(syntax.message).toContain('Config loader "json" failed: invalid JSON in bad.json:')
    expect(syntax.cause).toBeInstanceOf(SyntaxError)
    const array = await caught(() => loadConfigSource([json('array.json')], { cwd, env: {} }))
    expect(array.message).toContain('array.json must contain an object at the root')
    const empty = await loadConfigSource([json('null.json')], { cwd, env: {} })
    expect(empty.keys()).toEqual([])
  })

  it('rejects an empty path', async () => {
    expect(((await caught(() => json(''))) as ZnightError).code).toBe(ErrorCode.InvalidConfig)
  })
})

describe('yaml()', () => {
  it('loads YAML files through the optional peer', async () => {
    const cwd = await project({
      'config.yaml': 'database:\n  host: db\n  port: 5432\n  tls: true\nfeatures:\n  - a\n  - b\nempty: ~\n',
      'empty.yaml': '',
    })
    const source = await loadConfigSource([yaml('config.yaml'), yaml('empty.yaml')], { cwd, env: {} })
    expect(source.get('database.host')).toBe('db')
    expect(source.get('database.port')).toBe(5432)
    expect(source.get('database.tls')).toBe(true)
    expect(source.get('features')).toEqual(['a', 'b'])
    expect(source.has('empty')).toBe(false)
    expect(source.origin('database.host')).toBe('config.yaml')
  })

  it('reports syntax errors', async () => {
    const cwd = await project({ 'bad.yaml': 'a: [1, 2\nb: c' })
    const error = await caught(() => loadConfigSource([yaml('bad.yaml')], { cwd, env: {} }))
    expect(error.message).toContain('Config loader "yaml" failed: invalid YAML in bad.yaml:')
  })
})

describe('importOptionalPeer', () => {
  it('explains how to install a missing peer dependency', async () => {
    const error = await caught(() => importOptionalPeer('znight-missing-peer-for-tests', 'yaml'))
    expect(error).toBeInstanceOf(ConfigLoaderError)
    expect(error.message).toBe(
      'ZNIGHT006: Config loader "yaml" failed: the optional peer dependency "znight-missing-peer-for-tests" is not installed',
    )
    expect((error as ConfigLoaderError).hints).toEqual([
      'Install it: bun add znight-missing-peer-for-tests (or npm install znight-missing-peer-for-tests)',
    ])
  })

  it('imports installed packages', async () => {
    const module = await importOptionalPeer<{ parse: (text: string) => unknown }>('yaml', 'yaml')
    expect(module.parse('a: 1')).toEqual({ a: 1 })
  })
})
