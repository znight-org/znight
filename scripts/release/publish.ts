/**
 * Publishes the packages whose version is not on npm yet: packs every package with `bun pm pack`,
 * verifies the tarballs, then runs `npm publish <tarball>` in dependency order. Idempotent: after a
 * partial failure, re-running publishes what is left.
 *
 *   bun run release              # build, then publish (the release workflow does this)
 *   bun run release --dry-run    # build, pack, verify and `npm publish --dry-run`: nothing is uploaded
 *
 * Options:
 *   --dry-run                     do not publish (`npm publish --dry-run`)
 *   --provenance auto|true|false  npm provenance attestations (default: auto, see below)
 *   --tag <dist-tag>              default: `latest`, `next` for prerelease versions
 *   --out <dir>                   keep the tarballs in <dir> (default: a temporary directory)
 *   --verbose                     print the npm output of every package
 *
 * Authentication:
 *   - `NPM_TOKEN`: an npm granular access token (in the release workflow, the secret of the `npm`
 *     environment, see RELEASING.md). Required in GitHub Actions, except for a dry run.
 *   - Otherwise, outside GitHub Actions: the local npm login (`npm login`).
 *
 * Provenance (`auto`): on only in GitHub Actions, with an OIDC token, for a PUBLIC repository (the
 * workflow passes `ZNIGHT_REPOSITORY_VISIBILITY`): npm cannot attest packages built from private
 * repositories. `--provenance true` in a private repository warns and publishes without it.
 */
import type { WorkspacePackage } from './workspace.ts'

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { highestVersion, publishedVersions, REGISTRY } from './registry.ts'
import { inGitHubActions, log, main, run, runOrThrow, setOutput, summary } from './support.ts'
import { packAndVerify, reportPacked } from './tarball.ts'
import { distTagFor, lockstepVersion, pendingChangesets, publishablePackages } from './workspace.ts'

const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

interface Authentication {
  readonly mode: 'token' | 'local'
  readonly description: string
  /** Environment of the `npm publish` processes. */
  readonly env: Readonly<Record<string, string>>
}

/** Picks the authentication method (see the header) and checks it can work. */
async function authenticate(workDir: string, dryRun: boolean): Promise<Authentication> {
  if (process.env['NPM_TOKEN']) {
    // a dedicated npmrc: npm expands ${NPM_TOKEN} itself, the token is never written to disk
    const npmrc = join(workDir, 'npmrc')
    writeFileSync(npmrc, `${REGISTRY.replace(/^https?:/, '')}/:_authToken=\${NPM_TOKEN}\n`)
    return { mode: 'token', description: 'NPM_TOKEN', env: { NPM_CONFIG_USERCONFIG: npmrc } }
  }
  if (inGitHubActions && !dryRun) {
    throw new Error(
      'No npm credentials: set the NPM_TOKEN secret of the `npm` environment (an npm granular access token, see RELEASING.md)',
    )
  }
  if (!dryRun) {
    const whoami = await run('npm', ['whoami', ...registryArgs()])
    if (whoami.code !== 0) throw new Error('Not logged in to npm: run `npm login` first (or set NPM_TOKEN)')
    return { mode: 'local', description: `local npm login (${whoami.stdout.trim()})`, env: {} }
  }
  return { mode: 'local', description: 'local npm configuration', env: {} }
}

async function logNpmVersion(): Promise<void> {
  log.info(`npm ${(await runOrThrow('npm', ['--version'])).stdout.trim()}`)
}

/** Whether to ask npm for provenance attestations (see the header). */
function provenanceFor(setting: string): boolean {
  if (setting === 'false') return false
  const requested = setting === 'true'
  if (!inGitHubActions || !process.env['ACTIONS_ID_TOKEN_REQUEST_URL']) {
    if (requested)
      log.warn('Provenance needs GitHub Actions with `permissions: id-token: write`: publishing without it')
    return false
  }
  const visibility = process.env['ZNIGHT_REPOSITORY_VISIBILITY']
  if (visibility !== 'public') {
    log.warn(
      `Provenance disabled: the repository is ${visibility ?? 'of unknown visibility (ZNIGHT_REPOSITORY_VISIBILITY is not set)'}. ` +
        'npm only attests packages built from public repositories; it turns on by itself once the repository is public.',
    )
    return false
  }
  return true
}

const registryArgs = (): string[] => (REGISTRY === DEFAULT_REGISTRY ? [] : ['--registry', REGISTRY])

