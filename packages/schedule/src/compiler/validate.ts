/**
 * `validate` of the schedule extension (RFC 0004 §5.1): checks that need every job of the
 * application, its source libraries and the data of compiled libraries.
 */
import type { GraphEdge, ValidateContext } from '@znight/compiler'
import type { JobData, ScheduleData } from './data.ts'

import { compareStrings, DUPLICATE_JOB, FOREIGN_REQUEST_VALUES, INVALID_SCHEDULE } from './constants.ts'

type Context = ValidateContext<ScheduleData>

/** Edges followed when a run creates the host: what the host's construction instantiates. */
const INSTANTIATING: ReadonlySet<GraphEdge['kind']> = new Set([
  'dependency',
  'multi',
  'optional',
  'factory',
  'interceptor',
])

/** Duplicate names (ZNIGHT041), request-scoped hosts depending on HTTP or messaging request values. */
export function validateSchedule(ctx: Context): void {
  const jobs = ctx.stored.filter((data): data is JobData => data.kind === 'job').sort(byLocation)
  reportDuplicates(jobs, ctx)
  reportForeignRequestValues(jobs, ctx)
}

function reportDuplicates(jobs: readonly JobData[], ctx: Context): void {
  const first = new Map<string, JobData>()
  for (const job of jobs) {
    const previous = first.get(job.name)
    if (previous === undefined) {
      first.set(job.name, job)
      continue
    }
    ctx.report({
      code: DUPLICATE_JOB,
      severity: 'error',
      message: `Job name '${job.name}' is used twice`,
      location: job.nameLocation,
      related: [{ message: 'first declared here', location: previous.nameLocation }],
      hints: [
        job.explicitName && previous.explicitName
          ? 'Job names must be unique (logs, metrics, lock keys): rename one of them'
          : 'Set { name } on one of them: job names must be unique (logs, metrics, lock keys)',
      ],
    })
  }
}

/**
 * A request-scoped or transient host is created in the run's scope: when its construction reaches
 * `HttpContext`, `RequestId` or `InboundMessage` (outside `Lazy<T>`), every run fails with
 * ZNIGHT013. Singleton hosts are covered by ZNIGHT003.
 */
function reportForeignRequestValues(jobs: readonly JobData[], ctx: Context): void {
  const reported = new Set<string>()
  let adjacency: Map<string, GraphEdge[]> | undefined
  for (const job of jobs) {
    const token = job.host.identity
    if (reported.has(token)) continue
    const provider = ctx.provider(token)
    if (provider === undefined || provider.scope === 'singleton') continue
    adjacency ??= edgesByProvider(ctx.graph.edges)
    const found = reach(token, adjacency)
    if (found === undefined) continue
    reported.add(token)
    ctx.report({
      code: INVALID_SCHEDULE,
      severity: 'warning',
      message: `${job.host.displayName} depends on ${found}, which does not exist during a scheduled run`,
      location: job.location,
      hints: [
        `Each run resolves ${job.host.displayName} in its own scope, without HTTP request or message: resolving ${found} fails with ZNIGHT013`,
        `Inject it lazily (Lazy<${found}>) where it is used, or keep that dependency out of the job host`,
      ],
    })
  }
}

function edgesByProvider(edges: readonly GraphEdge[]): Map<string, GraphEdge[]> {
  const map = new Map<string, GraphEdge[]>()
  for (const edge of edges) {
    if (!INSTANTIATING.has(edge.kind)) continue
    let list = map.get(edge.from)
    if (list === undefined) {
      list = []
      map.set(edge.from, list)
    }
    list.push(edge)
  }
  return map
}

/** Display name of the first foreign request value reached from `token`. */
function reach(token: string, adjacency: ReadonlyMap<string, readonly GraphEdge[]>): string | undefined {
  const seen = new Set([token])
  const queue = [token]
  for (let index = 0; index < queue.length; index++) {
    for (const edge of adjacency.get(queue[index] as string) ?? []) {
      const name = FOREIGN_REQUEST_VALUES.get(edge.to)
      if (name !== undefined) return name
      if (seen.has(edge.to)) continue
      seen.add(edge.to)
      queue.push(edge.to)
    }
  }
  return undefined
}

function byLocation(a: JobData, b: JobData): number {
  return (
    compareStrings(a.location.file, b.location.file) ||
    a.location.start - b.location.start ||
    compareStrings(a.name, b.name)
  )
}
