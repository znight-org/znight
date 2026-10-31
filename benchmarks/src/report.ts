/**
 * Publishes the results: `bun src/report.ts` writes the charts (`docs/public/benchmarks/*.svg`),
 * the generated tables of `docs/benchmarks.md` (between `<!-- benchmarks:<name> -->` and
 * `<!-- /benchmarks:<name> -->`) and the headline numbers of the docs theme, from
 * `results/results.json`. `--check` writes nothing and fails when a file is out of date.
 */
import type { BarRow } from './charts.ts'
import type { Highlights } from './highlights.ts'
import type { DiFramework, Endpoint, Results } from './results.ts'
import type { Summary } from './stats.ts'
import type { Runtime } from './variants.ts'

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

import { barChart, highlightsCard } from './charts.ts'
import { formatCount, highlights } from './highlights.ts'
import { readResults, toJson } from './results.ts'
import { ADAPTER_NAMES, FRAMEWORK_NAMES, RUNTIME_NAMES, VARIANTS, variantLabel } from './variants.ts'

const REPO = join(import.meta.dir, '../..')
export const PAGE: string = join(REPO, 'docs/benchmarks.md')
export const CHARTS_DIR: string = join(REPO, 'docs/public/benchmarks')
export const HIGHLIGHTS_FILE: string = join(REPO, 'docs/.vitepress/theme/benchmarks.json')

const RUNTIMES: readonly Runtime[] = ['node', 'bun']
const DI_NAMES: Readonly<Record<DiFramework, string>> = {
  znight: 'Znight',
  tsyringe: 'tsyringe',
  inversify: 'InversifyJS',
  nestjs: 'NestJS',
}
const DI_ORDER: readonly DiFramework[] = ['znight', 'tsyringe', 'inversify', 'nestjs']
const ENDPOINT_NAMES: Readonly<Record<Endpoint, string>> = {
  get: '`GET /users/:id`',
  post: '`POST /users` (validated body)',
}

/** A number and its unit: the unit is left out of the ranges of the tables. */
interface Unit {
  readonly number: (value: number) => string
  readonly suffix: string
}

const MS: Unit = { number: value => (value < 10 ? value.toFixed(1) : String(Math.round(value))), suffix: ' ms' }
const MIB: Unit = { number: value => String(Math.round(value)), suffix: ' MiB' }
const ms = (value: number): string => MS.number(value) + MS.suffix
const mib = (value: number): string => MIB.number(value) + MIB.suffix
const thousands = (value: number): string => `${Math.round(value / 1000)}k`
const integer = (value: number): string => formatCount(Math.round(value))

function seriesNames(results: Results, suite: 'boot' | 'http' | 'di'): string[] {
  const runtimes = results[suite]?.environment.runtimes
  return RUNTIMES.map(r => `${RUNTIME_NAMES[r]} ${runtimes?.[r] ?? ''}`.trim())
}

/** The median, then the interquartile range in small type; the median in bold for Znight. */
function cell(summary: Summary | undefined, unit: Unit, bold: boolean): string {
  if (summary === undefined) return '–'
  const median = unit.number(summary.median) + unit.suffix
  return `${bold ? `**${median}**` : median} <small>${unit.number(summary.p25)}–${unit.number(summary.p75)}</small>`
}

/**
 * A Markdown table laid out like Biome formats it (`bun run check` leaves it as is): the first
 * column left-aligned, the others right-aligned, every column padded to its widest cell.
 */
function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const length = (value: string): number => [...value].length
  const widths = header.map((title, column) =>
    Math.max(3, length(title), ...rows.map(row => length(row[column] ?? ''))),
  )
  const line = (cells: readonly string[]): string =>
    `| ${cells
      .map((value, column) => {
        const padding = ' '.repeat((widths[column] ?? 0) - length(value))
        return column === 0 ? value + padding : padding + value
      })
      .join(' | ')} |`
  const separator = widths.map((width, column) => (column === 0 ? '-'.repeat(width) : `${'-'.repeat(width - 1)}:`))
  return [line(header), `| ${separator.join(' | ')} |`, ...rows.map(line)].join('\n')
}

// ---------------------------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------------------------

