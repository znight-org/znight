import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { findSchematic, parseSchematicName, planSchematic, SCHEMATICS } from '../src/schematics/index.ts'
import { fileTree, runCli, temporaryDirectory } from './helpers.ts'
import { afterEach, beforeEach, describe, expect, test as it } from 'bun:test'

const plain = { zod: false, aop: false }

function schematic(name: string) {
  const found = findSchematic(name)
  if (found === undefined) throw new Error(`no schematic ${name}`)
  return found
}

describe('schematic contents', () => {
  for (const item of SCHEMATICS) {
    it(`${item.name}`, () => {
      const plan = planSchematic({ schematic: item, name: 'users/user-profile', root: '/app', context: plain })
      expect(plan.content).toMatchSnapshot()
    })
  }

  it('consumer with zod: a message schema', () => {
    const plan = planSchematic({
      schematic: schematic('consumer'),
      name: 'orders',
      root: '/app',
      context: { zod: true, aop: false },
    })
    expect(plan.content).toMatchSnapshot()
    expect(plan.content).toContain("import { z } from 'zod'")
    expect(plan.content).toContain('@Message(OrdersMessage) message: OrdersMessage')
  })

  it('interceptor with --aop: a method interceptor', () => {
    const plan = planSchematic({
      schematic: schematic('interceptor'),
      name: 'timing',
      root: '/app',
      context: { zod: false, aop: true },
    })
    expect(plan.content).toMatchSnapshot()
    expect(plan.content).toContain('implements MethodInterceptor')
    expect(plan.hint).toContain('@Intercept(TimingInterceptor)')
  })

  it('job: a class of scheduled jobs named <Name>Jobs', () => {
    const plan = planSchematic({ schematic: schematic('job'), name: 'reports/digest', root: '/app', context: plain })
    expect(plan.file).toBe('/app/src/reports/digest.jobs.ts')
    expect(plan.names.className).toBe('DigestJobs')
    expect(plan.content).toContain("@Cron('0 3 * * *', { name: 'reports.digest.daily' })")
    expect(plan.content).toContain("import { Cron, type JobContext } from '@znight/schedule'")
    expect(plan.hint).toContain('SchedulePlugin.configure()')
    expect(findSchematic('j')?.name).toBe('job')
    expect(parseSchematicName('digest-jobs', schematic('job')).names.kebab).toBe('digest')
  })

  // job names are unique in the application (ZNIGHT041): the directories qualify the default name
  it.each([
    [{ name: 'digest' }, '/app/src/digest/digest.jobs.ts', 'digest.daily'],
    [{ name: 'digest', flat: true }, '/app/src/digest.jobs.ts', 'digest.daily'],
    [{ name: 'digest/digest' }, '/app/src/digest/digest.jobs.ts', 'digest.daily'],
    [{ name: 'reports/digest' }, '/app/src/reports/digest.jobs.ts', 'reports.digest.daily'],
    [{ name: 'emails/Digest_Jobs' }, '/app/src/emails/digest.jobs.ts', 'emails.digest.daily'],
    [{ name: 'Admin/Mail/digest' }, '/app/src/admin/mail/digest.jobs.ts', 'admin.mail.digest.daily'],
    [{ name: 'digest', path: '/app/src/emails' }, '/app/src/emails/digest.jobs.ts', 'emails.digest.daily'],
    [{ name: 'reports/digest', path: '/app/src' }, '/app/src/reports/digest.jobs.ts', 'reports.digest.daily'],
    [{ name: 'digest', path: '/app/lib/jobs' }, '/app/lib/jobs/digest.jobs.ts', 'lib.jobs.digest.daily'],
    [{ name: 'digest', path: '/elsewhere' }, '/elsewhere/digest.jobs.ts', 'digest.daily'],
  ])('job: %o at %s is named %s', (input, file, name) => {
    const plan = planSchematic({ schematic: schematic('job'), root: '/app', context: plain, ...input })
    expect(plan.file).toBe(file)
    expect(plan.content).toContain(`{ name: '${name}' }`)
  })

  it('guard: a commented static enforces line (route decisions)', () => {
    const plan = planSchematic({ schematic: schematic('guard'), name: 'auth', root: '/app', context: plain })
    expect(plan.content).toContain('// static readonly enforces = [Public, Roles]')
  })

  it('config: prefix and environment names from the name', () => {
    const plan = planSchematic({
      schematic: schematic('config'),
      name: 'payment-gateway',
      root: '/app',
      context: plain,
    })
    expect(plan.content).toContain("@Config('paymentGateway')")
    expect(plan.content).toContain('PAYMENT_GATEWAY_ENABLED')
    expect(plan.names.className).toBe('PaymentGatewayConfig')
  })
})

