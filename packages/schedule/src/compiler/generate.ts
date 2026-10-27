/**
 * `generate` of the schedule extension: `metadata.extensions.schedule` (RFC 0004 §6). Jobs are sorted
 * by name; options equal to their default are omitted; expressions and zones are emitted as written.
 *
 * ```ts
 * {
 *   jobs: [{
 *     name: 'digest.daily',
 *     token: 'src/digest/digest.jobs.ts#DigestJobs',
 *     method: 'sendDaily',
 *     kind: 'cron',
 *     cron: '0 8 * * MON-FRI',
 *     timeZone: 'Europe/Paris',
 *     maxDuration: 600000,
 *     invoke: (c: DigestJobs, j: JobContext) => c.sendDaily(j),
 *   }],
 * }
 * ```
 */
import type { GenerateContext, GenInput, GenNode } from '@znight/compiler'
import type { JobData, ScheduleData } from './data.ts'

import { compareStrings, RUNTIME_MODULE } from './constants.ts'

type Context = GenerateContext<ScheduleData>

/** Builds the schedule section; `undefined` (no section) when the application has no job. */
export function generateSchedule(ctx: Context): GenNode | undefined {
  const jobs = ctx.stored
    .filter((data): data is JobData => data.kind === 'job')
    .sort((a, b) => compareStrings(a.name, b.name))
  if (jobs.length === 0) return undefined
  // created on first use: an unused import would break `noUnusedLocals`
  let jobContext: GenNode | undefined
  const contextType = (): GenNode => {
    jobContext ??= ctx.importFrom(RUNTIME_MODULE, 'JobContext', { type: true })
    return jobContext
  }
  const hostTypes = new Map<string, GenNode>()
  const hostType = (identity: string): GenNode => {
    let node = hostTypes.get(identity)
    if (node === undefined) {
      node = ctx.importType(identity)
      hostTypes.set(identity, node)
    }
    return node
  }
  return ctx.obj([['jobs', ctx.arr(jobs.map(job => jobNode(ctx, job, hostType, contextType)))]])
}

function jobNode(
  ctx: Context,
  job: JobData,
  hostType: (identity: string) => GenNode,
  contextType: () => GenNode,
): GenNode {
  const entries: [string, GenInput][] = [
    ['name', job.name],
    ['token', ctx.tokenOf(job.host) ?? job.host.identity],
    ['method', job.method],
    ['kind', job.trigger],
  ]
  if (job.cron !== undefined) entries.push(['cron', job.cron])
  if (job.timeZone !== undefined) entries.push(['timeZone', job.timeZone])
  if (job.every !== undefined) entries.push(['every', ctx.lit(job.every)])
  if (job.delay !== undefined) entries.push(['delay', ctx.lit(job.delay)])
  if (job.overlap !== undefined) entries.push(['overlap', job.overlap])
  if (job.lock !== undefined) entries.push(['lock', ctx.lit(job.lock)])
  if (job.maxDuration !== undefined) entries.push(['maxDuration', ctx.lit(job.maxDuration)])
  if (job.enabled === false) entries.push(['enabled', ctx.lit(false)])
  if (job.runOnStart === true) entries.push(['runOnStart', ctx.lit(true)])
  const type = hostType(job.host.identity)
  const invoke = job.takesContext
    ? ctx.arrow(
        [
          ['c', type],
          ['j', contextType()],
        ],
        (c, j) => ctx.call(ctx.member(c, job.method), [j as GenNode]),
      )
    : ctx.arrow([['c', type]], c => ctx.call(ctx.member(c, job.method)))
  entries.push(['invoke', invoke])
  return ctx.obj(entries)
}