function variantRows(values: (variant: string, runtime: Runtime) => number | undefined): BarRow[] {
  return VARIANTS.map(variant => ({
    group: ADAPTER_NAMES[variant.adapter],
    label: FRAMEWORK_NAMES[variant.framework],
    highlight: variant.framework === 'znight',
    values: RUNTIMES.map(runtime => values(variant.id, runtime)),
  }))
}

function describe(rows: readonly BarRow[], series: readonly string[], format: (value: number) => string): string {
  return rows
    .map(row => {
      const values = row.values.map((v, i) => `${series[i]}: ${v === undefined ? 'not measured' : format(v)}`)
      return `${row.label} (${row.group}): ${values.join(', ')}`
    })
    .join('; ')
}

export function renderCharts(results: Results): Map<string, string> {
  const charts = new Map<string, string>()
  const boot = results.boot
  if (boot !== undefined) {
    const find = (variant: string, runtime: Runtime) =>
      boot.results.find(r => r.variant === variant && r.runtime === runtime)
    const series = seriesNames(results, 'boot')
    const ready = variantRows((v, r) => find(v, r)?.readyMs.median)
    charts.set(
      'boot.svg',
      barChart({
        title: 'Cold start',
        subtitle: 'Process spawned to the first 200 response · median · lower is better',
        series,
        rows: ready,
        format: ms,
        description: `Cold start, milliseconds. ${describe(ready, series, ms)}.`,
      }),
    )
    const memory = variantRows((v, r) => find(v, r)?.rssMiB.median)
    charts.set(
      'memory.svg',
      barChart({
        title: 'Memory at idle',
        subtitle: 'Resident set size after the first response · median · lower is better',
        series,
        rows: memory,
        format: mib,
        description: `Resident memory at idle, MiB. ${describe(memory, series, mib)}.`,
      }),
    )
  }
  const http = results.http
  if (http !== undefined) {
    const series = seriesNames(results, 'http')
    for (const endpoint of ['get', 'post'] as const) {
      const rows = variantRows(
        (v, r) =>
          http.results.find(x => x.variant === v && x.runtime === r && x.endpoint === endpoint)?.requestsPerSecond
            .median,
      )
      const route = endpoint === 'get' ? 'GET /users/:id' : 'POST /users'
      charts.set(
        `throughput-${endpoint}.svg`,
        barChart({
          title: endpoint === 'get' ? 'Throughput · read' : 'Throughput · validated write',
          subtitle: `${route} · requests per second, ${http.settings.connections} connections · median · higher is better`,
          series,
          rows,
          format: thousands,
          description: `Requests per second for ${route}. ${describe(rows, series, integer)}.`,
        }),
      )
    }
  }
  const di = results.di
  if (di !== undefined) {
    const series = seriesNames(results, 'di')
    const rows: BarRow[] = di.settings.sizes.flatMap(size =>
      DI_ORDER.map(framework => ({
        group: `${formatCount(size)} providers`,
        label: DI_NAMES[framework],
        highlight: framework === 'znight',
        values: RUNTIMES.map(
          runtime =>
            di.results.find(r => r.framework === framework && r.providers === size && r.runtime === runtime)
              ?.containerMs.median,
        ),
      })),
    )
    charts.set(
      'di.svg',
      barChart({
        title: 'Dependency injection',
        subtitle: 'Container created and every provider instantiated · median · lower is better',
        series,
        rows,
        format: ms,
        description: `Container creation, milliseconds. ${describe(rows, series, ms)}.`,
      }),
    )
  }
  const headline = highlights(results)
  if (headline.items.length > 0) charts.set('highlights.svg', highlightsCard(headline))
  return charts
}

// ---------------------------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------------------------

function environmentBlock(results: Results): string {
  const environment = results.http?.environment ?? results.boot?.environment ?? results.di?.environment
  if (environment === undefined) return '_No results yet._'
  const dates = (['boot', 'di', 'http'] as const)
    .map(suite => results[suite]?.environment.date.slice(0, 10))
    .filter((date): date is string => date !== undefined)
  const machine = table(
    ['Setup', 'Value'],
    [
      ['CPU', `${environment.machine}, ${environment.cpus} cores`],
      ['Memory', `${environment.memoryGiB} GiB`],
      ['Operating system', environment.os],
      ['Runtimes', `Node.js ${environment.runtimes.node}, Bun ${environment.runtimes.bun}`],
      ['Measured', `${[...new Set(dates)].join(', ')}, commit \`${environment.commit}\``],
    ],
  )
  const packages = table(
    ['Package', 'Version'],
    Object.entries(environment.packages).map(([name, version]) => [`\`${name}\``, version]),
  )
  return `${machine}\n\n${packages}`
}

