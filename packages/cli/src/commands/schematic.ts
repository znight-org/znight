/** `znight g <schematic> <name>`: generates a service, controller, consumer, config, guard, interceptor or factory. */
import type { Command } from '../command.ts'
import type { Colors } from '../output.ts'

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { defineCommand, table } from '../command.ts'
import { CliError, UsageError } from '../errors.ts'
import { suggest } from '../names.ts'
import { findSchematic, planSchematic, SCHEMATICS } from '../schematics/index.ts'
import { displayPath, findProjectRoot, readManifest, resolveRoot } from './shared.ts'

function schematicList(colors: Colors): string {
  return table(
    SCHEMATICS.map(
      schematic => [`${schematic.name} (${schematic.aliases.join(', ')})`, schematic.description] as const,
    ),
    colors,
  ).join('\n')
}

/** `znight g` */
export const schematicCommand: Command = defineCommand({
  meta: {
    name: 'g',
    description: 'Generate a service, controller, consumer, config, guard, interceptor or factory',
    usage: '<schematic> <name> [options]',
    aliases: ['generate <schematic>'],
    details: colors =>
      `${colors.bold('Schematics')}\n${schematicList(colors)}\n\nFiles are named <name>.<schematic>.ts (kebab-case), classes <Name><Schematic> (PascalCase).`,
    examples: [
      'znight g service users/user           # src/users/user.service.ts (UserService)',
      'znight g controller order             # src/order/order.controller.ts (OrderController)',
      'znight g guard auth --flat            # src/auth.guard.ts (AuthGuard)',
      'znight g interceptor timing --aop     # a method interceptor (@Intercept)',
      'znight g consumer orders --path src/messaging',
    ],
  },
  args: {
    schematic: { type: 'positional', required: false, description: 'What to generate (see Schematics below)' },
    name: {
      type: 'positional',
      required: false,
      description: 'Name, optionally prefixed with directories relative to src/ (users/user-profile)',
    },
    path: { type: 'string', valueHint: 'dir', description: 'Directory of the file (default: src/<name>/)' },
    flat: { type: 'boolean', description: 'Do not create a directory named after the element' },
    force: { type: 'boolean', alias: 'f', description: 'Overwrite an existing file' },
    'dry-run': { type: 'boolean', alias: 'd', description: 'Print the file instead of writing it' },
    aop: { type: 'boolean', description: 'interceptor: a method interceptor (@Intercept) instead of an HTTP one' },
    root: { type: 'string', valueHint: 'dir', description: 'Project root (default: the nearest package.json)' },
  },
  run({ args, cli }) {
    if (args.schematic === undefined || args.schematic === '') {
      throw new UsageError('Missing <schematic>', [`available schematics:\n${schematicList(cli.colors)}`])
    }
    const schematic = findSchematic(args.schematic)
    if (schematic === undefined) {
      const candidate = suggest(
        args.schematic,
        SCHEMATICS.map(item => item.name),
      )
      throw new UsageError(`Unknown schematic "${args.schematic}"`, [
        ...(candidate === undefined ? [] : [`did you mean "${candidate}"?`]),
        `available schematics: ${SCHEMATICS.map(item => item.name).join(', ')}`,
      ])
    }
    if (args.name === undefined || args.name === '') {
      throw new UsageError('Missing <name>', [
        `znight g ${schematic.name} <name>, e.g. znight g ${schematic.name} users/user`,
      ])
    }
    const root = args.root === undefined ? findProjectRoot(cli.cwd) : resolveRoot(cli, args.root)
    const manifest = readManifest(root)
    const zod = manifest.dependencies?.zod !== undefined || manifest.devDependencies?.zod !== undefined
    let plan: ReturnType<typeof planSchematic>
    try {
      plan = planSchematic({
        schematic,
        name: args.name,
        root,
        path: args.path === undefined ? undefined : resolve(cli.cwd, args.path),
        flat: args.flat === true,
        context: { zod, aop: args.aop === true },
      })
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error))
    }
    const file = displayPath(plan.file, cli.cwd)
    if (args['dry-run'] === true) {
      cli.reporter.info(`Would create ${cli.colors.bold(file)} (${plan.names.className})`)
      cli.reporter.log()
      cli.reporter.log(plan.content)
      return 0
    }
    const exists = existsSync(plan.file)
    if (exists && args.force !== true) {
      throw new CliError(`${file} already exists`, { hints: ['pass --force to overwrite it'] })
    }
    mkdirSync(dirname(plan.file), { recursive: true })
    writeFileSync(plan.file, plan.content)
    cli.reporter.success(
      `${exists ? 'Overwrote' : 'Created'} ${cli.colors.bold(file)} ${cli.colors.dim(`(${plan.names.className})`)}`,
    )
    if (plan.hint !== undefined) cli.reporter.log(`  ${cli.colors.dim(plan.hint)}`)
    return 0
  },
})
