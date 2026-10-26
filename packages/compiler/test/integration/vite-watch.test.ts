/**
 * `vite build --watch` with the `znight()` plugin: incremental recompiles on change / create /
 * delete (exactly one rebuild per change, the generated module never triggers one), compile errors
 * replaced by the error module, recovery.
 */
import type { RecordingLogger } from './helpers.ts'

import fs from 'node:fs'
import { build } from 'vite'

import { DEFAULT_OUT_FILE } from '../../src/options.ts'
import { znight } from '../../src/vite.ts'
import { integrationApp, recordingLogger, report, run, sleep, viteConfig, waitFor } from './helpers.ts'
import { afterAll, beforeAll, describe, expect, test as it } from 'bun:test'

const TIMEOUT = 30_000

/** Quiet period after a rebuild: no other rebuild may start (no loop). */
const SETTLE_MS = 700

interface WatchEvent {
  readonly code: string
  readonly error?: unknown
  readonly result?: { close(): unknown }
}

interface Watcher {
  on(event: 'event', listener: (event: WatchEvent) => void): unknown
  close(): Promise<void>
}

describe('vite build --watch', () => {
  const app = integrationApp('app')
  const logger: RecordingLogger = recordingLogger()
  let watcher: Watcher
  let builds = 0
  const errors: unknown[] = []
  const outFile = `${app.root}/${DEFAULT_OUT_FILE}`

  beforeAll(async () => {
    watcher = (await build(
      viteConfig(app.root, logger, { plugins: [znight()], build: { watch: {} } }),
    )) as unknown as Watcher
    watcher.on('event', event => {
      if (event.code === 'END') {
        builds++
      }
      if (event.code === 'ERROR') {
        errors.push(event.error)
      }
      void event.result?.close()
    })
    await waitFor(() => builds === 1, 'the first build')
  }, TIMEOUT)

  afterAll(async () => {
    await watcher.close()
    app.cleanup()
  })

  /** Applies a change and waits for its rebuild, then checks that no other rebuild follows. */
  async function rebuild(change: () => void): Promise<void> {
    const before = builds
    change()
    await waitFor(() => builds > before, 'a rebuild')
    await sleep(SETTLE_MS)
    expect(builds).toBe(before + 1)
    expect(errors).toEqual([])
  }

  const summaries = (): number => logger.messages.filter(message => message.text.includes('[znight]')).length

  it(
    'rebuilds once per change, without rewriting an unchanged generated module',
    async () => {
      await sleep(SETTLE_MS)
      expect(builds).toBe(1)
      const written = fs.statSync(outFile).mtimeMs
      await rebuild(() =>
        app.write('src/clock.ts', fs.readFileSync(`${app.root}/src/clock.ts`, 'utf8').replace('42', '43')),
      )
      expect(fs.statSync(outFile).mtimeMs).toBe(written)
      expect(summaries()).toBe(2)
      expect(report((await run(['node', 'dist/main.js'], app.root)).stdout).greeting).toBe('Hello Ada @43')
    },
    TIMEOUT,
  )

  it(
    'picks up created and deleted providers',
    async () => {
      await rebuild(() =>
        app.write('src/extra.ts', "import { Injectable } from '@znight/core'\n@Injectable()\nexport class Extra {}\n"),
      )
      expect(fs.readFileSync(outFile, 'utf8')).toContain("['src/extra.ts#Extra']")
      expect(report((await run(['node', 'dist/main.js'], app.root)).stdout).providers).toContain('src/extra.ts#Extra')

      await rebuild(() => app.remove('src/extra.ts'))
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
      await rebuild(() =>
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

      await rebuild(() => app.remove('src/notifier.ts'))
      expect(report((await run(['node', 'dist/main.js'], app.root)).stdout).greeting).toBe('Hello Ada @43')
    },
    TIMEOUT,
  )

  it(
    'recompiles when tsconfig.json changes (module resolution input)',
    async () => {
      const compiles = summaries()
      await rebuild(() =>
        app.write(
          'tsconfig.json',
          fs.readFileSync(`${app.root}/tsconfig.json`, 'utf8').replace('"strict": true', '"strict": false'),
        ),
      )
      expect(summaries()).toBe(compiles + 1)
    },
    TIMEOUT,
  )

  it(
    'recompiles when a constant imported from outside the include globs changes',
    async () => {
      app.write('shared/names.ts', "export const NAME = 'alpha'\n")
      await rebuild(() =>
        app.write(
          'src/named.ts',
          "import { Injectable } from '@znight/core'\nimport { NAME } from '../shared/names.ts'\n@Injectable({ name: NAME })\nexport class Named {}\n",
        ),
      )
      expect(fs.readFileSync(outFile, 'utf8')).toContain("name: 'alpha'")
      const compiles = summaries()
      await rebuild(() => app.write('shared/names.ts', "export const NAME = 'beta'\n"))
      expect(summaries()).toBe(compiles + 1)
      expect(fs.readFileSync(outFile, 'utf8')).toContain("name: 'beta'")
      expect(fs.readFileSync(`${app.root}/dist/main.js`, 'utf8')).toContain('name: "beta"')
    },
    TIMEOUT,
  )

  it(
    'ignores the generated module (an external write triggers nothing)',
    async () => {
      const before = builds
      fs.appendFileSync(outFile, '\n// touched\n')
      await sleep(SETTLE_MS)
      expect(builds).toBe(before)
    },
    TIMEOUT,
  )
})