function bootBlock(results: Results): string {
  const boot = results.boot
  if (boot === undefined) return '_No results yet._'
  const find = (variant: string, runtime: Runtime) =>
    boot.results.find(r => r.variant === variant && r.runtime === runtime)
  const rows = VARIANTS.map(variant => {
    const bold = variant.framework === 'znight'
    const label = bold ? `**${variantLabel(variant)}**` : variantLabel(variant)
    return [
      label,
      ...RUNTIMES.flatMap(runtime => {
        const result = find(variant.id, runtime)
        return [cell(result?.readyMs, MS, bold), cell(result?.rssMiB, MIB, bold)]
      }),
    ]
  })
  return [
    '![Cold start of each application on Node.js and Bun, in milliseconds](/benchmarks/boot.svg)',
    '',
    '![Resident memory of each application at idle on Node.js and Bun, in MiB](/benchmarks/memory.svg)',
    '',
    table(['Application', 'Node.js: start', 'Node.js: memory', 'Bun: start', 'Bun: memory'], rows),
    '',
    `Median of ${boot.settings.runs} starts, with the interquartile range (25th to 75th percentile) in small type. Memory is sampled ${boot.settings.idleMs} ms after the first response.`,
  ].join('\n')
}

function httpBlock(results: Results): string {
  const http = results.http
  if (http === undefined) return '_No results yet._'
  const sections: string[] = []
  for (const endpoint of ['get', 'post'] as const) {
    const rows = VARIANTS.map(variant => {
      const bold = variant.framework === 'znight'
      const label = bold ? `**${variantLabel(variant)}**` : variantLabel(variant)
      return [
        label,
        ...RUNTIMES.flatMap(runtime => {
          const result = http.results.find(
            r => r.variant === variant.id && r.runtime === runtime && r.endpoint === endpoint,
          )
          if (result === undefined) return ['–', '–']
          const rps = result.requestsPerSecond
          const requests = `${bold ? `**${integer(rps.median)}**` : integer(rps.median)} <small>${integer(rps.min)}–${integer(rps.max)}</small>`
          const latency = `${Math.round(result.latencyP99Ms.median)} ms`
          return [requests, latency]
        }),
      ]
    })
    sections.push(
      `#### ${ENDPOINT_NAMES[endpoint]}`,
      '',
      `![Requests per second of each application for ${ENDPOINT_NAMES[endpoint].replace(/`/g, '')}, on Node.js and Bun](/benchmarks/throughput-${endpoint}.svg)`,
      '',
      table(['Application', 'Node.js: requests/s', 'Node.js: p99', 'Bun: requests/s', 'Bun: p99'], rows),
      '',
    )
  }
  const s = http.settings
  sections.push(
    `Median of ${s.rounds} rounds of ${s.durationSeconds} seconds (minimum–maximum in small type), each after a ${s.warmupSeconds}-second warm-up, ${s.connections} connections, no pipelining. Latency: the 99th percentile reported by ${s.tool}, which records whole milliseconds.`,
  )
  return sections.join('\n')
}

function diBlock(results: Results): string {
  const di = results.di
  if (di === undefined) return '_No results yet._'
  const header = [
    'Container',
    ...RUNTIMES.flatMap(runtime => di.settings.sizes.map(size => `${RUNTIME_NAMES[runtime]}: ${formatCount(size)}`)),
  ]
  const rowsOf = (metric: 'containerMs' | 'processMs') =>
    DI_ORDER.map(framework => {
      const bold = framework === 'znight'
      return [
        bold ? `**${DI_NAMES[framework]}**` : DI_NAMES[framework],
        ...RUNTIMES.flatMap(runtime =>
          di.settings.sizes.map(size =>
            cell(
              di.results.find(r => r.framework === framework && r.providers === size && r.runtime === runtime)?.[
                metric
              ],
              MS,
              bold,
            ),
          ),
        ),
      ]
    })
  const compile = table(
    ['Providers', '`generate()` on Node.js'],
    di.compile.map(c => [formatCount(c.providers), cell(c.generateMs, MS, false)]),
  )
  return [
    '![Time to create the container and every provider, for 100 and 1,000 providers, on Node.js and Bun](/benchmarks/di.svg)',
    '',
    '**Container creation**: the container is created and every provider instantiated, measured inside the process once every module is imported.',
    '',
    table(header, rowsOf('containerMs')),
    '',
    '**Whole process**: spawned to exit, including the runtime start and the imports of the framework and of every provider module.',
    '',
    table(header, rowsOf('processMs')),
    '',
    `Median of ${di.settings.runs} processes, with the interquartile range in small type.`,
    '',
    '**Build-time cost**: what Znight moves to the build. The compiler (`generate()`, the work of `znight generate` and of the Vite plugin) scans, parses, analyses, binds and validates the providers and writes the container module, in a fresh Node.js process:',
    '',
    compile,
  ].join('\n')
}

function summaryBlock(results: Results): string {
  const headline = highlights(results)
  const lines = headline.items.map(item => `- **${item.value} ${item.label}**: ${item.detail}.`)
  const http = results.http
  const rps = (variant: string, runtime: Runtime) =>
    http?.results.find(r => r.variant === variant && r.runtime === runtime && r.endpoint === 'get')?.requestsPerSecond
      .median
  const ours = rps('znight-fastify', 'node')
  const nest = rps('nestjs-fastify', 'node')
  const raw = rps('baseline-fastify', 'node')
  if (ours !== undefined && nest !== undefined && raw !== undefined) {
    let verdict = ours >= nest ? 'ahead of' : 'behind'
    // within the noise stated in the page's caveats (about 10%), the two are level
    if (Math.abs(ours / nest - 1) <= 0.1) verdict = 'level with'
    const gap = (Math.abs(ours / nest - 1) * 100).toFixed(1)
    const sign = ours >= nest ? 'more' : 'fewer'
    lines.push(
      `- **Throughput: Znight is ${verdict} NestJS on Node.js** with Fastify: ${integer(ours)} requests per second for \`GET /users/:id\`, against ${integer(nest)} for NestJS (${gap}% ${sign}) and ${integer(raw)} for hand-wired Fastify (see [Throughput](#throughput-and-latency)).`,
    )
  }
  return lines.join('\n')
}

