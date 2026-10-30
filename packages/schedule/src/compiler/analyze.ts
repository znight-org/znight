/**
 * `analyzeClass` of the schedule extension (RFC 0004 §5.1): reads the `@Cron`, `@Interval` and
 * `@Timeout` methods of a class, validates the expressions, durations, zones, options, names and
 * signatures with the engine the runtime uses, declares the class as a root (`addRoot`: a singleton
 * provider when nothing else registers it) and stores one {@link JobData} per decorator.
 */
import type {
  AnalyzeContext,
  ArgInfo,
  ClassInfo,
  DecoratorInfo,
  Location,
  MethodInfo,
  ParameterInfo,
  StaticValue,
  TypeInfo,
} from '@znight/compiler'
import type { JobData, ScheduleData } from './data.ts'

import { cronWarnings, neverFires } from '../cron/analysis.ts'
import { FIELDS_HINT } from '../cron/fields.ts'
import { parseCronSpec } from '../cron/parse.ts'
import { knownTimeZones, resolveTimeZone } from '../cron/zone.ts'
import { checkDuration } from '../duration.ts'
import { closest, isJobName, JOB_NAME_RULE } from '../names.ts'
import {
  EXTENSION_NAME,
  INVALID_DECORATOR,
  INVALID_SCHEDULE,
  JOB_CONTEXT_IDENTITY,
  JOB_DECORATORS,
  ROOT_REASON,
} from './constants.ts'
import { describeValue, isRecord, propertyLocation, spanLocation } from './values.ts'

type Context = AnalyzeContext<ScheduleData>
type JobKind = 'cron' | 'interval' | 'timeout'

const COMMON_OPTIONS = ['name', 'enabled', 'lock', 'maxDuration']
const OPTIONS: Readonly<Record<JobKind, readonly string[]>> = {
  cron: [...COMMON_OPTIONS, 'timeZone', 'overlap', 'runOnStart'],
  interval: [...COMMON_OPTIONS, 'overlap', 'runOnStart'],
  timeout: COMMON_OPTIONS,
}
const OVERLAPS: readonly string[] = ['skip', 'queue', 'allow']

/** Analyses a class carrying at least one job decorator. */
export function analyzeScheduleClass(cls: ClassInfo, ctx: Context): void {
  const methods = cls.methods.filter(method => method.decorators.some(isJobDecorator))
  const decorators = methods.flatMap(method => method.decorators.filter(isJobDecorator))
  const first = decorators[0]
  if (first === undefined) return
  if (cls.abstract || cls.typeParameters.length > 0) {
    for (const decorator of decorators) {
      ctx.report({
        code: INVALID_DECORATOR,
        severity: 'error',
        message: cls.abstract
          ? `@${decorator.name} cannot be applied to the abstract class ${cls.displayName}: jobs are not inherited`
          : `@${decorator.name} cannot be applied to the generic class ${cls.displayName}<${cls.typeParameters.join(', ')}>`,
        location: decorator.location,
        hints: [
          cls.abstract
            ? 'Declare the job on the concrete class (it may call a method of the base class)'
            : 'Jobs run on a provider: remove the type parameters of the host',
        ],
      })
    }
    return
  }

  const jobs: JobData[] = []
  for (const method of methods) {
    const own = method.decorators.filter(isJobDecorator)
    const where = `${cls.displayName}.${method.name}()`
    const primary = own[0] as DecoratorInfo
    checkMethodShape(method, primary, where, ctx)
    checkForeignHandler(method, primary, where, ctx)
    checkParameterDecorators(method, where, ctx)
    const takesContext = checkSignature(method, primary, where, ctx)
    for (const decorator of own) {
      const job = analyzeDecorator(cls, method, decorator, own.length, takesContext, ctx)
      if (job !== undefined) jobs.push(job)
    }
  }
  // the host is an entry point of the plugin: a root of ZNIGHT019 and prune, a singleton when
  // nothing else registers it
  ctx.addRoot(cls, { reason: ROOT_REASON, location: first.location })
  for (const job of jobs) ctx.store(job)
}

