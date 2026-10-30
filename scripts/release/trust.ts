/**
 * Configures npm trusted publishing (OIDC) for the publishable packages: the release workflow then
 * publishes without any npm token. A package must already exist on npm to be configured (a new one
 * has its name reserved first), and a trusted publisher that publishes nothing within 48 hours
 * expires: run this at most two days before a release (see RELEASING.md, npm setup).
 *
 *   bun scripts/release/trust.ts                                # print the npm commands
 *   bun scripts/release/trust.ts --apply                        # run them (npm >= 11.15, logged in)
 *   bun scripts/release/trust.ts --apply --disallow-tokens      # and refuse token publishing
 *   bun scripts/release/trust.ts --apply --package @znight/xyz  # only this package (repeatable)
 *
 * npm asks for two-factor authentication (a one-time password, or the browser), so `--apply` runs in
 * a terminal. On the first npm page, check "skip two-factor authentication for the next 5 minutes":
 * the next `npm trust` commands then run without asking. The script waits 2 seconds between
 * commands, as npm recommends for bulk changes. `--disallow-tokens` sets the publishing access of
 * each package to "Require two-factor authentication and disallow tokens" (`npm access set
 * mfa=publish`): trusted publishing keeps working, a leaked token cannot publish.
 *
 * Options: --repo (default znight-org/znight), --file (default release.yml), --environment (default npm).
 */
import { parseArgs } from 'node:util'

import { log, main, run, runOrThrow } from './support.ts'
import { publishablePackages, REPOSITORY } from './workspace.ts'

const MIN_NPM_FOR_TRUST = '11.15.0'
/** Pause between npm commands: npm's advice for bulk trust changes, against rate limiting. */
const BULK_DELAY_MS = 2000

main(async () => {
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      'disallow-tokens': { type: 'boolean', default: false },
      package: { type: 'string', multiple: true },
      repo: { type: 'string', default: REPOSITORY },
      file: { type: 'string', default: 'release.yml' },
      environment: { type: 'string', default: 'npm' },
    },
  })
  const publishable = publishablePackages().map(pkg => pkg.name)
  const names = values.package ?? publishable
  const unknown = names.filter(name => !publishable.includes(name))
  if (unknown.length > 0) throw new Error(`Not a publishable package: ${unknown.join(', ')}`)

  // per package: the trusted publisher, then (optionally) no more token publishing
  const plans = names.map(name => ({
    name,
    commands: [
      [
        'trust',
        'github',
        name,
        '--repo',
        values.repo,
        '--file',
        values.file,
        '--environment',
        values.environment,
        '--allow-publish',
        '--yes',
      ],
      ...(values['disallow-tokens'] ? [['access', 'set', 'mfa=publish', name]] : []),
    ],
  }))
  if (!values.apply) {
    log.info('Run these commands (or this script with --apply), logged in to npm with 2FA:\n')
    for (const { commands } of plans) for (const args of commands) log.info(`npm ${args.join(' ')}`)
    return
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('npm asks for two-factor authentication: run --apply in a terminal')
  }
  const npmVersion = (await runOrThrow('npm', ['--version'])).stdout.trim()
  if (Bun.semver.order(npmVersion, MIN_NPM_FOR_TRUST) < 0) {
    throw new Error(`npm trust needs npm >= ${MIN_NPM_FOR_TRUST}, found ${npmVersion} (npm install -g npm@latest)`)
  }

  log.info('On the first npm page, check "skip two-factor authentication for the next 5 minutes".')
  const failed: string[] = []
  let first = true
  for (const { name, commands } of plans) {
    for (const args of commands) {
      if (!first) await Bun.sleep(BULK_DELAY_MS)
      first = false
      log.step(`npm ${args.join(' ')}`)
      // the terminal is npm's: it prompts for the one-time password or opens the browser
      const result = await run('npm', args, { inherit: true })
      if (result.code !== 0) {
        failed.push(name) // the next command of this package is skipped
        break
      }
    }
  }
  if (failed.length > 0) {
    throw new Error(
      `Failed for ${failed.join(', ')}: does the package exist on npm, and has it no trusted publisher yet ` +
        '(`npm trust list <package>`)? Run again with --package for these ones.',
    )
  }
  log.info('\nDone. Check with `npm trust list <package>` (and `npm access get status <package>`).')
})