export function renderBlocks(results: Results): Map<string, string> {
  return new Map([
    ['summary', summaryBlock(results)],
    ['environment', environmentBlock(results)],
    ['boot', bootBlock(results)],
    ['http', httpBlock(results)],
    ['di', diBlock(results)],
  ])
}

/** `page` with the content of each `<!-- benchmarks:<name> -->` block replaced. */
export function applyBlocks(page: string, blocks: ReadonlyMap<string, string>): string {
  let result = page
  for (const [name, content] of blocks) {
    const pattern = new RegExp(`(<!-- benchmarks:${name} -->)[\\s\\S]*?(<!-- /benchmarks:${name} -->)`)
    if (!pattern.test(result)) throw new Error(`docs/benchmarks.md has no '${name}' block`)
    result = result.replace(pattern, (_, start: string, end: string) => `${start}\n\n${content}\n\n${end}`)
  }
  return result
}

export function renderHighlights(results: Results): Highlights {
  return highlights(results)
}

/** Every generated file, by absolute path. */
export function renderAll(results: Results): Map<string, string> {
  const files = new Map<string, string>()
  for (const [name, content] of renderCharts(results)) files.set(join(CHARTS_DIR, name), content)
  files.set(PAGE, applyBlocks(readFileSync(PAGE, 'utf8'), renderBlocks(results)))
  files.set(HIGHLIGHTS_FILE, toJson(renderHighlights(results)))
  return files
}

if (import.meta.main) {
  const results = readResults()
  if (results === undefined) throw new Error('No results: run `bun run bench` first')
  const check = process.argv.includes('--check')
  const stale: string[] = []
  for (const [file, content] of renderAll(results)) {
    const current = existsSync(file) ? readFileSync(file, 'utf8') : undefined
    if (current === content) continue
    if (check) {
      stale.push(relative(REPO, file))
    } else {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, content)
      console.log(`wrote ${relative(REPO, file)}`)
    }
  }
  if (stale.length > 0) {
    console.error(`Out of date (run \`bun run --cwd benchmarks report\`):\n${stale.join('\n')}`)
    process.exit(1)
  }
}