function isJobDecorator(decorator: DecoratorInfo): boolean {
  return decorator.identity !== undefined && JOB_DECORATORS.has(decorator.identity)
}

// ------------------------------------------------------------------------------------------ method

/** Jobs are called by the generated code: `host.method(ctx)`. */
function checkMethodShape(method: MethodInfo, decorator: DecoratorInfo, where: string, ctx: Context): void {
  const name = `@${decorator.name}`
  let problem: { message: string; hint: string } | undefined
  if (method.kind !== 'method') {
    problem = { message: `${name} cannot be applied to the accessor ${where}`, hint: 'Use a regular method' }
  } else if (method.static) {
    problem = {
      message: `${name} cannot be applied to the static method ${where}`,
      hint: 'Jobs are called on the host instance: remove `static`',
    }
  } else if (method.privateName) {
    problem = {
      message: `${name} cannot be applied to the #private method ${where}`,
      hint: 'Use a public method: the generated code calls it',
    }
  } else if (method.visibility !== 'public') {
    problem = {
      message: `${where} must be public: ${name} methods are called by the generated code`,
      hint: `Remove the '${method.visibility}' modifier`,
    }
  } else if (method.computed) {
    problem = {
      message: `${name} cannot be applied to ${where}: computed method names are not supported`,
      hint: 'Use a plain method name',
    }
  } else if (method.generator) {
    problem = {
      message: `${name} cannot be applied to the generator method ${where}`,
      hint: 'Use a regular (or async) method',
    }
  }
  if (problem !== undefined) {
    ctx.report({
      code: INVALID_DECORATOR,
      severity: 'error',
      message: problem.message,
      location: decorator.location,
      hints: [problem.hint],
    })
  }
}

/** A job method cannot also be handled by another extension (`@Get`, `@OnMessage`). */
function checkForeignHandler(method: MethodInfo, decorator: DecoratorInfo, where: string, ctx: Context): void {
  for (const other of method.decorators) {
    const owner = other.owner
    if (owner === undefined || owner === EXTENSION_NAME || owner === 'core' || owner === 'manifest') continue
    ctx.report({
      code: INVALID_DECORATOR,
      severity: 'error',
      message: `${where} cannot be both a job (@${decorator.name}) and a @${other.name} handler`,
      location: other.location,
      hints: ['A job method cannot be a route or a message handler: let the job call the handler'],
    })
    return
  }
}

/** Job methods only receive `ctx`: parameter decorators make no sense. */
function checkParameterDecorators(method: MethodInfo, where: string, ctx: Context): void {
  const seen = new Set<number>()
  for (const param of method.params) {
    for (const decorator of param.decorators) {
      if (seen.has(decorator.location.start)) continue
      seen.add(decorator.location.start)
      ctx.report({
        code: INVALID_DECORATOR,
        severity: 'error',
        message: `@${decorator.name} cannot be applied to parameter '${param.name}' of ${where}: a job method only receives its JobContext`,
        location: decorator.location,
        hints: ['Declare (ctx: JobContext) without decorator, or no parameter'],
      })
    }
  }
}

/** At most one required parameter, typed `JobContext` (or `unknown`, `any`, unannotated). */
function checkSignature(method: MethodInfo, decorator: DecoratorInfo, where: string, ctx: Context): boolean {
  const params = method.params
  const required = params.filter(param => !param.optional && !param.hasDefault && !param.rest)
  const first = params[0]
  let bad: Location | undefined
  if (required.length > 1) bad = (required[1] as ParameterInfo).location
  else if (first !== undefined && (first.rest || !acceptsContext(first, ctx))) bad = first.typeLocation
  if (bad !== undefined) {
    const written = params.map(param => `${param.rest ? '...' : ''}${param.name}: ${ctx.types.format(param.type)}`)
    ctx.report({
      code: INVALID_SCHEDULE,
      severity: 'error',
      message: `${where.slice(0, -2)}(${written.join(', ')}) is called with (ctx: JobContext)`,
      location: bad,
      hints: [
        `@${decorator.name} methods take no parameter, or one ctx: JobContext (import type { JobContext } from '@znight/schedule')`,
      ],
    })
  }
  return params.length > 0
}

