import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bunDotenvFiles, bunLoadedDotenvFiles } from '../../src/loaders/bun.ts'
import { tempDir } from '../helpers.ts'
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

const dotenvFiles = {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal ${VAR} reference in a .env file
  '.env': 'ZN_A=base\nZN_HOST=db.internal\nZN_URL=postgres://${ZN_HOST}/app\n',
  '.env.local': 'ZN_A=local\n',
  '.env.development': 'ZN_A=mode\n',
}

describe('bunDotenvFiles', () => {
  it('lists the files Bun loads automatically', () => {
    expect(bunDotenvFiles(undefined)).toEqual(['.env', '.env.development', '.env.local', '.env.development.local'])
    expect(bunDotenvFiles('production')).toEqual(['.env', '.env.production', '.env.local', '.env.production.local'])
    expect(bunDotenvFiles('test')).toEqual(['.env', '.env.test', '.env.test.local'])
  })

  it('uses the development files for any other NODE_ENV, like Bun', () => {
    for (const nodeEnv of ['', 'staging', 'Production', 'prod']) {
      expect(bunDotenvFiles(nodeEnv)).toEqual(['.env', '.env.development', '.env.local', '.env.development.local'])
    }
  })
})

describe('bunLoadedDotenvFiles', () => {
  const loadedEnv = { NODE_ENV: 'development', ZN_A: 'local', ZN_HOST: 'db.internal' }

  it('finds the files Bun loaded into the environment', async () => {
    const cwd = await project(dotenvFiles)
    expect(bunLoadedDotenvFiles({ bun: true, cwd, env: loadedEnv, execArgv: [] })).toEqual([
      '.env',
      '.env.development',
      '.env.local',
    ])
  })

  it('looks for the development files when NODE_ENV is not production or test', async () => {
    const cwd = await project({ '.env.development': 'ZN_D=1\n', '.env.staging': 'ZN_S=1\n' })
    const env = { NODE_ENV: 'staging', ZN_D: '1', ZN_S: '1' }
    expect(bunLoadedDotenvFiles({ bun: true, cwd, env, execArgv: [] })).toEqual(['.env.development'])
  })

  it('finds nothing when not on Bun, without files or when the variables are not set', async () => {
    const cwd = await project(dotenvFiles)
    expect(bunLoadedDotenvFiles({ bun: false, cwd, env: loadedEnv, execArgv: [] })).toEqual([])
    expect(bunLoadedDotenvFiles({ bun: true, cwd: await project({}), env: loadedEnv, execArgv: [] })).toEqual([])
    // disabled in a way not detected (global bunfig): the variables are not there
    expect(bunLoadedDotenvFiles({ bun: true, cwd, env: { NODE_ENV: 'development' }, execArgv: [] })).toEqual([])
  })

  it('finds nothing when Bun automatic loading is disabled or replaced', async () => {
    const cwd = await project(dotenvFiles)
    for (const execArgv of [['--no-env-file'], ['--env-file=.env'], ['--env-file', '.env']]) {
      expect(bunLoadedDotenvFiles({ bun: true, cwd, env: loadedEnv, execArgv })).toEqual([])
    }
    const disabled = await project({ ...dotenvFiles, 'bunfig.toml': '# no .env\nenv = false # Znight\n\n[test]\n' })
    expect(bunLoadedDotenvFiles({ bun: true, cwd: disabled, env: loadedEnv, execArgv: [] })).toEqual([])
    const inTable = await project({ ...dotenvFiles, 'bunfig.toml': '[test]\nenv = false\n' })
    expect(bunLoadedDotenvFiles({ bun: true, cwd: inTable, env: loadedEnv, execArgv: [] })).toEqual([
      '.env',
      '.env.development',
      '.env.local',
    ])
  })
})

describe('env() on Bun with automatic .env loading', () => {
  const source = fileURLToPath(new URL('../../src/index.ts', import.meta.url))
  const script = (loaders: string) =>
    [
      `import { dotenv, env, loadConfigSource } from ${JSON.stringify(source)}`,
      `const source = await loadConfigSource([${loaders}])`,
      "console.log(JSON.stringify({ a: source.get('ZN_A') ?? null, url: source.get('ZN_URL') ?? null }))",
    ].join('\n')

  function run(cwd: string, file: string, flags: readonly string[] = []) {
    const result = spawnSync(process.execPath, ['--conditions=@znight/source', ...flags, join(cwd, file)], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'development' },
      timeout: 30_000,
    })
    expect(result.status).toBe(0)
    return { values: JSON.parse(result.stdout) as unknown, stderr: result.stderr }
  }

  it('warns that Bun loaded .env files into process.env', async () => {
    const cwd = await project({
      ...dotenvFiles,
      'default.ts': script('dotenv(), env()'),
      'env-only.ts': script('env()'),
      'explicit.ts': script('env({ env: process.env })'),
    })
    const warning =
      'ZnightWarning: Bun loaded .env, .env.development, .env.local into process.env before the application started'

    // Bun's precedence and expansion, not the documented ones: warned
    const loaded = run(cwd, 'default.ts')
    expect(loaded.values).toEqual({ a: 'local', url: 'postgres://db.internal/app' })
    expect(loaded.stderr).toContain(warning)
    expect(loaded.stderr).toContain('`env = false` in bunfig.toml, or `bun --no-env-file`')
    expect(run(cwd, 'env-only.ts').stderr).toContain(warning)

    // reading process.env as is on purpose: no warning
    expect(run(cwd, 'explicit.ts').stderr).toBe('')

    // Bun's loading disabled: dotenv() precedence, no expansion, no .env files without dotenv()
    expect(run(cwd, 'default.ts', ['--no-env-file'])).toEqual({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: not expanded, as documented
      values: { a: 'mode', url: 'postgres://${ZN_HOST}/app' },
      stderr: '',
    })
    expect(run(cwd, 'env-only.ts', ['--no-env-file'])).toEqual({ values: { a: null, url: null }, stderr: '' })
  }, 60_000)
})
