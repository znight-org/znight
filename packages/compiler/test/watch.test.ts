/**
 * Watch helpers shared by the Vite plugin and the Bun preload: glob bases, include roots, relevant
 * file events, generated module detection through symlinks, accumulated changes.
 */
import fs from 'node:fs'

import { createCompiler } from '../src/compiler.ts'
import { globBase, includeRoots, isOutFile, isRelevantChange, PendingChanges } from '../src/watch.ts'
import { tempApp } from './analysis/helpers.ts'
import { tempDir } from './project/helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

describe('globBase()', () => {
  it('is the static directory prefix of a glob', () => {
    expect(globBase('src/**/*.{ts,tsx,mts}')).toBe('src')
    expect(globBase('src/features/*/index.ts')).toBe('src/features')
    expect(globBase('**/*.ts')).toBe('.')
    expect(globBase('*.ts')).toBe('.')
    expect(globBase('lib/main.ts')).toBe('lib')
    expect(globBase('main.ts')).toBe('.')
    expect(globBase('!src/legacy/**')).toBe('src/legacy')
    expect(globBase('src\\win\\*.ts')).toBe('src/win')
    expect(globBase('src/[ab]/*.ts')).toBe('src')
  })
})

describe('includeRoots(), isOutFile(), isRelevantChange()', () => {
  const app = tempApp({ 'src/a.ts': 'export const a = 1\n', 'lib/b.ts': 'export const b = 1\n' })
  afterAll(() => app.cleanup())

  it('lists the include roots without nested duplicates', () => {
    const compiler = createCompiler({ root: app.root, include: ['src/**/*.ts', 'src/deep/**/*.ts', 'lib/*.ts'] })
    expect(includeRoots(compiler)).toEqual([`${app.root}/lib`, `${app.root}/src`])
    expect(includeRoots(createCompiler({ root: app.root, include: ['**/*.ts', 'src/*.ts'] }))).toEqual([app.root])
  })

  it('recognizes the generated module, also through a symbolic link', () => {
    const compiler = createCompiler({ root: app.root })
    const outFile = `${app.root}/src/.znight/container.generated.ts`
    expect(isOutFile(compiler, outFile)).toBe(true)
    expect(isOutFile(compiler, `${app.root}/src/a.ts`)).toBe(false)
    const link = tempDir()
    try {
      fs.rmSync(link.root, { recursive: true })
      fs.symlinkSync(app.root, link.root, 'dir')
      fs.mkdirSync(`${app.root}/src/.znight`, { recursive: true })
      expect(isOutFile(compiler, `${link.root}/src/.znight/container.generated.ts`)).toBe(true)
    } finally {
      fs.rmSync(link.root, { force: true })
      fs.rmSync(`${app.root}/src/.znight`, { recursive: true, force: true })
    }
  })

  it('keeps the events that can change the result', () => {
    const compiler = createCompiler({ root: app.root })
    const watched = new Set([
      `${app.root}/src/a.ts`,
      `${app.root}/package.json`,
      `${app.root}/node_modules/x/package.json`,
    ])
    const roots = [`${app.root}/src`]
    const relevant = (kind: 'changed' | 'added' | 'removed', file: string): boolean =>
      isRelevantChange(compiler, kind, file, watched, roots)
    expect(relevant('changed', `${app.root}/src/a.ts`)).toBe(true)
    expect(relevant('changed', `${app.root}/package.json`)).toBe(true)
    expect(relevant('changed', `${app.root}/node_modules/x/package.json`)).toBe(true)
    expect(relevant('changed', `${app.root}/tsconfig.json`)).toBe(true)
    expect(relevant('changed', `${app.root}/src/tsconfig.app.json`)).toBe(true)
    expect(relevant('added', `${app.root}/src/new.ts`)).toBe(true)
    expect(relevant('removed', `${app.root}/src/deep/gone.ts`)).toBe(true)
    // not a source, outside the roots, not watched, in node_modules, the generated module
    expect(relevant('added', `${app.root}/src/notes.md`)).toBe(false)
    expect(relevant('added', `${app.root}/scripts/x.ts`)).toBe(false)
    expect(relevant('changed', `${app.root}/src/other.ts`)).toBe(false)
    expect(relevant('changed', `${app.root}/node_modules/y/package.json`)).toBe(false)
    expect(relevant('added', `${app.root}/src/node_modules/y/index.ts`)).toBe(false)
    expect(relevant('changed', `${app.root}/src/.znight/container.generated.ts`)).toBe(false)
    expect(relevant('added', `${app.root}/src/.znight/container.generated.ts`)).toBe(false)
  })

  it('keeps the directory events of watchers reporting a moved directory alone (fs.watch)', () => {
    const compiler = createCompiler({ root: app.root })
    const watched = new Set([`${app.root}/src/users/user.service.ts`, `${app.root}/package.json`])
    const roots = [`${app.root}/src`]
    const relevant = (kind: 'changed' | 'added' | 'removed', file: string): boolean =>
      isRelevantChange(compiler, kind, file, watched, roots)
    fs.mkdirSync(`${app.root}/src/accounts`, { recursive: true })
    fs.mkdirSync(`${app.root}/docs`, { recursive: true })
    try {
      // `mv src/users src/accounts`: the old directory held compiled files, the new one is a source directory
      expect(relevant('removed', `${app.root}/src/users`)).toBe(true)
      expect(relevant('added', `${app.root}/src/accounts`)).toBe(true)
      // a directory created outside the include roots, or that does not exist (anymore)
      expect(relevant('added', `${app.root}/docs`)).toBe(false)
      expect(relevant('added', `${app.root}/src/gone`)).toBe(false)
      // a removed directory without compiled files, a changed directory
      expect(relevant('removed', `${app.root}/src/empty`)).toBe(false)
      expect(relevant('removed', `${app.root}/src/use`)).toBe(false)
      expect(relevant('changed', `${app.root}/src/accounts`)).toBe(false)
    } finally {
      fs.rmSync(`${app.root}/src/accounts`, { recursive: true, force: true })
      fs.rmSync(`${app.root}/docs`, { recursive: true, force: true })
    }
  })
})

describe('the public entry', () => {
  it('exposes includeRoots() and isRelevantChange() for custom watchers (znight generate --watch)', async () => {
    const entry = await import('../src/index.ts')
    expect(entry.includeRoots).toBe(includeRoots)
    expect(entry.isRelevantChange).toBe(isRelevantChange)
  })
})

describe('PendingChanges', () => {
  it('accumulates changes, merges add/remove of the same file and is emptied by take()', () => {
    const changes = new PendingChanges()
    expect(changes.take()).toBeUndefined()
    changes.add('changed', '/app/a.ts')
    changes.add('changed', '/app/a.ts')
    changes.add('added', '/app/b.ts')
    changes.add('removed', '/app/b.ts')
    changes.add('removed', '/app/c.ts')
    changes.add('added', '/app/c.ts')
    expect(changes.size).toBe(3)
    expect(changes.take()).toEqual({ changed: ['/app/a.ts'], added: ['/app/c.ts'], removed: ['/app/b.ts'] })
    expect(changes.size).toBe(0)
    expect(changes.take()).toBeUndefined()
    changes.add('changed', '/app/a.ts')
    changes.add('removed', '/app/a.ts')
    expect(changes.take()).toEqual({ changed: [], added: [], removed: ['/app/a.ts'] })
  })
})
