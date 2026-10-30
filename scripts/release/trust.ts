/**
 * Configures npm trusted publishing (OIDC) for every publishable package: the release workflow can
 * then publish without any npm token. A package must already exist on npm to be configured, so run
 * this after the first release (see RELEASING.md).
 *
 *   bun scripts/release/trust.ts           # print the `npm trust` commands
 *   bun scripts/release/trust.ts --apply   # run them (npm >= 11.15, logged in, 2FA prompt)
 *
 * Options: --repo (default znight-org/znight), --file (default release.yml), --environment (default npm).
 */
import { parseArgs } from 'node:util'

import { log, main, run, runOrThrow } from './support.ts'
import { publishablePackages, REPOSITORY } from './workspace.ts'

const MIN_NPM_FOR_TRUST = '11.15.0'

main(async () => {
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      repo: { type: 'string', default: REPOSITORY },
      file: { type: 'string', default: 'release.yml' },
      environment: { type: 'string', default: 'npm' },
    },
  })
  const commands = publishablePackages().map(pkg => [
    'trust',
    'github',
    pkg.name,
    '--repo',
    values.repo,
    '--file',
    values.file,
    '--environment',
    values.environment,
    '--allow-publish',
    '--yes',
  ])
  if (!values.apply) {
    log.info('Run these commands (or this script with --apply), logged in to npm with 2FA:\n')
    for (const args of commands) log.info(`npm ${args.join(' ')}`)
    return
  }
  const npmVersion = (await runOrThrow('npm', ['--version'])).stdout.trim()
  if (Bun.semver.order(npmVersion, MIN_NPM_FOR_TRUST) < 0) {
    throw new Error(`npm trust needs npm >= ${MIN_NPM_FOR_TRUST}, found ${npmVersion} (npm install -g npm@latest)`)
  }
  for (const args of commands) {
    log.step(`npm ${args.join(' ')}`)
    const result = await run('npm', args, { inherit: true })
    if (result.code !== 0) throw new Error(`npm trust failed for ${args[2]} (does the package exist on npm yet?)`)
  }
  log.info('\nTrusted publishing configured. Check with `npm trust list <package>`.')
})
