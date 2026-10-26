/**
 * A small command layer over citty's argument parser: strict options (unknown options and extra
 * arguments are usage errors, with suggestions), `--` pass-through arguments and help rendering
 * that honours the color settings.
 */
import type { ArgDef, ArgsDef, ParsedArgs } from 'citty'
import type { CliContext } from './context.ts'
import type { Colors } from './output.ts'

import { parseArgs } from 'citty'

import { UsageError } from './errors.ts'
import { camelCase, kebabCase, suggest } from './names.ts'
import { stripAnsi } from './output.ts'

/** What a command receives. */
export interface CommandRunContext<A extends ArgsDef = ArgsDef> {
  readonly args: ParsedArgs<A>
  readonly cli: CliContext
  /** Arguments of the command as typed (before `--`). */
  readonly rawArgs: readonly string[]
  /** Arguments after `--` (forwarded to the application by `dev` and `start`). */
  readonly passthrough: readonly string[]
}

/** Whether an option was explicitly given (`--install`, `--no-install`, `--install=false`). */
export function hasFlag(rawArgs: readonly string[], name: string): boolean {
  return rawArgs.some(
    arg =>
      arg === `--${name}` || arg === `--no-${name}` || arg.startsWith(`--${name}=`) || arg.startsWith(`--no-${name}=`),
  )
}

/** Description of a command. */
export interface CommandMeta {
  readonly name: string
  readonly description: string
  readonly aliases?: readonly string[]
  /** Usage line after `znight <name>` (default: computed from the arguments). */
  readonly usage?: string
  readonly examples?: readonly string[]
  /** Extra help paragraph printed after the options. */
  readonly details?: string | ((colors: Colors) => string)
}

/** Definition of a command: typed arguments and the implementation. */
export interface CommandDefinition<A extends ArgsDef> {
  readonly meta: CommandMeta
  readonly args: A
  /** Runs the command; the returned number is the exit code (default 0). */
  run(context: CommandRunContext<A>): number | undefined | Promise<number | undefined>
}

/** A CLI command, ready to execute. */
export interface Command {
  readonly meta: CommandMeta
  readonly args: ArgsDef
  /**
   * Parses `argv` (the arguments after the command name, without `--` pass-through arguments) and
   * runs the command. Resolves with the exit code.
   */
  execute(argv: readonly string[], passthrough: readonly string[], cli: CliContext): Promise<number>
}

/** Creates a {@link Command}; `args` keep their literal types in `run`. */
export function defineCommand<const A extends ArgsDef>(definition: CommandDefinition<A>): Command {
  return {
    meta: definition.meta,
    args: definition.args,
    execute: async (argv, passthrough, cli) => {
      const args = parseCommandArgs(definition, argv)
      return (await definition.run({ args, cli, rawArgs: argv, passthrough })) ?? 0
    },
  }
}

/** Parses `argv` (without the command name and without `--` pass-through) for `command`. */
export function parseCommandArgs<A extends ArgsDef>(
  command: Pick<CommandDefinition<A>, 'args'>,
  argv: readonly string[],
): ParsedArgs<A> {
  checkOptions(command, argv)
  let parsed: ParsedArgs<A>
  try {
    parsed = parseArgs<A>([...argv], command.args)
  } catch (error) {
    throw new UsageError(stripAnsi(error instanceof Error ? error.message : String(error)))
  }
  const positionals = Object.values(command.args).filter(arg => arg.type === 'positional').length
  const extra = parsed._.slice(positionals)
  if (extra.length > 0) {
    throw new UsageError(`Unexpected argument${extra.length > 1 ? 's' : ''}: ${extra.join(' ')}`)
  }
  return parsed
}

interface OptionInfo {
  readonly type: ArgDef['type']
}

function optionTable(args: ArgsDef): Map<string, OptionInfo> {
  const table = new Map<string, OptionInfo>([
    ['help', { type: 'boolean' }],
    ['h', { type: 'boolean' }],
  ])
  for (const [name, def] of Object.entries(args)) {
    if (def.type === 'positional') continue
    const info: OptionInfo = { type: def.type }
    for (const key of [name, kebabCase(name), camelCase(name), ...aliasesOf(def)]) table.set(key, info)
  }
  return table
}

function aliasesOf(def: ArgDef): string[] {
  if (!('alias' in def) || def.alias === undefined) return []
  return Array.isArray(def.alias) ? [...def.alias] : [def.alias]
}

