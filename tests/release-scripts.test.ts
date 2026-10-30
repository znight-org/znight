/**
 * The release scripts (`scripts/release/*`): package discovery and ordering, lockstep versions,
 * tarball verification rules and release notes. Packing and publishing themselves run in CI
 * (`bun run release:pack`, `bun run release:smoke`, the release workflow).
 */
import type { TarballContents, VerifyOptions } from '../scripts/release/tarball.ts'
import type { Manifest, WorkspacePackage } from '../scripts/release/workspace.ts'

import { changelogSection, withoutDependencyBumps } from '../scripts/release/notes.ts'
import { tarballName, verifyTarball } from '../scripts/release/tarball.ts'
import {
  changesetReleases,
  distTagFor,
  lockstepVersion,
  publishablePackages,
  sortByDependencies,
} from '../scripts/release/workspace.ts'
import { describe, expect, test as it } from 'bun:test'

const pkg = (name: string, manifest: Partial<Manifest> = {}): WorkspacePackage => ({
  name,
  version: manifest.version ?? '1.2.0',
  dir: `/repo/packages/${name.split('/')[1]}`,
  manifest: { name, version: '1.2.0', ...manifest },
})

describe('publishable packages', () => {
  const packages = publishablePackages()

  it('are the public @znight/* packages, in one lockstep version', () => {
    expect(packages.length).toBeGreaterThan(0)
    for (const { name, manifest } of packages) {
      expect(name).toStartWith('@znight/')
      expect(manifest.private).not.toBe(true)
    }
    expect(packages.map(({ name }) => name)).not.toContain('@znight/docs')
    expect(lockstepVersion(packages)).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('come after the workspace packages they depend on', () => {
    const position = new Map(packages.map(({ name }, index) => [name, index]))
    for (const { name, manifest } of packages) {
      for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
        for (const dependency of Object.keys(manifest[field] ?? {})) {
          const index = position.get(dependency)
          if (index !== undefined) expect(index).toBeLessThan(position.get(name) ?? -1)
        }
      }
    }
  })
})

describe('sortByDependencies', () => {
  it('orders dependencies first, then by name', () => {
    const sorted = sortByDependencies([
      pkg('@x/http', {
        dependencies: { '@x/core': 'workspace:*' },
        peerDependencies: { '@x/compiler': 'workspace:^' },
      }),
      pkg('@x/compiler', { dependencies: { '@x/core': 'workspace:*' } }),
      pkg('@x/core'),
    ])
    expect(sorted.map(({ name }) => name)).toEqual(['@x/core', '@x/compiler', '@x/http'])
  })

  it('ignores dev dependencies and rejects cycles', () => {
    expect(() =>
      sortByDependencies([
        pkg('@x/a', { devDependencies: { '@x/b': 'workspace:*' } }),
        pkg('@x/b', { dependencies: { '@x/a': 'workspace:*' } }),
      ]),
    ).not.toThrow()
    expect(() =>
      sortByDependencies([
        pkg('@x/a', { dependencies: { '@x/b': 'workspace:*' } }),
        pkg('@x/b', { dependencies: { '@x/a': 'workspace:*' } }),
      ]),
    ).toThrow('Dependency cycle')
  })
})

it('lockstepVersion rejects packages at different versions', () => {
  expect(() => lockstepVersion([pkg('@x/a', { version: '1.0.0' }), pkg('@x/b', { version: '1.1.0' })])).toThrow(
    'must share one version',
  )
})

describe('changesetReleases', () => {
  const published = new Set(['@znight/core', '@znight/http'])
  const read = (contents: string) => changesetReleases('.changeset/x.md', contents, published)

  it('reads the packages a changeset bumps', () => {
    expect(read("---\n'@znight/http': patch\n---\n\nFix the multipart details\n")).toEqual([
      { name: '@znight/http', type: 'patch' },
    ])
  })

  it('an empty changeset (changeset add --empty) releases nothing', () => {
    expect(read('---\n---\n')).toEqual([])
    expect(read('---\r\n\r\n---\r\n\r\nNothing to release\r\n')).toEqual([])
  })

  it('rejects a changeset that changeset version cannot read, naming the file', () => {
    // a one-line front matter that a Markdown formatter read as a setext heading
    expect(() => read("---\n\n## '@znight/core': patch\n\nFix\n")).toThrow(
      '.changeset/x.md: could not parse changeset - missing or invalid frontmatter',
    )
    expect(() => read('no front matter')).toThrow('missing or invalid frontmatter')
    expect(() => read("---\n'@znight/core': bugfix\n---\n\nFix\n")).toThrow('invalid version type "bugfix"')
  })

  it('rejects a package that is not published', () => {
    expect(() => read("---\n'@znight-examples/worker': patch\n---\n\nFix\n")).toThrow(
      '.changeset/x.md: "@znight-examples/worker" is not a published package (@znight/core, @znight/http)',
    )
  })
})

it('distTagFor sends prereleases to next', () => {
  expect(distTagFor('1.2.0')).toBe('latest')
  expect(distTagFor('2.0.0-beta.1')).toBe('next')
})

it('tarballName follows bun pm pack', () => {
  expect(tarballName({ name: '@znight/core', version: '0.1.0' })).toBe('znight-core-0.1.0.tgz')
})

describe('verifyTarball', () => {
  const options: VerifyOptions = {
    version: '1.2.0',
    internal: new Set(['@znight/core', '@znight/http']),
    missingReadme: 'error',
  }
  const manifest: Manifest = {
    name: '@znight/http',
    version: '1.2.0',
    license: 'MIT',
    repository: { type: 'git', url: 'git+https://github.com/znight-org/znight.git', directory: 'packages/http' },
    publishConfig: { access: 'public' },
    exports: { '.': { types: './dist/index.d.mts', default: './dist/index.mjs' }, './package.json': './package.json' },
    dependencies: { '@znight/core': '1.2.0', pino: '^10.4.0' },
    peerDependencies: { '@znight/compiler': '^1.2.0' },
  }
  const contents = (overrides: Partial<Manifest> = {}, files?: readonly string[]): TarballContents => {
    const packed = { ...manifest, ...overrides }
    return {
      manifest: packed,
      rawManifest: JSON.stringify(packed),
      files: new Set(
        files ?? [
          'package/package.json',
          'package/README.md',
          'package/LICENSE',
          'package/dist/index.mjs',
          'package/dist/index.d.mts',
        ],
      ),
    }
  }
  const verify = (tarball: TarballContents, verifyOptions: VerifyOptions = options) =>
    verifyTarball(pkg('@znight/http', { version: '1.2.0' }), '/unused.tgz', tarball, verifyOptions)

  it('accepts a complete tarball', async () => {
    expect(await verify(contents())).toEqual([])
  })

  it('rejects ranges bun pm pack did not rewrite, or that miss the lockstep version', async () => {
    const findings = await verify(contents({ dependencies: { '@znight/core': 'workspace:*', zod: 'catalog:' } }))
    expect(findings.filter(({ level }) => level === 'error').map(({ message }) => message)).toEqual([
      'dependencies.@znight/core is still "workspace:*" (not rewritten by bun pm pack)',
      'dependencies.zod is still "catalog:" (not rewritten by bun pm pack)',
      'the packed package.json still contains a workspace: or catalog: range',
    ])
    const stale = await verify(contents({ dependencies: { '@znight/core': '1.1.0' } }))
    expect(stale[0]?.message).toContain('does not accept the lockstep version 1.2.0')
  })

  it('requires README (an error when releasing, a warning otherwise), LICENSE, dist and the entry points', async () => {
    const files = ['package/package.json', 'package/dist/index.mjs']
    const errors = (await verify(contents({}, files))).map(({ message }) => message)
    expect(errors).toContain('LICENSE is missing')
    expect(errors).toContain('entry point ./dist/index.d.mts (exports/main/types) is not in the tarball')
    expect(errors.some(message => message.startsWith('README.md is missing'))).toBe(true)
    const relaxed = await verify(contents({}, [...files, 'package/LICENSE', 'package/dist/index.d.mts']), {
      ...options,
      missingReadme: 'warning',
    })
    expect(relaxed.map(({ level }) => level)).toEqual(['warning'])
    expect(
      (await verify(contents({}, ['package/package.json', 'package/README.md', 'package/LICENSE']))).map(
        ({ message }) => message,
      ),
    ).toContain('dist/ is missing (run `bun run build` first)')
  })

  it('rejects stray files and a repository npm provenance would not match', async () => {
    const findings = await verify(
      contents({ repository: 'https://github.com/someone/fork' }, [
        'package/package.json',
        'package/README.md',
        'package/LICENSE',
        'package/dist/index.mjs',
        'package/dist/index.d.mts',
        'package/.env',
        'package/dist/tsconfig.tsbuildinfo',
      ]),
    )
    const messages = findings.map(({ message }) => message)
    expect(messages).toContain('unexpected file package/.env')
    expect(messages).toContain('unexpected file package/dist/tsconfig.tsbuildinfo')
    expect(messages.some(message => message.startsWith('repository.url must point to'))).toBe(true)
  })
})

describe('release notes', () => {
  const changelog = `# @znight/http

## 0.3.0

### Minor Changes

- abc1234: Cookies and server-sent events.

### Patch Changes

- Updated dependencies [abc1234]:
  - @znight/core@0.3.0

## 0.2.0

### Patch Changes

- @znight/core@0.2.0
`

  it('keeps the changes of a version, without the lockstep dependency bumps', () => {
    expect(withoutDependencyBumps(changelogSection(changelog, '0.3.0') ?? '')).toBe(
      '### Minor Changes\n\n- abc1234: Cookies and server-sent events.',
    )
    expect(withoutDependencyBumps(changelogSection(changelog, '0.2.0') ?? '')).toBe('')
    expect(changelogSection(changelog, '9.9.9')).toBeUndefined()
  })
})
