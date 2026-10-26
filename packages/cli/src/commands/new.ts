/** `znight new <name>`: scaffolds a project, interactively or from flags. */
import type { Command } from '../command.ts'
import type { CliContext } from '../context.ts'
import type { Prompts } from '../integrations/prompts.ts'
import type { Feature, HttpAdapterName, PackageManager } from '../scaffold/options.ts'

import { basename, resolve } from 'node:path'

import { defineCommand, hasFlag } from '../command.ts'
import { CliError, UsageError } from '../errors.ts'
import { toPackageName, unscopedName, validatePackageName } from '../names.ts'
import { initGit, installDependencies, targetState, writeProject } from '../scaffold/create.ts'
import {
  ADAPTER_LABELS,
  DEFAULT_FEATURES,
  detectPackageManager,
  FEATURE_LABELS,
  FEATURES,
  HTTP_ADAPTERS,
  installCommand,
  PACKAGE_MANAGERS,
  parseFeatures,
  runScript,
} from '../scaffold/options.ts'
import { renderProject } from '../scaffold/templates.ts'
import { displayPath } from './shared.ts'

/** `znight new` */
export const newCommand: Command = defineCommand({
  meta: {
    name: 'new',
    description: 'Create a new Znight project',
    usage: '[name] [options]',
    aliases: ['create', 'init'],
    examples: [
      'znight new my-service',
      'znight new my-service --yes --pm pnpm --adapter fastify --features config,observability,messaging',
      'znight new . --yes --no-install',
    ],
  },
  args: {
    name: {
      type: 'positional',
      required: false,
      description: 'Project name (npm package name), or "." for the current directory',
    },
    yes: { type: 'boolean', alias: 'y', description: 'Do not ask questions: use the flags and the defaults' },
    pm: {
      type: 'enum',
      options: ['bun', 'npm', 'pnpm', 'yarn'],
      description: 'Package manager (default: the one running the CLI, bun under Bun, else npm)',
    },
    adapter: {
      type: 'enum',
      options: ['node', 'fastify', 'express', 'hono'],
      description: 'HTTP adapter (default: node, the built-in node:http server)',
    },
    features: {
      type: 'string',
      valueHint: 'list',
      description:
        'Comma-separated features: config, observability, messaging, or "all" / "none" (default: config,observability)',
    },
    install: { type: 'boolean', default: true, description: 'Do not install the dependencies' },
    git: { type: 'boolean', default: true, description: 'Do not initialise a git repository' },
    dir: { type: 'string', valueHint: 'path', description: 'Target directory (default: ./<name>)' },
    force: { type: 'boolean', description: 'Write into a non-empty directory (existing files are overwritten)' },
  },
  async run({ args: options, cli, rawArgs }) {
    const interactive = cli.interactive && options.yes !== true
    const prompts = interactive ? await cli.services.loadPrompts() : undefined
    prompts?.intro(cli.colors.bold(`Create a Znight project ${cli.colors.dim(`v${cli.version}`)}`))

    // name and directory
    let name = options.name
    if (name === undefined || name === '') {
      if (prompts === undefined) {
        throw new UsageError('Missing project name', ['znight new <name> (or "." to use the current directory)'])
      }
      name = await prompts.text({
        message: 'Project name?',
        placeholder: 'my-service',
        validate: value => (value === '.' ? undefined : validatePackageName(value.trim())),
      })
    }
    name = name.trim()
    const inPlace = name === '.'
    if (inPlace) name = toPackageName(basename(cli.cwd))
    const problem = validatePackageName(name)
    if (problem !== undefined) {
      const candidate = toPackageName(name)
      throw new UsageError(
        `Invalid project name "${name}": ${problem}`,
        candidate !== '' && validatePackageName(candidate) === undefined ? [`try "${candidate}"`] : [],
      )
    }
    const directory = resolve(cli.cwd, options.dir ?? (inPlace ? '.' : unscopedName(name)))
    await checkTarget(directory, cli, prompts, options.force === true)

    // choices
    const packageManager: PackageManager =
      options.pm ??
      (await prompts?.select({
        message: 'Package manager?',
        choices: PACKAGE_MANAGERS.map(pm => ({ value: pm, label: pm })),
        initialValue: detectPackageManager(cli.env, cli.runtime.name === 'bun'),
      })) ??
      detectPackageManager(cli.env, cli.runtime.name === 'bun')
    const adapter: HttpAdapterName =
      options.adapter ??
      (await prompts?.select({
        message: 'HTTP adapter?',
        choices: HTTP_ADAPTERS.map(value => ({ value, label: ADAPTER_LABELS[value] })),
        initialValue: 'node',
      })) ??
      'node'
    const features = await chooseFeatures(options.features, prompts)
    const install =
      prompts === undefined || hasFlag(rawArgs, 'install')
        ? options.install !== false
        : await prompts.confirm({ message: `Install the dependencies with ${packageManager}?`, initialValue: true })
    const git =
      prompts === undefined || hasFlag(rawArgs, 'git')
        ? options.git !== false
        : await prompts.confirm({ message: 'Initialise a git repository?', initialValue: true })

    // files
    const files = renderProject({ name, packageManager, adapter, features, znightVersion: cli.version })
    writeProject(directory, files)
    const where = displayPath(directory, cli.cwd)
    const summary = `${cli.colors.bold(name)} (${packageManager}, ${adapter}${features.length > 0 ? `, ${features.join(', ')}` : ''})`
    if (prompts === undefined) cli.reporter.success(`Created ${summary} in ${where}`)
    else prompts.note(files.map(file => file.path).join('\n'), `Created ${summary} in ${where}`)

    if (git) await runGit(directory, cli, prompts)
    let installed = false
    if (install) installed = await runInstall(directory, packageManager, cli, prompts)

    // next steps
    const steps = [
      ...(inPlace && options.dir === undefined ? [] : [`cd ${where}`]),
      ...(installed ? [] : [installCommand(packageManager).join(' ')]),
      runScript(packageManager, 'dev'),
    ]
    if (prompts === undefined) {
      cli.reporter.log()
      cli.reporter.log(cli.colors.bold('Next steps:'))
      for (const step of steps) cli.reporter.log(`  ${cli.colors.cyan(step)}`)
      cli.reporter.log()
    } else {
      prompts.outro(`Next steps:\n${steps.map(step => `   ${cli.colors.cyan(step)}`).join('\n')}`)
    }
    if (install && !installed) {
      throw new CliError('The project was created but installing the dependencies failed', {
        hints: [`run "${installCommand(packageManager).join(' ')}" in ${where}`],
      })
    }
    return 0
  },
})