function acceptsContext(param: ParameterInfo, ctx: Context): boolean {
  const type: TypeInfo = ctx.types.stripNullish(param.type).type
  switch (type.kind) {
    case 'primitive':
      return type.name === 'unknown' || type.name === 'any'
    case 'reference':
      return type.identity === JOB_CONTEXT_IDENTITY
    case 'opaque':
      return type.reason === 'missing-annotation'
    default:
      return false
  }
}

// --------------------------------------------------------------------------------------- decorator

function analyzeDecorator(
  cls: ClassInfo,
  method: MethodInfo,
  decorator: DecoratorInfo,
  triggers: number,
  takesContext: boolean,
  ctx: Context,
): JobData | undefined {
  if (!decorator.called) return undefined // `@Cron` without call: reported by the compiler
  const kind = JOB_DECORATORS.get(decorator.identity as string) as JobKind
  const options = readOptions(kind, decorator, ctx)
  const defaultName = `${cls.displayName}.${method.name}`
  const name = options.name ?? defaultName
  const label = `job '${name}'`
  if (options.name === undefined) {
    if (triggers > 1) {
      ctx.report({
        code: INVALID_SCHEDULE,
        severity: 'error',
        message: `${cls.displayName}.${method.name}() has ${triggers} triggers: each one needs its own name`,
        location: decorator.location,
        hints: ['Set { name } on every @Cron / @Interval / @Timeout of the method'],
      })
    } else if (!isJobName(defaultName)) {
      ctx.report({
        code: INVALID_SCHEDULE,
        severity: 'error',
        message: `The default job name '${defaultName}' is not a valid job name`,
        location: decorator.location,
        hints: ['Set { name } explicitly', `Job names: ${JOB_NAME_RULE}`],
      })
    }
  }

  const arg = decorator.args[0]
  if (arg === undefined) {
    ctx.report({
      code: INVALID_DECORATOR,
      severity: 'error',
      message: `@${decorator.name} on ${cls.displayName}.${method.name}() requires ${kind === 'cron' ? 'a cron expression' : 'a duration'}`,
      location: decorator.location,
      hints: [kind === 'cron' ? "@Cron('0 8 * * MON-FRI')" : `@${decorator.name}('5m')`],
    })
    return undefined
  }
  if (!arg.evaluated) return undefined // not statically evaluable: reported by the compiler

  let cron: string | undefined
  let every: number | undefined
  let delay: number | undefined
  switch (kind) {
    case 'cron':
      cron = readCron(arg, label, ctx)
      break
    case 'interval':
      every = readDuration(arg, arg.value, `@Interval of ${label}`, 1, ctx)
      if (every !== undefined) warnBareNumber(arg.value, every, `@Interval(${every}) runs every ${every} ms`, arg, ctx)
      break
    case 'timeout':
      delay = readDuration(arg, arg.value, `@Timeout of ${label}`, 0, ctx)
      break
  }
  return {
    kind: 'job',
    name,
    explicitName: options.name !== undefined,
    host: cls,
    method: method.name,
    trigger: kind,
    cron,
    every,
    delay,
    timeZone: options.timeZone,
    overlap: options.overlap === 'skip' ? undefined : options.overlap,
    lock: options.lock,
    maxDuration: options.maxDuration,
    enabled: options.enabled === false ? false : undefined,
    runOnStart: options.runOnStart === true ? true : undefined,
    takesContext,
    location: decorator.location,
    nameLocation: options.nameLocation ?? decorator.location,
  }
}