describe('names and placement', () => {
  it('finds schematics by name and alias, case-insensitively', () => {
    expect(findSchematic('service')?.name).toBe('service')
    expect(findSchematic('S')?.name).toBe('service')
    expect(findSchematic('co')?.name).toBe('controller')
    expect(findSchematic('itc')?.name).toBe('interceptor')
    expect(findSchematic('module')).toBeUndefined()
  })

  it.each([
    ['user', [], 'user', 'UserService'],
    ['UserProfile', [], 'user-profile', 'UserProfileService'],
    ['user_profile', [], 'user-profile', 'UserProfileService'],
    ['user-service', [], 'user', 'UserService'],
    ['UserService', [], 'user', 'UserService'],
    ['user.service.ts', [], 'user', 'UserService'],
    ['users/admin/UserProfile', ['users', 'admin'], 'user-profile', 'UserProfileService'],
    ['Users\\Admins/user', ['users', 'admins'], 'user', 'UserService'],
    ['service', [], 'service', 'ServiceService'],
  ])('parses %s', (input, directories, kebab, className) => {
    const parsed = parseSchematicName(input, schematic('service'))
    expect(parsed.directories).toEqual(directories)
    expect(parsed.names.kebab).toBe(kebab)
    expect(parsed.names.className).toBe(className)
  })

  it('rejects invalid names', () => {
    const service = schematic('service')
    expect(() => parseSchematicName('', service)).toThrow('cannot be empty')
    expect(() => parseSchematicName('../user', service)).toThrow('without "." or ".."')
    expect(() => parseSchematicName('/abs/user', service)).toThrow('relative')
    expect(() => parseSchematicName('2fa', service)).toThrow('start with a letter')
    expect(() => parseSchematicName('!!!', service)).toThrow('invalid name')
  })

  it.each([
    [{ name: 'user' }, '/app/src/user/user.service.ts'],
    [{ name: 'users/user' }, '/app/src/users/user.service.ts'],
    [{ name: 'user', flat: true }, '/app/src/user.service.ts'],
    [{ name: 'users/user', flat: true }, '/app/src/users/user.service.ts'],
    [{ name: 'user', path: '/app/lib/shared' }, '/app/lib/shared/user.service.ts'],
    [{ name: 'admin/user', path: '/app/lib' }, '/app/lib/admin/user.service.ts'],
  ])('places %o at %s', (input, file) => {
    const plan = planSchematic({ schematic: schematic('service'), root: '/app', context: plain, ...input })
    expect(plan.file).toBe(file)
  })
})

