/**
 * `vite build --watch` with the `znight()` plugin: incremental recompiles on change / create /
 * delete (every rebuild comes from a changed file and recompiles once, the generated module never
 * triggers one, so nothing loops), compile errors replaced by the error module, recovery.
 */
import type { RecordingLogger } from './helpers.ts'

import fs from 'node:fs'
import path from 'node:path'
import { build } from 'vite'

import { DEFAULT_OUT_FILE } from '../../src/options.ts'
import { znight } from '../../src/vite.ts'
import { integrationApp, recordingLogger, report, run, sleep, viteConfig, waitFor } from './helpers.ts'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

const TIMEOUT = 30_000

/** Quiet period ending a change: no build finished during it, none running at its end. */
const SETTLE_MS = 700

interface WatchEvent {
  readonly code: string
  readonly error?: unknown
  readonly result?: { close(): unknown }
}

interface Watcher {
  on(event: 'event', listener: (event: WatchEvent) => void): unknown
  on(event: 'change', listener: (id: string) => void): unknown
  close(): Promise<void>
}

describe('vite build --watch', () => {
  const app = integrationApp('app')
  const logger: RecordingLogger = recordingLogger()
  let watcher: Watcher
  let builds = 0
  /** A build is running (START seen, END not yet): a quiet period ends with the watcher idle. */
  let building = false
  const errors: unknown[] = []
  /** Files the watcher reported, relative to the root: what triggered the rebuilds. */
  const changed: string[] = []
  const outFile = `${app.root}/${DEFAULT_OUT_FILE}`

  beforeAll(async () => {
    watcher = (await build(
      viteConfig(app.root, logger, { plugins: [znight()], build: { watch: {} } }),
    )) as unknown as Watcher
    watcher.on('event', event => {
      if (event.code === 'START') {
        building = true
      }
      if (event.code === 'END') {
        building = false
        builds++
      }
      if (event.code === 'ERROR') {
        building = false
        errors.push(event.error)
      }
      void event.result?.close()
    })
    const root = fs.realpathSync(app.root)
    watcher.on('change', id => {
      changed.push(path.relative(root, fs.existsSync(id) ? fs.realpathSync(id) : id))
    })
    await waitFor(() => builds === 1, 'the first build')
  }, TIMEOUT)

  afterAll(async () => {
    await watcher.close()
    app.cleanup()
  })

  /** Waits for a quiet period (no build finished, none running); a watcher rebuilding forever fails. */
  async function settle(): Promise<void> {
    for (let round = 0; round < 10; round++) {
      const count = builds
      await sleep(SETTLE_MS)
      if (builds === count && !building) return
    }
    throw new Error('the watcher keeps rebuilding')
  }

  /**
   * Applies a change to the `touched` files and waits for its rebuild, then for a quiet period.
   * Every rebuild comes from a touched file: the generated module (written by the compile) never
   * triggers one. A loaded machine may report one write as two events (a creation, then a
   * modification), hence the number of rebuilds it returns: one, sometimes two.
   */
  async function rebuild(touched: readonly string[], change: () => void): Promise<number> {
    const before = builds
    const seen = changed.length
    change()
    await waitFor(() => builds > before, 'a rebuild')
    await settle()
    const events = changed.slice(seen)
    expect(events.filter(file => !touched.includes(file))).toEqual([])
    expect(builds - before).toBeLessThanOrEqual(events.length)
    expect(errors).toEqual([])
    return builds - before
  }

  const summaries = (): number => logger.messages.filter(message => message.text.includes('[znight]')).length

  it(
    'rebuilds once per change, without rewriting an unchanged generated module',
    async () => {
      await settle()
      expect(builds).toBe(1)
      const written = fs.statSync(outFile).mtimeMs
      const rebuilds = await rebuild(['src/clock.ts'], () =>
        app.write('src/clock.ts', fs.readFileSync(`${app.root}/src/clock.ts`, 'utf8').replace('42', '43')),
      )
      expect(fs.statSync(outFile).mtimeMs).toBe(written)
      // one compile per build: the first one, then one per rebuild
      expect(summaries()).toBe(1 + rebuilds)
      expect(report((await run(['node', 'dist/main.js'], app.root)).stdout).greeting).toBe('Hello Ada @43')
    },
    TIMEOUT,
  )

  it(
    'picks up created and deleted providers',
    async () => {
      await rebuild(['src/extra.ts'], () =>
        app.write('src/extra.ts', "import { Injectable } from '@znight/core'\n@Injectable()\nexport class Extra {}\n"),
      )
      expect(fs.readFileSync(outFile, 'utf8')).toContain("['src/extra.ts#Extra']")
      expect(report((await run(['node', 'dist/main.js'], app.root)).stdout).providers).toContain('src/extra.ts#Extra')

      await rebuild(['src/extra.ts'], () => app.remove('src/extra.ts'))
      expect(fs.readFileSync(outFile, 'utf8')).not.toContain('Extra')
      expect(report((await run(['node', 'dist/main.js'], app.root)).stdout).providers).not.toContain(
        'src/extra.ts#Extra',
      )
    },
    TIMEOUT,
  )

  it(
    'bundles the error module on compile errors, keeps the last good disk copy, then recovers',
    async () => {
      const good = fs.readFileSync(outFile, 'utf8')
      await rebuild(['src/notifier.ts'], () =>
        app.write(
          'src/notifier.ts',
          "import { Injectable } from '@znight/core'\nexport interface Mailer {}\n@Injectable()\nexport class Notifier {\n  constructor(readonly mailer: Mailer) {}\n}\n",
        ),
      )
      expect(logger.text('error')).toContain("✗ ZNIGHT001: Missing provider for 'Mailer' required by Notifier")
      expect(fs.readFileSync(outFile, 'utf8')).toBe(good)
      const failed = await run(['node', 'dist/main.js'], app.root)
      expect(failed.code).toBe(1)
      expect(failed.stderr).toContain('ZNIGHT001: The Znight compilation failed')
      expect(failed.stderr).toContain(' --> src/notifier.ts:5:32')

      await rebuild(['src/notifier.ts'], () => app.remove('src/notifier.ts'))
      expect(report((await run(['node', 'dist/main.js'], app.root)).stdout).greeting).toBe('Hello Ada @43')
    },
    TIMEOUT,
  )

  it(
    'recompiles when tsconfig.json changes (module resolution input)',
    async () => {
      const compiles = summaries()
      const rebuilds = await rebuild(['tsconfig.json'], () =>
        app.write(
          'tsconfig.json',
          fs.readFileSync(`${app.root}/tsconfig.json`, 'utf8').replace('"strict": true', '"strict": false'),
        ),
      )
      expect(summaries()).toBe(compiles + rebuilds)
    },
    TIMEOUT,
  )

  it(
    'recompiles when a constant imported from outside the include globs changes',
    async () => {
      await rebuild(['shared/names.ts', 'src/named.ts'], () => {
        app.write('shared/names.ts', "export const NAME = 'alpha'\n")
        app.write(
          'src/named.ts',
          "import { Injectable } from '@znight/core'\nimport { NAME } from '../shared/names.ts'\n@Injectable({ name: NAME })\nexport class Named {}\n",
        )
      })
      expect(fs.readFileSync(outFile, 'utf8')).toContain("name: 'alpha'")
      const compiles = summaries()
      const rebuilds = await rebuild(['shared/names.ts'], () =>
        app.write('shared/names.ts', "export const NAME = 'beta'\n"),
      )
      expect(summaries()).toBe(compiles + rebuilds)
      expect(fs.readFileSync(outFile, 'utf8')).toContain("name: 'beta'")
      expect(fs.readFileSync(`${app.root}/dist/main.js`, 'utf8')).toContain('name: "beta"')
    },
    TIMEOUT,
  )

  it(
    'ignores the generated module (an external write triggers nothing)',
    async () => {
      const before = builds
      const seen = changed.length
      fs.appendFileSync(outFile, '\n// touched\n')
      await sleep(SETTLE_MS)
      expect(builds).toBe(before)
      expect(changed.slice(seen)).toEqual([])
    },
    TIMEOUT,
  )
})
