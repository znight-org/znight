/**
 * Analysis and validation of the compiler extension (RFC 0004 §5): every row of §5.2 with its code,
 * severity, location (the caret inside the string for cron fields) and hints; hosts and roots.
 */
import type { ScheduleAnalysis } from './helpers.ts'

import { analyzeFiles, cleanupApps, pointed, render } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

const SERVICE = `import { Injectable } from '@znight/core'

@Injectable()
export class ReportService {
  build(): string {
    return 'report'
  }
}
`

function diagnostic(result: ScheduleAnalysis, index = 0): ScheduleAnalysis['diagnostics'][number] {
  const found = result.diagnostics.filter(entry =>
    ['ZNIGHT005', 'ZNIGHT040', 'ZNIGHT041', 'ZNIGHT003'].includes(entry.code),
  )[index]
  if (found === undefined) throw new Error(`no diagnostic #${index}: ${render(result).join('\n')}`)
  return found
}

describe('valid jobs', () => {
  it('stores one job per decorator and makes the hosts roots', async () => {
    const result = await analyzeFiles(
      {
        'src/report.ts': SERVICE,
        'src/jobs.ts': `import { Injectable } from '@znight/core'
import { Cron, Interval, Timeout, type JobContext } from '@znight/schedule'
import { ReportService } from './report.ts'

/** Auto-registered: no provider decorator. */
export class DigestJobs {
  constructor(private readonly reports: ReportService) {}

  @Cron('0  8 * * MON-FRI', { name: 'digest.daily', timeZone: 'Europe/Paris', maxDuration: '10m' })
  async sendDaily(ctx: JobContext): Promise<void> {
    void ctx
    this.reports.build()
  }

  @Cron('0 9 * * MON-FRI', { name: 'standup.weekdays' })
  @Cron('0 11 * * SAT,SUN', { name: 'standup.weekend' })
  remind(): void {}

  @Interval('1m', { lock: false, runOnStart: true, overlap: 'queue' })
  refresh(_ctx?: unknown): void {}

  @Timeout(0, { enabled: false })
  warm(): void {}
}

@Injectable({ scope: 'request' })
export class CatalogImport {
  constructor(private readonly ctx: JobContext) {}

  @Interval(900_000, { name: 'catalog.import', overlap: 'allow' })
  run(): string {
    return this.ctx.runId
  }
}
`,
      },
      { reportUnused: true },
    )
    expect(render(result)).toEqual([])
    expect(
      result.jobs.map(job => [job.name, job.trigger, job.cron ?? job.every ?? job.delay, job.method, job.takesContext]),
    ).toEqual([
      ['catalog.import', 'interval', 900_000, 'run', false],
      ['digest.daily', 'cron', '0 8 * * MON-FRI', 'sendDaily', true],
      ['standup.weekdays', 'cron', '0 9 * * MON-FRI', 'remind', false],
      ['standup.weekend', 'cron', '0 11 * * SAT,SUN', 'remind', false],
      ['DigestJobs.refresh', 'interval', 60_000, 'refresh', true],
      ['DigestJobs.warm', 'timeout', 0, 'warm', false],
    ])
    const digest = result.jobs.find(job => job.name === 'digest.daily')
    expect(digest).toMatchObject({
      timeZone: 'Europe/Paris',
      maxDuration: 600_000,
      explicitName: true,
      overlap: undefined,
    })
    expect(result.jobs.find(job => job.name === 'DigestJobs.refresh')).toMatchObject({
      lock: false,
      runOnStart: true,
      overlap: 'queue',
      explicitName: false,
    })
    expect(result.jobs.find(job => job.name === 'DigestJobs.warm')).toMatchObject({ enabled: false })
    const providers = Object.fromEntries(result.graph.providers.map(provider => [provider.displayName, provider]))
    expect(providers['DigestJobs']).toMatchObject({ registeredBy: 'auto', scope: 'singleton' })
    expect(providers['CatalogImport']).toMatchObject({ registeredBy: 'core', scope: 'request' })
    expect(result.graph.roots.map(root => [root.token, root.reason])).toEqual([
      ['src/jobs.ts#CatalogImport', 'scheduled job host'],
      ['src/jobs.ts#DigestJobs', 'scheduled job host'],
    ])
  })

  it('accepts hosts registered by other extensions and interceptor decorators on jobs', async () => {
    const result = await analyzeFiles({
      'src/audit.ts': `import { type MethodInterceptor, type MethodInvocation } from '@znight/core'
export class Audit implements MethodInterceptor {
  intercept(invocation: MethodInvocation): unknown {
    return invocation.proceed()
  }
}
`,
      'src/health.ts': `import { Intercept } from '@znight/core'
import { Controller, Get } from '@znight/http'
import { Cron } from '@znight/schedule'
import { Audit } from './audit.ts'

@Controller('/health')
export class HealthController {
  @Get()
  status(): string {
    return 'ok'
  }

  @Cron('@hourly')
  @Intercept(Audit)
  refresh(): void {}
}
`,
    })
    expect(render(result)).toEqual([])
    expect(result.graph.providers.find(provider => provider.displayName === 'HealthController')?.registeredBy).toBe(
      'http',
    )
  })
})