async function checkTarget(
  directory: string,
  cli: CliContext,
  prompts: Prompts | undefined,
  force: boolean,
): Promise<void> {
  const state = targetState(directory)
  const where = displayPath(directory, cli.cwd)
  if (state === 'file') throw new CliError(`${where} exists and is not a directory`)
  if (state !== 'not-empty' || force) return
  if (prompts !== undefined) {
    const proceed = await prompts.confirm({
      message: `${where} is not empty. Write the project into it anyway (existing files are overwritten)?`,
      initialValue: false,
    })
    if (proceed) return
  }
  throw new CliError(`${where} is not empty`, {
    hints: ['choose another name or --dir, or pass --force to write into it anyway'],
  })
}

async function chooseFeatures(value: string | undefined, prompts: Prompts | undefined): Promise<Feature[]> {
  if (value !== undefined) {
    const parsed = parseFeatures(value)
    if ('unknown' in parsed) {
      throw new UsageError(`Unknown feature${parsed.unknown.length > 1 ? 's' : ''}: ${parsed.unknown.join(', ')}`, [
        `available features: ${FEATURES.join(', ')} (or "all", "none")`,
      ])
    }
    return parsed.features
  }
  if (prompts === undefined) return [...DEFAULT_FEATURES]
  const selected = await prompts.multiselect({
    message: 'Features? (space to toggle)',
    choices: FEATURES.map(feature => ({ value: feature, label: FEATURE_LABELS[feature] })),
    initialValues: DEFAULT_FEATURES,
  })
  return FEATURES.filter(feature => selected.includes(feature))
}

async function runGit(directory: string, cli: CliContext, prompts: Prompts | undefined): Promise<void> {
  const outcome = await initGit(cli.services.processes, directory, cli.env)
  const message = {
    initialized: 'Initialised a git repository',
    'inside-repository': 'Already inside a git repository: skipped git init',
    unavailable: 'git is not available: skipped git init',
    failed: 'git init failed: skipped',
  }[outcome]
  if (outcome === 'initialized') {
    if (prompts === undefined) cli.reporter.success(message)
  } else {
    cli.reporter.warn(message)
  }
}

async function runInstall(
  directory: string,
  packageManager: PackageManager,
  cli: CliContext,
  prompts: Prompts | undefined,
): Promise<boolean> {
  const command = installCommand(packageManager).join(' ')
  const spinner = prompts?.spinner()
  if (spinner === undefined) cli.reporter.info(`Installing the dependencies (${command})...`)
  else spinner.start(`Installing the dependencies (${command})`)
  const result = await installDependencies(cli.services.processes, directory, packageManager, cli.env)
  const ok = result.code === 0 && result.error === undefined
  if (ok) {
    if (spinner === undefined) cli.reporter.success('Installed the dependencies')
    else spinner.stop('Installed the dependencies')
    return true
  }
  const reason =
    result.error === undefined
      ? `${command} exited with code ${result.code ?? result.signal}`
      : `${packageManager} could not be started (${result.error.message})`
  if (spinner === undefined) cli.reporter.error(reason)
  else spinner.stop(reason, true)
  const output = `${result.stdout}${result.stderr}`.trim()
  if (output !== '') cli.reporter.logError(output.split('\n').slice(-30).join('\n'))
  return false
}
