/**
 * The benchmarks page, its charts, the headline numbers of the home page and of the root README
 * show the published results (benchmarks/results/results.json), exactly: regenerate them with
 * `bun run --cwd benchmarks report` after a run.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { highlights } from '../../benchmarks/src/highlights.ts'
import { renderAll } from '../../benchmarks/src/report.ts'
import { readResults } from '../../benchmarks/src/results.ts'
import { describe, expect, test as it } from 'bun:test'

const repoRoot = resolve(import.meta.dir, '../..')
const results = readResults()

describe('benchmarks', () => {
  it('has published results', () => {
    expect(results?.boot?.results.length).toBeGreaterThan(0)
    expect(results?.http?.results.length).toBeGreaterThan(0)
    expect(results?.di?.results.length).toBeGreaterThan(0)
  })

  const files = results === undefined ? [] : [...renderAll(results)]
  it.each(files.map(([file, content]) => [relative(repoRoot, file), content]))(
    '%s is up to date with the results',
    (file, content) => {
      const path = join(repoRoot, file)
      expect(existsSync(path)).toBe(true)
      expect(readFileSync(path, 'utf8')).toBe(content)
    },
  )

  it('the root README shows the headline numbers of the results', () => {
    const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8').replace(/\*\*/g, '')
    const items = results === undefined ? [] : highlights(results).items
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) {
      expect(readme).toContain(`${item.value} ${item.label}`)
      expect(readme).toContain(item.detail)
    }
  })
})