describe('znight g', () => {
  let project: { path: string; cleanup: () => void }

  beforeEach(() => {
    project = temporaryDirectory()
    writeFileSync(join(project.path, 'package.json'), JSON.stringify({ name: 'app', dependencies: { zod: '^4.0.0' } }))
  })

  afterEach(() => project.cleanup())

  it('creates the file and prints it', async () => {
    const run = await runCli(['g', 'service', 'users/user'], { cwd: project.path })
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('✓ Created src/users/user.service.ts (UserService)')
    expect(readFileSync(join(project.path, 'src/users/user.service.ts'), 'utf8')).toContain('export class UserService')
  })

  it('creates every schematic', async () => {
    for (const item of SCHEMATICS) {
      const run = await runCli(['g', item.name, 'thing'], { cwd: project.path })
      expect(run.code).toBe(0)
    }
    expect(fileTree(join(project.path, 'src'))).toEqual([
      'thing/thing.config.ts',
      'thing/thing.consumer.ts',
      'thing/thing.controller.ts',
      'thing/thing.factory.ts',
      'thing/thing.guard.ts',
      'thing/thing.interceptor.ts',
      'thing/thing.jobs.ts',
      'thing/thing.service.ts',
    ])
    // the project depends on zod: the consumer validates its messages
    expect(readFileSync(join(project.path, 'src/thing/thing.consumer.ts'), 'utf8')).toContain('ThingMessage')
  })

  it('works from a sub-directory (project root = nearest package.json)', async () => {
    const nested = join(project.path, 'src', 'deep')
    mkdirSync(nested, { recursive: true })
    const run = await runCli(['g', 'controller', 'order'], { cwd: nested })
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('Created ../order/order.controller.ts')
    expect(existsSync(join(project.path, 'src/order/order.controller.ts'))).toBe(true)
  })

  it('resolves --path from the working directory', async () => {
    const run = await runCli(['g', 'guard', 'auth', '--path', 'lib/guards'], { cwd: project.path })
    expect(run.code).toBe(0)
    expect(existsSync(join(project.path, 'lib/guards/auth.guard.ts'))).toBe(true)
    expect(run.stdout).toContain('use it with @UseGuard(AuthGuard)')
  })

  it('refuses to overwrite unless --force', async () => {
    expect((await runCli(['g', 's', 'user'], { cwd: project.path })).code).toBe(0)
    const file = join(project.path, 'src/user/user.service.ts')
    writeFileSync(file, 'custom')
    const refused = await runCli(['g', 's', 'user'], { cwd: project.path })
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('src/user/user.service.ts already exists')
    expect(refused.stderr).toContain('--force')
    expect(readFileSync(file, 'utf8')).toBe('custom')

    const forced = await runCli(['g', 's', 'user', '-f'], { cwd: project.path })
    expect(forced.code).toBe(0)
    expect(forced.stdout).toContain('Overwrote src/user/user.service.ts')
    expect(readFileSync(file, 'utf8')).toContain('UserService')
  })

  it('prints without writing with --dry-run', async () => {
    const run = await runCli(['g', 'factory', 'database', '--dry-run'], { cwd: project.path })
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('Would create src/database/database.factory.ts (DatabaseFactory)')
    expect(run.stdout).toContain('@Factory()')
    expect(existsSync(join(project.path, 'src'))).toBe(false)
  })

  it('accepts "generate <schematic>" and "generate:<schematic>"', async () => {
    expect((await runCli(['generate', 'service', 'a'], { cwd: project.path })).code).toBe(0)
    expect((await runCli(['generate:controller', 'b'], { cwd: project.path })).code).toBe(0)
    expect(existsSync(join(project.path, 'src/a/a.service.ts'))).toBe(true)
    expect(existsSync(join(project.path, 'src/b/b.controller.ts'))).toBe(true)
  })

  it('reports usage errors', async () => {
    const missing = await runCli(['g'], { cwd: project.path })
    expect(missing.code).toBe(2)
    expect(missing.stderr).toContain('Missing <schematic>')
    expect(missing.stderr).toContain('service (s)')

    const unknown = await runCli(['g', 'servise', 'user'], { cwd: project.path })
    expect(unknown.code).toBe(2)
    expect(unknown.stderr).toContain('Unknown schematic "servise"')
    expect(unknown.stderr).toContain('did you mean "service"?')

    const noName = await runCli(['g', 'service'], { cwd: project.path })
    expect(noName.code).toBe(2)
    expect(noName.stderr).toContain('Missing <name>')

    const invalid = await runCli(['g', 'service', '../escape'], { cwd: project.path })
    expect(invalid.code).toBe(2)
    expect(invalid.stderr).toContain('invalid name')
  })
})
