/**
 * The changeset of Dependabot pull requests (`scripts/release/dependabot-changeset.ts`): which
 * dependency changes reach the users of a published package, the changeset that announces them, and
 * the whole thing against a real git repository.
 */
import type { Manifest } from '../scripts/release/workspace.ts'

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { syncChangeset } from '../scripts/release/dependabot-changeset.ts'
import {
  changesetFile,
  dependencyChanges,
  readCatalogs,
  renderChangeset,
  resolveVersion,
} from '../scripts/release/dependency-changes.ts'
import { changesetReleases } from '../scripts/release/workspace.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

const manifest = (name: string, fields: Partial<Manifest> = {}): Manifest => ({ name, version: '1.0.0', ...fields })
const noCatalogs = readCatalogs({})

describe('catalogs', () => {
  it('are read under `workspaces` (Bun object form) or at the top level, default and named', () => {
    const nested = readCatalogs({
      workspaces: { catalog: { zod: '4.0.0' }, catalogs: { legacy: { zod: '3.0.0' } } },
    })
    expect(nested.default).toEqual({ zod: '4.0.0' })
    expect(nested.named).toEqual({ legacy: { zod: '3.0.0' } })

    const topLevel = readCatalogs({ workspaces: ['packages/*'], catalog: { zod: '4.0.0' } })
    expect(topLevel.default).toEqual({ zod: '4.0.0' })
    expect(readCatalogs({ workspaces: ['packages/*'] }).default).toEqual({})
  })

  it('resolve `catalog:` and `catalog:<name>` specifiers, and leave every other specifier alone', () => {
    const catalogs = readCatalogs({ workspaces: { catalog: { zod: '4.0.0' }, catalogs: { legacy: { zod: '3.0.0' } } } })
    expect(resolveVersion('zod', 'catalog:', catalogs)).toBe('4.0.0')
    expect(resolveVersion('zod', 'catalog:legacy', catalogs)).toBe('3.0.0')
    expect(resolveVersion('zod', '^4.1.0', catalogs)).toBe('^4.1.0')
    expect(resolveVersion('zod', 'workspace:*', catalogs)).toBe('workspace:*')
    expect(resolveVersion('missing', 'catalog:', catalogs)).toBe('catalog:')
  })
})

describe('dependencyChanges', () => {
  it('reports a changed range of a runtime dependency, a peer dependency or an optional dependency', () => {
    const base = manifest('@x/a', {
      dependencies: { left: '^1.0.0', same: '^2.0.0' },
      peerDependencies: { vite: '^8.0.0' },
      optionalDependencies: { fsevents: '^2.0.0' },
    })
    const head = manifest('@x/a', {
      dependencies: { left: '^1.1.0', same: '^2.0.0' },
      peerDependencies: { vite: '^8.1.0' },
      optionalDependencies: { fsevents: '^2.1.0' },
    })
    expect(dependencyChanges(base, head, noCatalogs, noCatalogs)).toEqual([
      { name: 'fsevents', field: 'optionalDependencies', from: '^2.0.0', to: '^2.1.0' },
      { name: 'left', field: 'dependencies', from: '^1.0.0', to: '^1.1.0' },
      { name: 'vite', field: 'peerDependencies', from: '^8.0.0', to: '^8.1.0' },
    ])
  })

  it('ignores dev dependencies, workspace specifiers, and dependencies that are added or removed', () => {
    const base = manifest('@x/a', {
      dependencies: { '@x/core': 'workspace:*', removed: '^1.0.0' },
      devDependencies: { tool: '1.0.0' },
    })
    const head = manifest('@x/a', {
      dependencies: { '@x/core': 'workspace:*', added: '^1.0.0' },
      devDependencies: { tool: '2.0.0' },
    })
    expect(dependencyChanges(base, head, noCatalogs, noCatalogs)).toEqual([])
  })

  it('follows a catalog: a bump of an entry used at runtime counts, a bump of a dev dependency does not', () => {
    const before = readCatalogs({ workspaces: { catalog: { zod: '4.0.0', tsdown: '1.0.0' } } })
    const after = readCatalogs({ workspaces: { catalog: { zod: '4.1.0', tsdown: '2.0.0' } } })
    const runtime = manifest('@x/a', { dependencies: { zod: 'catalog:' }, devDependencies: { tsdown: 'catalog:' } })
    expect(dependencyChanges(runtime, runtime, before, after)).toEqual([
      { name: 'zod', field: 'dependencies', from: '4.0.0', to: '4.1.0' },
    ])
  })
})

