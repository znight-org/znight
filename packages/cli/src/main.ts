/**
 * Entry point of the CLI: global options, command dispatch, help, and error reporting with exit
 * codes (0 ok, 1 failure, 2 usage, 130 cancelled).
 */
import type { Command } from './command.ts'
import type { CliContext, CliContextOptions } from './context.ts'

import { renderCommandHelp, table } from './command.ts'
import { buildCommand } from './commands/build.ts'
import { devCommand } from './commands/dev.ts'
import { generateCommand } from './commands/generate.ts'
import { newCommand } from './commands/new.ts'
import { schematicCommand } from './commands/schematic.ts'
import { startCommand } from './commands/start.ts'
import { createContext } from './context.ts'
import { CancelledError, CliError, ExitCode, errorMessage, UsageError } from './errors.ts'
import { suggest } from './names.ts'

/** Every command, in help order. */
export const COMMANDS: readonly Command[] = [
  newCommand,
  generateCommand,
  schematicCommand,
  devCommand,
  buildCommand,
  startCommand,
]

/** Finds a command by name or alias. */
export function findCommand(name: string): Command | undefined {
  return COMMANDS.find(command => command.meta.name === name || command.meta.aliases?.includes(name) === true)
}

interface GlobalOptions {
  color?: boolean
  debug: boolean
  rest: string[]
}

/** Extracts `--color`, `--no-color` and `--debug` (anywhere before `--`). */
function extractGlobalOptions(argv: readonly string[]): GlobalOptions {
  const separator = argv.indexOf('--')
  const before = separator === -1 ? argv : argv.slice(0, separator)
  const after = separator === -1 ? [] : argv.slice(separator)
  const result: GlobalOptions = { debug: false, rest: [] }
  for (const arg of before) {
    if (arg === '--color') result.color = true
    else if (arg === '--no-color') result.color = false
    else if (arg === '--debug') result.debug = true
    else result.rest.push(arg)
  }
  result.rest.push(...after)
  return result
}

/**
 * Runs the CLI with `argv` (without the executable and script, i.e. `process.argv.slice(2)`).
 * Resolves with the exit code; never throws.
 */
export async function main(argv: readonly string[], options: CliContextOptions = {}): Promise<number> {
  const globals = extractGlobalOptions(argv)
  const cli = createContext({
    ...options,
    ...(globals.color === undefined ? {} : { color: globals.color }),
    ...(globals.debug ? { debug: true } : {}),
  })
  try {
    return await dispatch(globals.rest, cli)
  } catch (error) {
    return reportError(error, cli)
  }
}

async function dispatch(argv: readonly string[], cli: CliContext): Promise<number> {
  const separator = argv.indexOf('--')
  const args = separator === -1 ? [...argv] : argv.slice(0, separator)
  const passthrough = separator === -1 ? [] : argv.slice(separator + 1)
  const [first, ...rest] = args

  if (first === undefined || first === '-h' || first === '--help') {
    cli.reporter.log(renderRootHelp(cli))
    return ExitCode.Ok
  }
  if (first === '-v' || first === '--version' || first === 'version') {
    cli.reporter.log(cli.version)
    return ExitCode.Ok
  }
  if (first === 'help') {
    const target = rest[0] === undefined ? undefined : findCommand(rest[0])
    if (rest[0] !== undefined && target === undefined) throw unknownCommand(rest[0])
    cli.reporter.log(target === undefined ? renderRootHelp(cli) : renderCommandHelp(target, cli.colors))
    return ExitCode.Ok
  }
  if (first.startsWith('-')) {
    throw new UsageError(`Unknown option ${first}`, ['options go after the command: znight <command> [options]'])
  }

  let command = findCommand(first)
  let commandArgs = rest
  // `generate:service user` and `generate service user` are aliases of `g service user`
  if (command === undefined && first.startsWith('generate:')) {
    command = schematicCommand
    commandArgs = [first.slice('generate:'.length), ...rest]
  } else if (command === generateCommand && rest[0] !== undefined && !rest[0].startsWith('-')) {
    command = schematicCommand
  }
  if (command === undefined) throw unknownCommand(first)

  if (commandArgs.includes('-h') || commandArgs.includes('--help')) {
    cli.reporter.log(renderCommandHelp(command, cli.colors))
    return ExitCode.Ok
  }
  try {
    return await command.execute(commandArgs, passthrough, cli)
  } catch (error) {
    if (error instanceof UsageError) {
      throw new UsageError(error.message, [...error.hints, `run "znight ${command.meta.name} --help" for the usage`])
    }
    throw error
  }
}

function unknownCommand(name: string): UsageError {
  const candidate = suggest(
    name,
    COMMANDS.flatMap(command => [command.meta.name, ...(command.meta.aliases ?? [])]),
  )
  return new UsageError(`Unknown command "${name}"`, [
    ...(candidate === undefined ? [] : [`did you mean "znight ${candidate}"?`]),
    'run "znight --help" for the list of commands',
  ])
}

/** The help of `znight` (list of commands). */
export function renderRootHelp(cli: Pick<CliContext, 'colors' | 'version'>): string {
  const { colors } = cli
  const commands = table(
    [
      ['new <name>', newCommand.meta.description],
      ['generate', 'Generate the DI container (--check in CI, --watch)'],
      ['g <schematic> <name>', 'Generate a service, controller, consumer, config, guard, interceptor or factory'],
      ['dev', 'Build in watch mode, restart the application on every change'],
      ['build', buildCommand.meta.description],
      ['start', startCommand.meta.description],
    ],
    colors,
  )
  const options = table(
    [
      ['-h, --help', 'Show the help (also: znight <command> --help)'],
      ['-v, --version', 'Show the version'],
      ['--color, --no-color', 'Force or disable colors (NO_COLOR and FORCE_COLOR are honoured)'],
      ['--debug', 'Print the stack trace of unexpected errors (or ZNIGHT_DEBUG=1)'],
    ],
    colors,
  )
  return [
    `${colors.bold('znight')} ${colors.dim(`v${cli.version}`)} ${colors.dim('—')} compile-time dependency injection for TypeScript`,
    '',
    colors.bold('Usage'),
    `  ${colors.cyan('znight <command> [options]')}`,
    '',
    colors.bold('Commands'),
    ...commands,
    '',
    colors.bold('Global options'),
    ...options,
    '',
    `Run ${colors.cyan('znight <command> --help')} for the options of a command.`,
    '',
  ].join('\n')
}

function reportError(error: unknown, cli: CliContext): number {
  if (error instanceof CancelledError) {
    cli.reporter.warn(error.message)
    return error.exitCode
  }
  if (error instanceof CliError) {
    cli.reporter.error(error.message, error.hints)
    if (cli.debug && error.cause !== undefined) cli.reporter.logError(stackOf(error.cause))
    return error.exitCode
  }
  cli.reporter.error(`Unexpected error: ${errorMessage(error)}`)
  if (cli.debug) cli.reporter.logError(stackOf(error))
  else cli.reporter.logError(cli.colors.dim('  run with --debug (or ZNIGHT_DEBUG=1) for the stack trace'))
  return ExitCode.Failure
}

function stackOf(error: unknown): string {
  return error instanceof Error && error.stack !== undefined ? error.stack : String(error)
}
