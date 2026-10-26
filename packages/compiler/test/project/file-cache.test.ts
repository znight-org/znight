import { FileCache, scanDirectory } from '../../src/project/index.ts'
import { tempDir } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

describe('FileCache', () => {
  const dir = tempDir({ 'a.ts': 'export const a = 1', 'data.json': '{}' })
  afterAll(() => dir.cleanup())
  const a = `${dir.root}/a.ts`

  it('parses a file once', () => {
    const cache = new FileCache()
    const first = cache.get(a)
    expect(first?.facts.declarations.has('a')).toBe(true)
    expect(cache.get(a)).toBe(first)
    expect(cache.stats).toEqual({ parsed: 1, reused: 0 })
  })

  it('does not re-read a file until it is invalidated', () => {
    const cache = new FileCache()
    const first = cache.get(a)
    dir.write('a.ts', 'export const b = 2')
    expect(cache.get(a)).toBe(first)
    cache.invalidate(a)
    expect(cache.get(a)?.facts.declarations.has('b')).toBe(true)
    dir.write('a.ts', 'export const a = 1')
  })

  it('re-reads but reuses the parse when the content hash is unchanged', () => {
    const cache = new FileCache()
    const first = cache.get(a)
    dir.write('a.ts', 'export const a = 1')
    cache.invalidateAll()
    expect(cache.get(a)).toBe(first)
    expect(cache.stats).toEqual({ parsed: 1, reused: 1 })
    cache.resetStats()
    expect(cache.stats).toEqual({ parsed: 0, reused: 0 })
  })

  it('returns undefined for missing and unparseable files (and caches it)', () => {
    const cache = new FileCache()
    expect(cache.get(`${dir.root}/missing.ts`)).toBeUndefined()
    expect(cache.get(`${dir.root}/data.json`)).toBeUndefined()
    expect(cache.has(`${dir.root}/missing.ts`)).toBe(true)
    dir.write('missing.ts', 'export {}')
    expect(cache.get(`${dir.root}/missing.ts`)).toBeUndefined()
    cache.invalidate(`${dir.root}/missing.ts`)
    expect(cache.get(`${dir.root}/missing.ts`)).toBeDefined()
  })

  it('delete() and clear() forget files', () => {
    const cache = new FileCache()
    cache.get(a)
    cache.delete(a)
    expect(cache.has(a)).toBe(false)
    cache.get(a)
    cache.clear()
    expect([...cache.paths()]).toEqual([])
  })
})

describe('scanDirectory', () => {
  const dir = tempDir({
    'src/a.ts': '',
    'src/b.tsx': '',
    'src/c.mts': '',
    'src/d.js': '',
    'src/types.d.ts': '',
    'src/a.test.ts': '',
    'src/a.spec.tsx': '',
    'src/.znight/container.generated.ts': '',
    'src/.hidden/x.ts': '',
    'src/node_modules/pkg/index.ts': '',
    'src/nested/deep/e.ts': '',
    'src/gen/out.ts': '',
    'lib/outside.ts': '',
  })
  afterAll(() => dir.cleanup())
  const defaults = {
    include: ['src/**/*.{ts,tsx,mts}'],
    exclude: ['**/*.{test,spec}.*', '**/*.d.ts', '**/.znight/**'],
    outFile: `${dir.root}/src/gen/out.ts`,
  }

  it('applies include/exclude, skips dot-directories, node_modules and outFile', () => {
    expect(scanDirectory(dir.root, defaults).map(file => file.slice(dir.root.length + 1))).toEqual([
      'src/a.ts',
      'src/b.tsx',
      'src/c.mts',
      'src/nested/deep/e.ts',
    ])
  })

  it('dot-directories are skipped even when not excluded explicitly', () => {
    const files = scanDirectory(dir.root, { ...defaults, exclude: [] })
    expect(files.some(file => file.includes('/.znight/') || file.includes('/.hidden/'))).toBe(false)
    expect(files).toContain(`${dir.root}/src/a.test.ts`)
    expect(files).toContain(`${dir.root}/src/types.d.ts`)
  })

  it('only returns parseable files', () => {
    dir.write('src/readme.md', '# x')
    expect(scanDirectory(dir.root, { ...defaults, include: ['src/**/*'] })).not.toContain(`${dir.root}/src/readme.md`)
  })

  it('returns real paths, sorted and de-duplicated', () => {
    const files = scanDirectory(dir.root, { ...defaults, include: ['src/**/*.ts', 'src/a.ts'] })
    expect(files).toEqual([...new Set(files)].sort())
    expect(files.filter(file => file.endsWith('/src/a.ts'))).toHaveLength(1)
  })
})