describe('renderChangeset', () => {
  const packages = [
    {
      name: '@x/http',
      changes: [
        { name: 'left', field: 'dependencies', from: '^1.0.0', to: '^1.1.0' },
        { name: 'vite', field: 'peerDependencies', from: '^8.0.0', to: '^8.1.0' },
      ],
    },
    { name: '@x/cli', changes: [{ name: 'left', field: 'dependencies', from: '^1.0.0', to: '^1.1.0' }] },
  ] as const

  it('bumps every package concerned and writes one changelog line, without repeating a dependency', () => {
    expect(renderChangeset(packages)).toBe(
      [
        '---',
        '"@x/cli": patch',
        '"@x/http": patch',
        '---',
        '',
        'Update left from ^1.0.0 to ^1.1.0, the vite peer dependency from ^8.0.0 to ^8.1.0.',
        '',
      ].join('\n'),
    )
  })

  it('is read by the Changesets parser', () => {
    const releases = changesetReleases(
      '.changeset/dependabot-1.md',
      renderChangeset(packages),
      new Set(['@x/cli', '@x/http']),
    )
    expect(releases).toEqual([
      { name: '@x/cli', type: 'patch' },
      { name: '@x/http', type: 'patch' },
    ])
  })

  it('is named after the pull request', () => {
    expect(changesetFile(18)).toBe('dependabot-18.md')
  })
})

describe('syncChangeset, in a git repository', () => {
  const root = mkdtempSync(join(tmpdir(), 'znight-dependabot-changeset-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: root,
      stdio: 'pipe',
    })
  }
  const write = (path: string, contents: unknown): void => {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), `${JSON.stringify(contents, null, 2)}\n`)
  }
  const changeset = join(root, '.changeset', 'dependabot-7.md')
  const sync = (): ReturnType<typeof syncChangeset> => syncChangeset({ root, base: 'main', pullRequest: 7 })

  const lib = (left: string, tool: string): Manifest => ({
    name: '@x/lib',
    version: '1.0.0',
    dependencies: { left },
    devDependencies: { tool },
  })
  const rootManifest = (zod: string): unknown => ({
    name: 'repo',
    private: true,
    workspaces: { packages: ['packages/*', 'examples/*'], catalog: { zod } },
  })

  it('writes the changeset of the runtime changes since the merge base, and nothing for the rest', async () => {
    git('init', '--quiet', '--initial-branch', 'main')
    git('config', 'user.name', 'test')
    git('config', 'user.email', 'test@example.com')
    write('package.json', rootManifest('4.0.0'))
    write('packages/lib/package.json', lib('^1.0.0', '1.0.0'))
    write('packages/other/package.json', manifest('@x/other', { dependencies: { zod: 'catalog:' } }))
    write('examples/app/package.json', { name: '@x-examples/app', private: true, dependencies: { left: '^1.0.0' } })
    git('add', '--all')
    git('commit', '--quiet', '--message', 'base')

    git('switch', '--quiet', '--create', 'dependabot/bun/dependencies-abc')
    write('package.json', rootManifest('4.1.0'))
    write('packages/lib/package.json', lib('^1.1.0', '2.0.0'))
    write('examples/app/package.json', { name: '@x-examples/app', private: true, dependencies: { left: '^1.1.0' } })
    git('add', '--all')
    git('commit', '--quiet', '--message', 'bump')

    expect(await sync()).toBe('written')
    expect(readFileSync(changeset, 'utf8')).toBe(
      [
        '---',
        '"@x/lib": patch',
        '"@x/other": patch',
        '---',
        '',
        'Update left from ^1.0.0 to ^1.1.0, zod from 4.0.0 to 4.1.0.',
        '',
      ].join('\n'),
    )
  })

  it('is idempotent, and ignores what the base branch gained since the merge base', async () => {
    expect(await sync()).toBe('unchanged')

    git('switch', '--quiet', 'main')
    // compared with the tip of main, the pull request would "downgrade" left from ^1.5.0 to ^1.1.0
    write('packages/lib/package.json', lib('^1.5.0', '9.9.9'))
    git('commit', '--all', '--quiet', '--message', 'main moves on')
    git('switch', '--quiet', 'dependabot/bun/dependencies-abc')

    expect(await sync()).toBe('unchanged')
  })

  it('removes the changeset when no runtime dependency changed anymore', async () => {
    write('package.json', rootManifest('4.0.0'))
    write('packages/lib/package.json', lib('^1.0.0', '2.0.0'))
    git('commit', '--all', '--quiet', '--message', 'only dev changes left')

    expect(await sync()).toBe('removed')
    expect(existsSync(changeset)).toBe(false)
    expect(await sync()).toBe('none')
  })
})