/** The expression, validated with the shared engine; `undefined` when invalid (reported). */
function readCron(arg: ArgInfo, label: string, ctx: Context): string | undefined {
  const value = arg.value
  if (typeof value !== 'string') {
    ctx.report({
      code: INVALID_SCHEDULE,
      severity: 'error',
      message: `@Cron of ${label} expects a cron expression (a string), got ${describeValue(value)}`,
      location: arg.location,
      hints: ["@Cron('0 8 * * MON-FRI') or a nickname such as '@daily'"],
    })
    return undefined
  }
  const parsed = parseCronSpec(value)
  if (!parsed.ok) {
    const issue = parsed.issue
    ctx.report({
      code: INVALID_SCHEDULE,
      severity: 'error',
      message: `Invalid cron expression for ${label}: ${issue.message}`,
      location: spanLocation(ctx.project, arg, value, issue.start, issue.end),
      hints: [issue.hint ?? FIELDS_HINT],
    })
    return undefined
  }
  const spec = parsed.spec
  const never = neverFires(spec)
  if (never !== undefined) {
    ctx.report({
      code: INVALID_SCHEDULE,
      severity: 'error',
      message: `Cron expression '${spec.normalized}' of ${label} ${never.message}`,
      location: arg.location,
      hints: [never.hint],
    })
    return undefined
  }
  for (const warning of cronWarnings(spec)) {
    ctx.report({
      code: INVALID_SCHEDULE,
      severity: 'warning',
      message: `Cron expression '${spec.normalized}' of ${label} ${warning.message}`,
      location: arg.location,
      hints: [warning.hint],
    })
  }
  return spec.normalized
}

function readDuration(
  arg: ArgInfo | undefined,
  value: StaticValue,
  label: string,
  min: number,
  ctx: Context,
  location?: Location,
): number | undefined {
  const where = location ?? arg?.location
  const result = checkDuration(value)
  if (!result.ok) {
    ctx.report({
      code: INVALID_SCHEDULE,
      severity: 'error',
      message: `${label}: ${result.message}`,
      ...(where === undefined ? {} : { location: where }),
      hints: [result.hint ?? "Durations: milliseconds, or a number with a unit: '500ms', '30s', '5m', '1.5h', '1d'"],
    })
    return undefined
  }
  if (result.ms < min) {
    ctx.report({
      code: INVALID_SCHEDULE,
      severity: 'error',
      message: `${label} must be at least ${min} ms, got ${describeValue(value)}`,
      ...(where === undefined ? {} : { location: where }),
      hints: ["Use @Timeout(0) to run once right at start, or a duration such as '1s'"],
    })
    return undefined
  }
  return result.ms
}

/** `@Interval(5)`: 5 ms is rarely what was meant. */
function warnBareNumber(value: StaticValue, ms: number, what: string, arg: ArgInfo, ctx: Context, at?: Location): void {
  if (typeof value !== 'number' || ms >= 100) return
  ctx.report({
    code: INVALID_SCHEDULE,
    severity: 'warning',
    message: `${what}: did you mean '${ms}s'?`,
    location: at ?? arg.location,
    hints: [`Write '${ms}ms' to keep ${ms} milliseconds`],
  })
}

// ----------------------------------------------------------------------------------------- options

interface ReadOptions {
  readonly name: string | undefined
  readonly nameLocation: Location | undefined
  readonly enabled: boolean | undefined
  readonly lock: boolean | undefined
  readonly maxDuration: number | undefined
  readonly timeZone: string | undefined
  readonly overlap: 'skip' | 'queue' | 'allow' | undefined
  readonly runOnStart: boolean | undefined
}

const NO_OPTIONS: ReadOptions = {
  name: undefined,
  nameLocation: undefined,
  enabled: undefined,
  lock: undefined,
  maxDuration: undefined,
  timeZone: undefined,
  overlap: undefined,
  runOnStart: undefined,
}

