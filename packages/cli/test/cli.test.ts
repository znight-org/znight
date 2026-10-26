import { parseCommandArgs, renderCommandHelp } from '../src/command.ts'
import { newCommand } from '../src/commands/new.ts'
import { createContext } from '../src/context.ts'
import { CliError } from '../src/errors.ts'
import { COMMANDS, findCommand } from '../src/main.ts'
import { createColors, shouldUseColor } from '../src/output.ts'
import { CaptureStream, runCli } from './helpers.ts'
import { describe, expect, test as it } from 'bun:test'

describe('global options', () => {
  it('prints the version', async () => {
    for (const flag of ['--version', '-v', 'version']) {
      const run = await runCli([flag])
      expect(run).toEqual({ code: 0, stdout: '0.1.0\n', stderr: '' })
    }
  })

  it('prints the list of commands without arguments, with --help, -h and help', async () => {
    for (const argv of [[], ['--help'], ['-h'], ['help']]) {
      const run = await runCli(argv)
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('Usage')
      for (const command of ['new <name>', 'generate', 'g <schematic> <name>', 'dev', 'build', 'start']) {
        expect(run.stdout).toContain(command)
      }
    }
  })

  it('prints the help of a command', async () => {
    for (const argv of [
      ['new', '--help'],
      ['new', '-h'],
      ['help', 'new'],
      ['create', '--help'],
    ]) {
      const run = await runCli(argv)
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('znight new')
      expect(run.stdout).toContain('--pm <bun|npm|pnpm|yarn>')
      expect(run.stdout).toContain('--no-install')
    }
  })

  it('renders every command help without colors when they are disabled', async () => {
    for (const command of COMMANDS) {
      const run = await runCli([command.meta.name, '--help'])
      expect(run.code).toBe(0)
      expect(run.stdout).not.toContain('\x1b[')
      expect(run.stdout).toContain(`znight ${command.meta.name}`)
    }
  })

  it('colors the output with --color and NO_COLOR has no effect on an explicit flag', async () => {
    const colored = await runCli(['--color', '--help'], { env: { NO_COLOR: '1' } })
    expect(colored.stdout).toContain('\x1b[')
    const plain = await runCli(['--no-color', '--help'], { env: { FORCE_COLOR: '1' } })
    expect(plain.stdout).not.toContain('\x1b[')
  })
})

describe('usage errors (exit code 2)', () => {
  it('rejects an unknown command with a suggestion', async () => {
    const run = await runCli(['buidl'])
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('Unknown command "buidl"')
    expect(run.stderr).toContain('did you mean "znight build"?')
    expect(run.stdout).toBe('')
  })

  it('rejects an unknown option with a suggestion', async () => {
    const run = await runCli(['new', 'app', '--isntall'])
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('Unknown option --isntall')
    expect(run.stderr).toContain('did you mean --install?')
    expect(run.stderr).toContain('run "znight new --help" for the usage')
  })

  it('rejects unknown short options and options before the command', async () => {
    expect((await runCli(['new', 'app', '-x'])).stderr).toContain('Unknown option -x')
    const run = await runCli(['--foo'])
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('Unknown option --foo')
  })

  it('rejects unexpected arguments', async () => {
    const run = await runCli(['build', 'extra'])
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('Unexpected argument: extra')
  })

  it('rejects invalid enum values', async () => {
    const run = await runCli(['new', 'app', '--pm', 'cargo'])
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('Invalid value for argument: --pm (cargo)')
    expect(run.stderr).not.toContain('\x1b[')
  })

  it('rejects help for an unknown command', async () => {
    const run = await runCli(['help', 'nope'])
    expect(run.code).toBe(2)
  })
})

