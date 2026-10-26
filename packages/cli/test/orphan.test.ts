/**
 * The orphan guard of `znight dev` with real processes: a stand-in for the CLI (fixtures/orphan)
 * starts the application detached with the guard, and is killed with SIGKILL.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ORPHAN_GUARD_ENV, orphanGuard, parseOrphanGuard } from '../src/dev/orphan.ts'
import { temporaryDirectory, waitFor } from './helpers.ts'
import { afterEach, describe, expect, test as it } from 'bun:test'

const FIXTURE = join(import.meta.dir, 'fixtures/orphan')
const GUARD_URL = import.meta.resolve('@znight/cli/orphan-guard')
const node = Bun.which('node')
const settings = { parentPid: 42, pollMs: 500, killTimeoutMs: 5000 }

describe('orphanGuard()', () => {
  it('preloads the guard module with --import on Node.js and --preload on Bun', () => {
    expect(GUARD_URL).toEndWith('/src/dev/orphan-guard.ts')
    expect(orphanGuard('node', settings)).toEqual({
      args: ['--import', GUARD_URL],
      env: { [ORPHAN_GUARD_ENV]: '42:500:5000' },
    })
    expect(orphanGuard('bun', settings)).toEqual({
      args: ['--preload', fileURLToPath(GUARD_URL)],
      env: { [ORPHAN_GUARD_ENV]: '42:500:5000' },
    })
  })

  it('is left out when its module cannot be found (the application must start anyway)', () => {
    const missing = (): string => {
      throw new Error('Cannot find module')
    }
    expect(orphanGuard('node', settings, missing)).toBeUndefined()
    expect(orphanGuard('node', settings, () => 'file:///nowhere/orphan-guard.mjs')).toBeUndefined()
    expect(orphanGuard('bun', settings, () => 'data:text/javascript,')).toBeUndefined()
  })

  it('reads its settings back, and nothing from a malformed value', () => {
    expect(parseOrphanGuard('42:500:5000')).toEqual(settings)
    expect(parseOrphanGuard('42:500:0')).toEqual({ ...settings, killTimeoutMs: 0 })
    for (const value of [undefined, '', '42', '42:500', '0:500:5000', '42:0:5000', '42:x:5000', '-1:500:5000']) {
      expect(parseOrphanGuard(value)).toBeUndefined()
    }
  })
})

/** Whether a process exists. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('the guarded application', () => {
  const cleanups: (() => void)[] = []
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  /** Starts the stand-in CLI; resolves with its process and the application pid once it is ready. */
  async function startParent(executable: string, runtime: 'node' | 'bun', behaviour: string) {
    const directory = temporaryDirectory('znight-orphan-')
    const marker = join(directory.path, 'events.log')
    const parent: ChildProcess = spawn(
      process.execPath,
      ['--conditions=@znight/source', join(FIXTURE, 'parent.ts'), executable, runtime, behaviour, marker],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    )
    let output = ''
    parent.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk
    })
    const events = (): string[] => (existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n') : [])
    cleanups.push(() => {
      parent.kill('SIGKILL')
      for (const line of [`app ${output.trim()}`, ...events()]) {
        const pid = Number(line.split(' ')[1])
        if (pid > 0 && isAlive(pid)) process.kill(pid, 'SIGKILL')
      }
      directory.cleanup()
    })
    await waitFor(() => output.endsWith('\n') && events().some(line => line.startsWith('ready')), 10_000)
    return { parent, app: Number(output.trim()), events }
  }

  const runtimes = [
    ['node', node],
    ['bun', process.execPath],
  ] as const

  for (const [runtime, executable] of runtimes) {
    it.skipIf(executable === null)(
      `stops gracefully (SIGTERM) once the CLI is killed (${runtime})`,
      async () => {
        const { parent, app, events } = await startParent(executable as string, runtime, 'graceful')
        // the guard reads its settings, then removes them from the environment of the application
        expect(events()).toEqual(['ready no-guard-variable'])
        // the CLI is alive: nothing happens
        await Bun.sleep(200)
        expect(isAlive(app)).toBe(true)

        parent.kill('SIGKILL')
        await waitFor(() => !isAlive(app), 5000)
        expect(events()).toEqual(['ready no-guard-variable', 'SIGTERM'])
      },
      15_000,
    )
  }

  it.skipIf(node === null)(
    'kills an application that does not stop after SIGTERM, but leaves the processes it started alone',
    async () => {
      const { parent, app, events } = await startParent(node as string, 'node', 'fork')
      await waitFor(() => events().some(line => line.startsWith('forked')), 5000)
      const forkedLine = events().find(line => line.startsWith('forked')) ?? ''
      const forked = Number(forkedLine.split(' ')[1])
      parent.kill('SIGKILL')
      await waitFor(() => !isAlive(app), 5000)
      expect(events()).toContain('SIGTERM')
      // a process the application forked (with its runtime arguments, so with the guard too)
      await Bun.sleep(200)
      expect(isAlive(forked)).toBe(true)

      const stubborn = await startParent(node as string, 'node', 'stubborn')
      stubborn.parent.kill('SIGKILL')
      await waitFor(() => stubborn.events().includes('SIGTERM'), 5000)
      expect(isAlive(stubborn.app)).toBe(true)
      // SIGKILL after the kill timeout (1 s)
      await waitFor(() => !isAlive(stubborn.app), 5000)
    },
    20_000,
  )
})
