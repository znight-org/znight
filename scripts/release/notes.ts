/**
 * Prints the GitHub release notes of a version (Markdown), gathered from the `CHANGELOG.md` of every
 * publishable package (written by `changeset version`). Lockstep bumps without changes of their own
 * ("Updated dependencies", `@znight/core@x.y.z`) are left out.
 *
 *   bun scripts/release/notes.ts [version]    # default: the current lockstep version
 */
import type { WorkspacePackage } from './workspace.ts'

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { main } from './support.ts'
import { lockstepVersion, publishablePackages, REPOSITORY } from './workspace.ts'

/** The body of the `## <version>` section of a Changesets CHANGELOG, or undefined. */
export function changelogSection(changelog: string, version: string): string | undefined {
  const lines = changelog.split('\n')
  const start = lines.findIndex(line => line.trim() === `## ${version}`)
  if (start === -1) return undefined
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join('\n')
    .trim()
}

/** Removes the dependency-only entries of a section, then the headings left empty. */
export function withoutDependencyBumps(section: string): string {
  const kept: string[] = []
  let skippingNested = false
  for (const line of section.split('\n')) {
    if (/^- Updated dependencies/.test(line)) {
      skippingNested = true
      continue
    }
    if (skippingNested && /^\s+- /.test(line)) continue
    skippingNested = false
    if (/^- @[\w.-]+\/[\w.-]+@\S+$/.test(line.trim()) && line.startsWith('- ')) continue
    kept.push(line)
  }
  // drop headings followed by nothing but blank lines until the next heading (or the end)
  const result: string[] = []
  for (let index = 0; index < kept.length; index++) {
    const line = kept[index] ?? ''
    if (line.startsWith('#')) {
      const next = kept.slice(index + 1).find(candidate => candidate.trim() !== '')
      if (next === undefined || next.startsWith('#')) continue
    }
    result.push(line)
  }
  return result
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function releaseNotes(packages: readonly WorkspacePackage[], version: string): string {
  const sections: string[] = []
  for (const pkg of packages) {
    const file = join(pkg.dir, 'CHANGELOG.md')
    if (!existsSync(file)) continue
    const section = changelogSection(readFileSync(file, 'utf8'), version)
    const body = section === undefined ? '' : withoutDependencyBumps(section)
    if (body !== '') sections.push(`## ${pkg.name}\n\n${body}`)
  }
  const list = packages
    .map(pkg => `[\`${pkg.name}\`](https://www.npmjs.com/package/${pkg.name}/v/${version})`)
    .join(' · ')
  return [
    `All packages are released together at **${version}**: ${list}`,
    '',
    ...(sections.length > 0 ? sections : ['No notable changes.']).flatMap(section => [section, '']),
    `**Changelogs**: \`packages/*/CHANGELOG.md\` in [${REPOSITORY}](https://github.com/${REPOSITORY}).`,
    '',
  ].join('\n')
}

if (import.meta.main) {
  main(() => {
    const packages = publishablePackages()
    const version = process.argv[2] ?? lockstepVersion(packages)
    process.stdout.write(releaseNotes(packages, version))
  })
}