describe('error reporting', () => {
  it('reports expected failures without stack trace (exit code 1)', async () => {
    const run = await runCli(['start', '--root', '/definitely/not/here'])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('✗ Project root not found: /definitely/not/here')
    expect(run.stderr).not.toContain('    at ')
  })

  it('reports unexpected errors with a hint, and the stack trace with --debug', async () => {
    const services = {
      loadVite: () => Promise.reject(new TypeError('boom')),
    }
    const plain = await runCli(['build'], { services, cwd: import.meta.dir })
    expect(plain.code).toBe(1)
    expect(plain.stderr).toContain('Unexpected error: boom')
    expect(plain.stderr).toContain('run with --debug')

    const debug = await runCli(['build', '--debug'], { services, cwd: import.meta.dir })
    expect(debug.code).toBe(1)
    expect(debug.stderr).toContain('TypeError: boom')
    expect(debug.stderr).toContain('    at ')
  })

  it('uses the exit code of CliError', async () => {
    const services = { loadVite: () => Promise.reject(new CliError('nope', { exitCode: 7, hints: ['do this'] })) }
    const run = await runCli(['build'], { services, cwd: import.meta.dir })
    expect(run.code).toBe(7)
    expect(run.stderr).toContain('✗ nope')
    expect(run.stderr).toContain('= hint: do this')
  })
})

describe('argument parsing', () => {
  it('parses positionals, booleans, negations, enums and aliases', () => {
    const args = parseCommandArgs(newCommand, [
      'my-app',
      '-y',
      '--pm=pnpm',
      '--adapter',
      'hono',
      '--no-install',
      '--features',
      'config',
    ]) as Record<string, unknown>
    expect(args['name']).toBe('my-app')
    expect(args['yes']).toBe(true)
    expect(args['pm']).toBe('pnpm')
    expect(args['adapter']).toBe('hono')
    expect(args['install']).toBe(false)
    expect(args['git']).toBe(true)
    expect(args['features']).toBe('config')
  })

  it('accepts camelCase and kebab-case spellings', async () => {
    const run = await runCli(['dev', '--killTimeout', 'abc'], { cwd: import.meta.dir })
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('Invalid value for --kill-timeout')
  })

  it('finds commands by name and alias', () => {
    expect(findCommand('new')?.meta.name).toBe('new')
    expect(findCommand('create')?.meta.name).toBe('new')
    expect(findCommand('init')?.meta.name).toBe('new')
    expect(findCommand('g')?.meta.name).toBe('g')
    expect(findCommand('nope')).toBeUndefined()
  })

  it('renders a help with aligned options and examples', () => {
    expect(renderCommandHelp(newCommand, createColors(false))).toMatchSnapshot()
  })
})

describe('colors', () => {
  const tty = new CaptureStream(true)
  const pipe = new CaptureStream(false)

  it('follows NO_COLOR, FORCE_COLOR, the flags and the TTY', () => {
    expect(shouldUseColor({ env: {}, stream: tty })).toBe(true)
    expect(shouldUseColor({ env: {}, stream: pipe })).toBe(false)
    expect(shouldUseColor({ env: { NO_COLOR: '1' }, stream: tty })).toBe(false)
    expect(shouldUseColor({ env: { NO_COLOR: '' }, stream: tty })).toBe(true)
    expect(shouldUseColor({ env: { FORCE_COLOR: '1' }, stream: pipe })).toBe(true)
    expect(shouldUseColor({ env: { FORCE_COLOR: '0' }, stream: tty })).toBe(false)
    expect(shouldUseColor({ env: { TERM: 'dumb' }, stream: tty })).toBe(false)
    expect(shouldUseColor({ env: { NO_COLOR: '1' }, stream: tty, flag: true })).toBe(true)
    expect(shouldUseColor({ env: {}, stream: tty, flag: false })).toBe(false)
  })

  it('creates a context honouring NO_COLOR', () => {
    const context = createContext({ env: { NO_COLOR: '1' }, stdout: tty, stderr: tty, interactive: false })
    expect(context.colors.red('x')).toBe('x')
    expect(context.colors.isColorSupported).toBe(false)
    const colored = createContext({ env: {}, stdout: tty, stderr: tty, interactive: false })
    expect(colored.colors.red('x')).not.toBe('x')
  })

  it('enables debug with ZNIGHT_DEBUG', () => {
    expect(createContext({ env: { ZNIGHT_DEBUG: '1' }, interactive: false }).debug).toBe(true)
    expect(createContext({ env: { ZNIGHT_DEBUG: '0' }, interactive: false }).debug).toBe(false)
    expect(createContext({ env: {}, interactive: false }).debug).toBe(false)
  })
})