function checkOptions(command: Pick<Command, 'args'>, argv: readonly string[]): void {
  const table = optionTable(command.args)
  const longNames = [...table.keys()].filter(name => name.length > 1)
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index] ?? ''
    if (!token.startsWith('-') || token === '-') continue
    if (token.startsWith('--')) {
      const [rawName = '', inlineValue] = token.slice(2).split(/=(.*)/s, 2)
      let info = table.get(rawName)
      if (info === undefined && rawName.startsWith('no-')) {
        const negated = table.get(rawName.slice(3))
        if (negated?.type === 'boolean') info = negated
      }
      if (info === undefined) {
        const candidate = suggest(rawName, longNames)
        throw new UsageError(
          `Unknown option --${rawName}`,
          candidate === undefined ? [] : [`did you mean --${candidate}?`],
        )
      }
      if ((info.type === 'string' || info.type === 'enum') && inlineValue === undefined) index++
      continue
    }
    // short options: -y, -f, or a group of boolean flags (-yf)
    const letters = token.slice(1)
    for (const [position, letter] of [...letters].entries()) {
      const info = table.get(letter)
      if (info === undefined) throw new UsageError(`Unknown option -${letter}`)
      if ((info.type === 'string' || info.type === 'enum') && position === letters.length - 1) index++
    }
  }
}

/** Formats the help of a command. */
export function renderCommandHelp(command: Pick<Command, 'meta' | 'args'>, colors: Colors): string {
  const { meta } = command
  const entries = Object.entries(command.args)
  const positionals = entries.filter(([, def]) => def.type === 'positional')
  const options = entries.filter(([, def]) => def.type !== 'positional')
  const usage =
    meta.usage ??
    [
      ...positionals.map(([name, def]) =>
        def.required === false || def.default !== undefined ? `[${name}]` : `<${name}>`,
      ),
      options.length > 0 ? '[options]' : '',
    ]
      .filter(Boolean)
      .join(' ')
  const lines = [`${colors.bold(`znight ${meta.name}`)} ${colors.dim('—')} ${meta.description}`, '']
  lines.push(colors.bold('Usage'), `  ${colors.cyan(`znight ${meta.name}${usage === '' ? '' : ` ${usage}`}`)}`, '')
  if (meta.aliases !== undefined && meta.aliases.length > 0) {
    lines.push(colors.bold('Aliases'), `  ${meta.aliases.join(', ')}`, '')
  }
  if (positionals.length > 0) {
    lines.push(colors.bold('Arguments'))
    lines.push(
      ...table(
        positionals.map(([name, def]) => [name, def.description ?? ''] as const),
        colors,
      ),
    )
    lines.push('')
  }
  const optionRows = options.map(([name, def]) => [optionLabel(name, def), describeOption(def)] as const)
  optionRows.push(['-h, --help', 'Show this help'])
  lines.push(colors.bold('Options'), ...table(optionRows, colors), '')
  if (meta.details !== undefined) {
    lines.push(typeof meta.details === 'function' ? meta.details(colors) : meta.details, '')
  }
  if (meta.examples !== undefined && meta.examples.length > 0) {
    lines.push(colors.bold('Examples'), ...meta.examples.map(example => `  ${colors.dim('$')} ${example}`), '')
  }
  return lines.join('\n')
}

function optionLabel(name: string, def: ArgDef): string {
  const short = aliasesOf(def)
    .filter(alias => alias.length === 1)
    .map(alias => `-${alias}, `)
    .join('')
  const flag = def.type === 'boolean' && def.default === true ? `--no-${name}` : `--${name}`
  let value = ''
  if (def.type === 'enum') value = ` <${(def.options ?? []).join('|')}>`
  else if (def.type === 'string') value = ` <${def.valueHint ?? name}>`
  return `${short}${flag}${value}`
}

function describeOption(def: ArgDef): string {
  const description = def.description ?? ''
  if (def.type === 'boolean') return description
  return def.default === undefined || def.default === '' ? description : `${description} (default: ${def.default})`
}

/** Two aligned columns. */
export function table(rows: readonly (readonly [string, string])[], colors: Colors): string[] {
  const width = Math.max(0, ...rows.map(([left]) => left.length))
  return rows.map(([left, right]) => `  ${colors.cyan(left.padEnd(width))}  ${right}`.trimEnd())
}
