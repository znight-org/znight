/**
 * Release status: the lockstep version, the pending changesets and the packages whose version is
 * not on npm yet. Used by the release workflow to decide whether there is something to publish.
 *
 *   bun scripts/release/status.ts
 *
 * Step outputs (GitHub Actions): `version`, `pending-changesets` (true/false), `unpublished` (JSON
 * array of package names) and `publishable` (true when there is no pending changeset and at least
 * one package to publish).
 */
import { highestVersion, publishedVersions } from './registry.ts'
import { log, main, setOutput, summary } from './support.ts'
import { lockstepVersion, pendingChangesets, publishablePackages } from './workspace.ts'

main(async () => {
  const packages = publishablePackages()
  const version = lockstepVersion(packages)
  const pending = pendingChangesets()
  const registry = await Promise.all(packages.map(async pkg => ({ pkg, versions: await publishedVersions(pkg.name) })))
  const unpublished = registry.filter(({ versions }) => !versions.has(version)).map(({ pkg }) => pkg.name)
  const publishable = pending.length === 0 && unpublished.length > 0

  log.info(`Version: ${version} (${packages.length} packages, released in lockstep)`)
  for (const { pkg, versions } of registry) {
    const latest = highestVersion(versions)
    const state = versions.has(version) ? 'published' : 'NOT published'
    log.info(`  ${pkg.name}@${version}: ${state}${latest === undefined ? ' (new package)' : ` (npm: ${latest})`}`)
  }
  if (pending.length > 0) {
    log.info(`Pending changesets (${pending.length}): ${pending.join(', ')}`)
    log.info('→ the "chore: version packages" pull request must be merged before publishing.')
  }
  log.info(publishable ? `→ ready to publish ${unpublished.length} package(s).` : '→ nothing to publish.')

  setOutput('version', version)
  setOutput('pending-changesets', String(pending.length > 0))
  setOutput('unpublished', JSON.stringify(unpublished))
  setOutput('publishable', String(publishable))
  summary(
    [
      '### Release status',
      '',
      `- Version: \`${version}\``,
      `- Pending changesets: ${pending.length}`,
      `- Not on npm yet: ${unpublished.length === 0 ? 'none' : unpublished.map(name => `\`${name}\``).join(', ')}`,
      `- Publishable now: **${publishable ? 'yes' : 'no'}**`,
      '',
    ].join('\n'),
  )
})