/** The options object (second argument): known keys, typed values. */
function readOptions(kind: JobKind, decorator: DecoratorInfo, ctx: Context): ReadOptions {
  const arg = decorator.args[1]
  if (arg === undefined || !arg.evaluated || arg.value === undefined) return NO_OPTIONS
  const value = arg.value
  const prefix = `@${decorator.name}`
  if (!isRecord(value)) {
    ctx.report({
      code: INVALID_SCHEDULE,
      severity: 'error',
      message: `${prefix} options must be an object literal, got ${describeValue(value)}`,
      location: arg.location,
    })
    return NO_OPTIONS
  }
  const fail = (key: string, message: string, hints: readonly string[] = []): void => {
    ctx.report({
      code: INVALID_SCHEDULE,
      severity: 'error',
      message: `${prefix}: ${message}`,
      location: propertyLocation(ctx.project, arg, key),
      ...(hints.length === 0 ? {} : { hints }),
    })
  }

  for (const key of Object.keys(value)) {
    if (OPTIONS[kind].includes(key)) continue
    if (key === 'timeZone') {
      fail(key, `unknown option 'timeZone'`, [
        'Intervals and timeouts are durations: use @Cron for wall-clock schedules',
      ])
    } else if ((key === 'overlap' || key === 'runOnStart') && kind === 'timeout') {
      fail(key, `unknown option '${key}'`, ['A timeout runs once: overlap and runOnStart do not apply'])
    } else {
      const suggestion = closest(key, OPTIONS[kind])
      fail(key, `unknown option '${key}'${suggestion === undefined ? '' : ` (did you mean '${suggestion}'?)`}`, [
        `Options of @${decorator.name}: ${OPTIONS[kind].join(', ')}`,
      ])
    }
  }

  let name: string | undefined
  const rawName = value['name']
  if (rawName !== undefined) {
    if (typeof rawName !== 'string' || !isJobName(rawName)) {
      fail('name', `invalid job name ${describeValue(rawName)}`, [`Job names: ${JOB_NAME_RULE}`])
    } else {
      name = rawName
    }
  }
  const boolean = (key: string): boolean | undefined => {
    const option = value[key]
    if (option === undefined || !OPTIONS[kind].includes(key)) return undefined
    if (typeof option === 'boolean') return option
    fail(key, `'${key}' must be a boolean, got ${describeValue(option)}`)
    return undefined
  }
  const enabled = boolean('enabled')
  const lock = boolean('lock')
  const runOnStart = boolean('runOnStart')

  let overlap: ReadOptions['overlap']
  const rawOverlap = value['overlap']
  if (rawOverlap !== undefined && OPTIONS[kind].includes('overlap')) {
    if (typeof rawOverlap === 'string' && OVERLAPS.includes(rawOverlap)) overlap = rawOverlap as ReadOptions['overlap']
    else fail('overlap', `'overlap' must be 'skip', 'queue' or 'allow', got ${describeValue(rawOverlap)}`)
  }
  if (lock === true && overlap === 'allow') {
    fail('lock', "lock: true cannot be combined with overlap: 'allow'", [
      "Concurrent runs cannot share one lock: use overlap: 'skip' or 'queue', or drop lock: true",
    ])
  }

  let maxDuration: number | undefined
  const rawMax = value['maxDuration']
  if (rawMax !== undefined) {
    const location = propertyLocation(ctx.project, arg, 'maxDuration')
    maxDuration = readDuration(undefined, rawMax, `${prefix} 'maxDuration'`, 1, ctx, location)
    if (maxDuration !== undefined) {
      warnBareNumber(rawMax, maxDuration, `maxDuration: ${maxDuration} is ${maxDuration} ms`, arg, ctx, location)
    }
  }

  let timeZone: string | undefined
  const rawZone = value['timeZone']
  if (rawZone !== undefined && kind === 'cron') {
    if (typeof rawZone !== 'string' || rawZone === '') {
      fail('timeZone', `'timeZone' must be a non-empty string, got ${describeValue(rawZone)}`)
    } else if (rawZone === 'local') {
      timeZone = rawZone
    } else {
      const zone = resolveTimeZone(rawZone)
      if (zone.ok) {
        timeZone = rawZone
      } else {
        const suggestion = zone.unknown ? closest(rawZone, knownTimeZones()) : undefined
        fail(
          'timeZone',
          `${zone.message.charAt(0).toUpperCase()}${zone.message.slice(1)}${suggestion === undefined ? '' : ` (did you mean '${suggestion}'?)`}`,
          ["Use an IANA name ('Europe/Paris'), 'UTC', a fixed offset ('+05:30') or 'local'"],
        )
      }
    }
  }

  return {
    name,
    nameLocation: rawName === undefined ? undefined : propertyLocation(ctx.project, arg, 'name'),
    enabled,
    lock,
    maxDuration,
    timeZone,
    overlap,
    runOnStart,
  }
}