describe('diagnostics (RFC 0004 §5.2)', () => {
  it.each([
    [
      "@Cron('0 24 * * MON-FRI', { name: 'digest.daily' })",
      'error ZNIGHT040',
      "Invalid cron expression for job 'digest.daily': hour 24 is out of range (0-23)",
      '24',
    ],
    [
      "@Cron('0 0 * * FRI-MON')",
      'error ZNIGHT040',
      "Invalid cron expression for job 'Jobs.run': reversed range 'FRI-MON' in the day-of-week field: ranges do not wrap",
      'FRI-MON',
    ],
    [
      "@Cron('0 0 30 2 *', { name: 'billing.close' })",
      'error ZNIGHT040',
      "Cron expression '0 0 30 2 *' of job 'billing.close' never fires: February has no day 30",
      "'0 0 30 2 *'",
    ],
    [
      "@Cron('@reboot')",
      'error ZNIGHT040',
      "Invalid cron expression for job 'Jobs.run': @reboot is not supported",
      '@reboot',
    ],
    [
      "@Cron('* 9 * * *')",
      'warning ZNIGHT040',
      "Cron expression '* 9 * * *' of job 'Jobs.run' fires every minute from 09:00 to 09:59",
      "'* 9 * * *'",
    ],
    [
      "@Cron('0 0 * * * * 2027')",
      'error ZNIGHT040',
      "Invalid cron expression for job 'Jobs.run': 7 fields: the year field is not supported",
      '2027',
    ],
    ['@Cron("0 0 3\\u0032 * *")', 'error ZNIGHT040', '', ''],
    [
      "@Interval('5 min')",
      'error ZNIGHT040',
      "@Interval of job 'Jobs.run': '5 min' is not a duration: use '5m' (ms, s, m, h, d)",
      "'5 min'",
    ],
    ['@Interval(0)', 'error ZNIGHT040', "@Interval of job 'Jobs.run' must be at least 1 ms, got 0", '0'],
    ['@Interval(5)', 'warning ZNIGHT040', "@Interval(5) runs every 5 ms: did you mean '5s'?", '5'],
    ["@Timeout('400d')", 'error ZNIGHT040', "@Timeout of job 'Jobs.run': '400d' is longer than 366 days", "'400d'"],
    [
      "@Interval('1m', { maxDuration: 30 })",
      'warning ZNIGHT040',
      "maxDuration: 30 is 30 ms: did you mean '30s'?",
      'maxDuration: 30',
    ],
    [
      "@Cron('@daily', { timeZone: 'Europe/Pari' })",
      'error ZNIGHT040',
      "@Cron: Unknown time zone 'Europe/Pari' (did you mean 'Europe/Paris'?)",
      "timeZone: 'Europe/Pari'",
    ],
    [
      "@Cron('@daily', { timezone: 'UTC' })",
      'error ZNIGHT040',
      "@Cron: unknown option 'timezone' (did you mean 'timeZone'?)",
      "timezone: 'UTC'",
    ],
    [
      "@Interval('1m', { timeZone: 'UTC' })",
      'error ZNIGHT040',
      "@Interval: unknown option 'timeZone'",
      "timeZone: 'UTC'",
    ],
    [
      "@Timeout('1m', { overlap: 'queue' })",
      'error ZNIGHT040',
      "@Timeout: unknown option 'overlap'",
      "overlap: 'queue'",
    ],
    [
      "@Cron('@daily', { name: 'bad name' })",
      'error ZNIGHT040',
      '@Cron: invalid job name "bad name"',
      "name: 'bad name'",
    ],
    [
      "@Cron('@daily', { lock: true, overlap: 'allow' })",
      'error ZNIGHT040',
      "@Cron: lock: true cannot be combined with overlap: 'allow'",
      'lock: true',
    ],
    [
      "@Cron('@daily', { overlap: 'never' })",
      'error ZNIGHT040',
      "@Cron: 'overlap' must be 'skip', 'queue' or 'allow', got \"never\"",
      "overlap: 'never'",
    ],
    [
      "@Cron('@daily', { runOnStart: 'yes' })",
      'error ZNIGHT040',
      '@Cron: \'runOnStart\' must be a boolean, got "yes"',
      "runOnStart: 'yes'",
    ],
    [
      "@Cron('@daily', 'nightly')",
      'error ZNIGHT040',
      '@Cron options must be an object literal, got "nightly"',
      "'nightly'",
    ],
    ['@Cron(42)', 'error ZNIGHT040', "@Cron of job 'Jobs.run' expects a cron expression (a string), got 42", '42'],
  ])('%s', async (decorator, severity, message, text) => {
    const result = await analyzeFiles({
      'src/jobs.ts': `import { Cron, Interval, Timeout } from '@znight/schedule'

export class Jobs {
  ${decorator}
  run(): void {}
}
`,
    })
    if (message === '') {
      // an escape in the literal: the location falls back to the whole argument
      expect(diagnostic(result).message).toContain('day-of-month 32 is out of range (1-31)')
      expect(pointed(result, diagnostic(result))).toBe('"0 0 3\\u0032 * *"')
      return
    }
    const found = diagnostic(result)
    expect(`${found.severity} ${found.code}`).toBe(severity)
    expect(found.message).toBe(message)
    expect(pointed(result, found)).toBe(text)
  })

  it('points at the argument when the expression is a constant', async () => {
    const result = await analyzeFiles({
      'src/jobs.ts': `import { Cron } from '@znight/schedule'

const NIGHTLY = '0 25 * * *'

export class Jobs {
  @Cron(NIGHTLY)
  run(): void {}
}
`,
    })
    expect(render(result)).toEqual([
      "error ZNIGHT040 src/jobs.ts:6:9 Invalid cron expression for job 'Jobs.run': hour 25 is out of range (0-23)\n  = Fields: [second] minute hour day-of-month month day-of-week",
    ])
  })

  it('renders the hints of RFC §5.3', async () => {
    const result = await analyzeFiles({
      'src/digest.jobs.ts': `import { Cron } from '@znight/schedule'

export class DigestJobs {
  @Cron('0 24 * * MON-FRI', { name: 'digest.daily', timeZone: 'Europe/Paris' })
  sendDaily(): void {}

  @Cron('0 0 30 2 *', { name: 'billing.close' })
  close(): void {}

  @Cron('* 9 * * *')
  daily(): void {}
}
`,
    })
    expect(render(result)).toEqual([
      "error ZNIGHT040 src/digest.jobs.ts:4:12 Invalid cron expression for job 'digest.daily': hour 24 is out of range (0-23)\n  = Fields: [second] minute hour day-of-month month day-of-week",
      "error ZNIGHT040 src/digest.jobs.ts:7:9 Cron expression '0 0 30 2 *' of job 'billing.close' never fires: February has no day 30\n  = Use 'L' for the last day of the month: '0 0 L 2 *'",
      "warning ZNIGHT040 src/digest.jobs.ts:10:9 Cron expression '* 9 * * *' of job 'DigestJobs.daily' fires every minute from 09:00 to 09:59\n  = Once at 09:00 is '0 9 * * *'; write '0-59 9 * * *' to mean every minute",
    ])
  })

  it('checks the signature: at most ctx: JobContext', async () => {
    const result = await analyzeFiles({
      'src/outbox.ts': `import { Cron, type JobContext } from '@znight/schedule'

export interface Batch {
  readonly id: string
}

export class OutboxJobs {
  @Cron('@hourly')
  flush(batch: Batch): void {
    void batch
  }

  @Cron('@daily')
  twice(ctx: JobContext, other: string): void {
    void ctx
    void other
  }

  @Cron('@weekly')
  rest(...args: unknown[]): void {
    void args
  }

  @Cron('@monthly')
  fine(ctx: JobContext, extra = 1): void {
    void ctx
    void extra
  }
}
`,
    })
    expect(render(result).map(line => line.split('\n')[0])).toEqual([
      'error ZNIGHT040 src/outbox.ts:9:16 OutboxJobs.flush(batch: Batch) is called with (ctx: JobContext)',
      'error ZNIGHT040 src/outbox.ts:14:26 OutboxJobs.twice(ctx: JobContext, other: string) is called with (ctx: JobContext)',
      'error ZNIGHT040 src/outbox.ts:20:17 OutboxJobs.rest(...args: unknown[]) is called with (ctx: JobContext)',
    ])
  })

  it('requires a name per trigger when a method has several', async () => {
    const result = await analyzeFiles({
      'src/jobs.ts': `import { Cron } from '@znight/schedule'

export class Jobs {
  @Cron('0 9 * * MON-FRI')
  @Cron('0 11 * * SAT,SUN', { name: 'weekend' })
  remind(): void {}
}
`,
    })
    expect(render(result).map(line => line.split('\n')[0])).toEqual([
      'error ZNIGHT040 src/jobs.ts:4:3 Jobs.remind() has 2 triggers: each one needs its own name',
    ])
  })

  it('reports duplicate names across the application (ZNIGHT041)', async () => {
    const result = await analyzeFiles({
      'src/crm.ts': `import { Cron } from '@znight/schedule'

export class CrmJobs {
  @Cron('@hourly', { name: 'sync' })
  sync(): void {}
}
`,
      'src/erp.ts': `import { Interval } from '@znight/schedule'

export class ErpJobs {
  @Interval('1h', { name: 'sync' })
  pull(): void {}
}
`,
    })
    expect(render(result)).toEqual([
      "error ZNIGHT041 src/erp.ts:4:21 Job name 'sync' is used twice\n  = Job names must be unique (logs, metrics, lock keys): rename one of them\n  - first declared here (src/crm.ts:4:22)",
    ])
  })

  it('reports misuses of the decorators (ZNIGHT005)', async () => {
    const result = await analyzeFiles({
      'src/base.ts': `import { Cron } from '@znight/schedule'

export abstract class BaseJobs {
  @Cron('@daily')
  run(): void {}
}
`,
      'src/generic.ts': `import { Cron } from '@znight/schedule'

export class GenericJobs<T> {
  value: T | undefined
  @Cron('@daily')
  run(): void {}
}
`,
      'src/shapes.ts': `import { Controller, Get } from '@znight/http'
import { Cron, Interval, Timeout } from '@znight/schedule'

@Controller('/shapes')
export class ShapeJobs {
  @Cron('@daily')
  static once(): void {}

  @Interval('1m')
  private hidden(): void {}

  @Timeout(0)
  *generate(): Generator<number> {
    yield 1
  }

  @Get('/route')
  @Cron('@hourly')
  route(): string {
    return 'both'
  }

  @Cron('@hourly', { name: 'shapes.unused' })
  touch(): void {
    this.hidden()
  }
}
`,
    })
    expect(render(result).map(line => line.split('\n')[0])).toEqual([
      'error ZNIGHT005 src/base.ts:4:3 @Cron cannot be applied to the abstract class BaseJobs: jobs are not inherited',
      'error ZNIGHT005 src/generic.ts:5:3 @Cron cannot be applied to the generic class GenericJobs<T>',
      'error ZNIGHT005 src/shapes.ts:6:3 @Cron cannot be applied to the static method ShapeJobs.once()',
      'error ZNIGHT005 src/shapes.ts:9:3 ShapeJobs.hidden() must be public: @Interval methods are called by the generated code',
      'error ZNIGHT005 src/shapes.ts:12:3 @Timeout cannot be applied to the generator method ShapeJobs.generate()',
      'error ZNIGHT005 src/shapes.ts:17:3 ShapeJobs.route() cannot be both a job (@Cron) and a @Get handler',
    ])
  })

  it('a singleton host injecting JobContext is a scope mismatch (ZNIGHT003)', async () => {
    const result = await analyzeFiles({
      'src/jobs.ts': `import { Cron, type JobContext } from '@znight/schedule'

export class Jobs {
  constructor(private readonly ctx: JobContext) {}

  @Cron('@daily')
  run(): string {
    return this.ctx.job
  }
}
`,
    })
    expect(result.diagnostics.map(entry => entry.code)).toContain('ZNIGHT003')
  })

  it('warns when a request-scoped host depends on a request value of HTTP or messaging', async () => {
    const result = await analyzeFiles({
      'src/jobs.ts': `import { Injectable } from '@znight/core'
import { HttpContext } from '@znight/http'
import { Interval } from '@znight/schedule'

@Injectable({ scope: 'request' })
export class Tenant {
  constructor(readonly http: HttpContext) {}
}

@Injectable({ scope: 'request' })
export class CatalogImport {
  constructor(private readonly tenant: Tenant) {}

  @Interval('15m', { name: 'catalog.import' })
  run(): void {
    void this.tenant
  }
}
`,
    })
    expect(render(result).map(line => line.split('\n')[0])).toEqual([
      'warning ZNIGHT040 src/jobs.ts:14:3 CatalogImport depends on HttpContext, which does not exist during a scheduled run',
    ])
  })
})