/** The packages of `packages` whose `version` is not on the registry, in the same (dependency) order. */
async function unpublished(packages: readonly WorkspacePackage[], version: string, tag: string) {
  const missing: WorkspacePackage[] = []
  for (const pkg of packages) {
    const versions = await publishedVersions(pkg.name)
    if (versions.has(version)) {
      log.info(`  ${pkg.name}@${version}: already on npm`)
      continue
    }
    const highest = highestVersion(versions)
    if (tag === 'latest' && highest !== undefined && Bun.semver.order(highest, version) > 0) {
      throw new Error(
        `${pkg.name}: npm already has ${highest} > ${version}; refusing to move "latest" back (use --tag)`,
      )
    }
    log.info(`  ${pkg.name}@${version}: to publish${highest === undefined ? ' (new package)' : ''}`)
    missing.push(pkg)
  }
  return missing
}

main(async () => {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      provenance: { type: 'string', default: 'auto' },
      tag: { type: 'string' },
      out: { type: 'string' },
      verbose: { type: 'boolean', default: false },
    },
  })
  const dryRun = values['dry-run']
  if (!['auto', 'true', 'false'].includes(values.provenance)) {
    throw new Error(`--provenance must be auto, true or false (got ${values.provenance})`)
  }

  const packages = publishablePackages()
  const version = lockstepVersion(packages)
  const tag = values.tag ?? distTagFor(version)
  const pending = pendingChangesets()
  if (pending.length > 0) {
    const message = `Pending changesets (${pending.join(', ')}): merge the "chore: version packages" pull request (or run \`bun run version\`) before publishing`
    if (!dryRun) throw new Error(message)
    log.warn(message)
  }

  log.step(`Checking ${REGISTRY} for ${version}`)
  const toPublish = await unpublished(packages, version, tag)

  const workDir = mkdtempSync(join(tmpdir(), 'znight-release-'))
  const outDir = values.out === undefined ? join(workDir, 'tarballs') : resolve(values.out)
  try {
    // every package is packed and verified, published or not: the release is checked as a whole
    log.step(`Packing and verifying ${packages.length} packages`)
    const packed = await packAndVerify(packages, outDir, { missingReadme: 'error' })
    const errors = reportPacked(packed)
    if (errors > 0) throw new Error(`${errors} problem(s) found in the tarballs: nothing was published`)

    setOutput('version', version)
    if (toPublish.length === 0) {
      log.info(`\nNothing to publish: every package is already on npm at ${version}.`)
      setOutput('published', '[]')
      return
    }

    const auth = await authenticate(workDir, dryRun)
    await logNpmVersion()
    const provenance = provenanceFor(values.provenance)
    log.step(
      `${dryRun ? '[dry run] ' : ''}Publishing ${toPublish.length} package(s) at ${version}: dist-tag ${tag}, ` +
        `${auth.description}, provenance ${provenance ? 'on' : 'off'}`,
    )
    const published: string[] = []
    for (const pkg of toPublish) {
      const tarball = packed.find(item => item.pkg.name === pkg.name)?.tarball
      if (tarball === undefined) throw new Error(`no tarball for ${pkg.name}`)
      const args = ['publish', tarball, '--access', 'public', '--tag', tag, ...registryArgs()]
      args.push(provenance ? '--provenance' : '--no-provenance')
      if (dryRun) args.push('--dry-run')
      const result = await run('npm', args, { env: auth.env })
      const output = `${result.stdout}${result.stderr}`
      if (result.code !== 0) {
        if (/EPUBLISHCONFLICT|cannot publish over|previously published/i.test(output)) {
          log.warn(`${pkg.name}@${version} is already on npm (published meanwhile): skipped`)
          continue
        }
        log.block(`npm publish ${pkg.name}@${version}`, output)
        throw new Error(
          `npm publish failed for ${pkg.name}@${version}. Published so far: ${published.join(', ') || 'none'}. ` +
            'Fix the cause and re-run: packages already on npm are skipped.',
        )
      }
      if (values.verbose || inGitHubActions) log.block(`npm publish ${pkg.name}@${version}`, output)
      log.info(`  ✔ ${pkg.name}@${version}${dryRun ? ' (dry run)' : ''}`)
      published.push(`${pkg.name}@${version}`)
    }

    setOutput('published', JSON.stringify(dryRun ? [] : published))
    summary(
      [
        `### ${dryRun ? 'Dry run: would publish' : 'Published'} ${published.length} package(s)`,
        '',
        ...published.map(name => `- \`${name}\` (dist-tag \`${tag}\`)`),
        '',
        `Authentication: ${auth.description}. Provenance: ${provenance ? 'on' : 'off'}.`,
        '',
      ].join('\n'),
    )
    log.info(`\n${dryRun ? 'Dry run complete: nothing was published.' : `Published ${published.length} package(s).`}`)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
})
