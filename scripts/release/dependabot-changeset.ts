/**
 * Writes, updates or removes the changeset of a Dependabot pull request: the published packages
 * whose `dependencies`, `peerDependencies` or `optionalDependencies` changed since the base branch
 * get a patch bump in `.changeset/dependabot-<pull request>.md` (see `dependency-changes.ts`). The
 * file is rewritten on every run, so a rebased or recreated pull request always carries the right
 * one; nothing is written when no user installs a different version (dev dependencies, lockfile,
 * examples, docs site).
 *
 *   bun scripts/release/dependabot-changeset.ts --pr 42 [--base origin/main]
 *
 * It only changes the working tree: the Dependabot changesets workflow commits and pushes the result.
 */
import type { PackageChanges, RootManifest } from './dependency-changes.ts'
import type { Manifest } from './workspace.ts'

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { parseArgs } from 'node:util'

import { changesetFile, dependencyChanges, readCatalogs, renderChangeset } from './dependency-changes.ts'
import { log, main, run, runOrThrow } from './support.ts'
import { publishablePackages, ROOT } from './workspace.ts'

/** What {@link syncChangeset} did with the changeset file. */
export type ChangesetOutcome = 'written' | 'unchanged' | 'removed' | 'none'

export interface SyncOptions {
  /** Repository root (the working tree is the head of the pull request). */
  readonly root: string
  /** The base branch of the pull request, e.g. `origin/main`. */
  readonly base: string
  readonly pullRequest: number
}

/** Brings `.changeset/dependabot-<pull request>.md` in line with the dependency changes of the head. */
export async function syncChangeset({ root, base, pullRequest }: SyncOptions): Promise<ChangesetOutcome> {
  // compare with the commit the pull request branched from, not with the tip of the base branch:
  // what the base branch gained since is not a change of the pull request
  const mergeBase = (await runOrThrow('git', ['merge-base', base, 'HEAD'], { cwd: root })).stdout.trim()
  const showAtMergeBase = async (path: string): Promise<string | undefined> => {
    const result = await run('git', ['show', `${mergeBase}:${path}`], { cwd: root })
    return result.code === 0 ? result.stdout : undefined
  }

  const baseCatalogs = readCatalogs(JSON.parse((await showAtMergeBase('package.json')) ?? '{}') as RootManifest)
  const headCatalogs = readCatalogs(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as RootManifest)

  const changed: PackageChanges[] = []
  for (const { name, dir, manifest } of publishablePackages(root)) {
    const before = await showAtMergeBase(relative(root, join(dir, 'package.json')).replaceAll('\\', '/'))
    // a package that did not exist yet: its first release announces it
    if (before === undefined) continue
    const changes = dependencyChanges(JSON.parse(before) as Manifest, manifest, baseCatalogs, headCatalogs)
    if (changes.length > 0) changed.push({ name, changes })
  }

  const path = `.changeset/${changesetFile(pullRequest)}`
  const file = join(root, path)
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : undefined

  if (changed.length === 0) {
    if (existing === undefined) {
      log.info('No runtime dependency of a published package changed: no changeset.')
      return 'none'
    }
    rmSync(file)
    log.info(`Removed ${path}: no runtime dependency of a published package changed anymore.`)
    return 'removed'
  }

  const content = renderChangeset(changed)
  if (content === existing) {
    log.info(`${path} is up to date.`)
    return 'unchanged'
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  log.info(`Wrote ${path}:\n${content}`)
  return 'written'
}

if (import.meta.main) {
  main(async () => {
    const { values } = parseArgs({ options: { pr: { type: 'string' }, base: { type: 'string' } } })
    const pullRequest = Number(values.pr)
    if (!Number.isInteger(pullRequest) || pullRequest < 1) {
      throw new Error('Usage: bun scripts/release/dependabot-changeset.ts --pr <number> [--base origin/main]')
    }
    await syncChangeset({ root: ROOT, base: values.base ?? 'origin/main', pullRequest })
  })
}
