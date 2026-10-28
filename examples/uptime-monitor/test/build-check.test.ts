import type { CompileResult, Diagnostic } from '@znight/compiler'

import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile, formatDiagnostics } from '@znight/compiler'

import options from '../znight.config.js'
import { afterAll, describe, expect, test as it } from 'bun:test'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const copies: string[] = []

afterAll(() => {
  for (const copy of copies) rmSync(copy, { recursive: true, force: true })
})

/**
 * Compiles a copy of this application after `edit` (file → find → replace): what `znight build`
 * (or `bun test`) would say about the change. Keeps the "Try breaking it" section of the README
 * honest.
 */
async function compileWith(edits: readonly (readonly [file: string, find: string, replace: string])[]): Promise<{
  readonly result: CompileResult
  readonly root: string
}> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'uptime-monitor-build-')))
  copies.push(root)
  cpSync(join(ROOT, 'src'), join(root, 'src'), { recursive: true, filter: source => !source.includes('.znight') })
  for (const file of ['package.json', 'tsconfig.json']) cpSync(join(ROOT, file), join(root, file))
  symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'), 'dir')
  for (const [file, find, replace] of edits) {
    const path = join(root, file)
    const source = readFileSync(path, 'utf8')
    if (!source.includes(find)) throw new Error(`${file} does not contain ${find}`)
    writeFileSync(path, source.replace(find, replace))
  }
  // in-repo: the @znight/* packages are analysed from their TypeScript sources
  const result = await compile({ ...options, root, conditions: ['@znight/source'] })
  return { result, root }
}

const errors = (result: CompileResult): Diagnostic[] => result.diagnostics.filter(d => d.severity === 'error')

/** 1-based line and column of `needle` on the first line of `file` that contains `line`. */
function positionOf(root: string, file: string, line: string, needle: string): { line: number; column: number } {
  const lines = readFileSync(join(root, file), 'utf8').split('\n')
  const index = lines.findIndex(text => text.includes(line))
  return { line: index + 1, column: (lines[index]?.indexOf(needle, lines[index]?.indexOf(line)) ?? 0) + 1 }
}

describe('build-time checks of the jobs', () => {
  it('the application compiles as is', async () => {
    const { result } = await compileWith([])

    expect(errors(result)).toEqual([])
  }, 30_000)

  it('ZNIGHT040: an invalid cron expression, with a caret under the faulty field', async () => {
    const { result, root } = await compileWith([
      ['src/digest/digest.jobs.ts', "@Cron('0 8 * * MON-FRI', { name", "@Cron('0 25 * * MON-FRI', { name"],
    ])

    const [error] = errors(result)
    expect(error?.code).toBe('ZNIGHT040')
    expect(error?.message).toContain('hour 25 is out of range (0-23)')
    expect(error?.location?.file).toEndWith('/src/digest/digest.jobs.ts')
    // the location is the field itself, inside the string literal
    expect(error?.location).toMatchObject(
      positionOf(root, 'src/digest/digest.jobs.ts', "@Cron('0 25 * * MON-FRI', { name", '25'),
    )
    expect(error?.location?.end).toBe((error?.location?.start ?? 0) + 2)
    expect(formatDiagnostics(errors(result), { color: false, cwd: root })).toContain('--> src/digest/digest.jobs.ts')
  }, 30_000)

  it('ZNIGHT040: an unknown time zone', async () => {
    const { result } = await compileWith([
      ['src/digest/digest.jobs.ts', "timeZone: 'Europe/Paris', maxDuration", "timeZone: 'Europe/Pariss', maxDuration"],
    ])

    expect(errors(result).map(error => error.code)).toEqual(['ZNIGHT040'])
    expect(errors(result)[0]?.message).toContain('Europe/Pariss')
  }, 30_000)

  it('ZNIGHT041: two jobs with the same name', async () => {
    const { result } = await compileWith([
      ['src/maintenance/purge.jobs.ts', "name: 'probes.purge'", "name: 'digest.daily'"],
    ])

    expect(errors(result).map(error => error.code)).toContain('ZNIGHT041')
    expect(errors(result).find(error => error.code === 'ZNIGHT041')?.message).toContain('digest.daily')
  }, 30_000)

  it('ZNIGHT005: a job that is not a public method', async () => {
    const { result } = await compileWith([['src/maintenance/purge.jobs.ts', 'async purge(', 'private async purge(']])

    expect(errors(result).map(error => error.code)).toContain('ZNIGHT005')
  }, 30_000)
})
