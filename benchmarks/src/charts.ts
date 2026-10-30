/**
 * The charts of the benchmarks page (`docs/public/benchmarks/*.svg`), in the night card style of the
 * documentation diagrams (`scripts/docs/diagrams/lib.ts`): horizontal bars, one per runtime, Znight
 * in the accent gradient and everything else in silver. Deterministic: the same results give the
 * same files.
 */
import type { Highlights } from './highlights.ts'

import { C, esc, eyebrow, measure, rect, svg, text, W } from '../../scripts/docs/diagrams/lib.ts'

export interface BarRow {
  /** Group label, shown on the first row of each group (`Fastify`, `1,000 providers`). */
  readonly group: string
  readonly label: string
  /** Drawn in the accent gradient. */
  readonly highlight: boolean
  /** One value per series; `undefined` when not measured. */
  readonly values: readonly (number | undefined)[]
}

export interface BarChart {
  readonly title: string
  readonly subtitle: string
  /** Series names, in the order of `BarRow.values` (`Node.js 24.21.0`, `Bun 1.4.4`). */
  readonly series: readonly string[]
  readonly rows: readonly BarRow[]
  readonly format: (value: number) => string
  /** Text alternative (the `<desc>` of the SVG). */
  readonly description: string
}

const PAD = 24
const BAR_H = 12
const BAR_GAP = 4
const ROW_GAP = 12
const GROUP_GAP = 14
const VALUE_W = 64
/** Series fills of the silver bars, then of the Znight bars. */
const SILVER = ['#A9B4D6', '#5D6A9C'] as const
const ACCENT = ['url(#zn-accent-line)', 'url(#zn-accent-soft)'] as const

/** A horizontal bar chart: rows grouped, one bar per series, the value at the end of each bar. */
export function barChart(chart: BarChart): string {
  const body: string[] = []
  body.push(eyebrow(PAD, 36, chart.title))
  body.push(text(PAD, 60, chart.subtitle, { size: 13, fill: C.text3 }))

  // legend, right-aligned on the title line
  let legendX = W - PAD
  for (let index = chart.series.length - 1; index >= 0; index--) {
    const name = chart.series[index] ?? ''
    const width = measure(name, 12)
    legendX -= width
    body.push(text(legendX, 36, name, { size: 12, fill: C.text2 }))
    legendX -= 16
    body.push(rect(legendX, 27, 10, 10, { fill: SILVER[index] ?? SILVER[0], rx: 3 }))
    legendX -= 18
  }

  const groupW = Math.max(...chart.rows.map(row => measure(row.group, 13, { weight: 600 }))) + 20
  const labelW = Math.max(...chart.rows.map(row => measure(row.label, 13, { weight: 600 }))) + 16
  const x0 = PAD + groupW + labelW
  const maxW = W - PAD - VALUE_W - x0
  const max = Math.max(...chart.rows.flatMap(row => row.values.filter((v): v is number => v !== undefined)))
  const seriesH = chart.series.length * BAR_H + (chart.series.length - 1) * BAR_GAP

  let y = 86
  let previous: string | undefined
  for (const row of chart.rows) {
    if (row.group !== previous) {
      if (previous !== undefined) {
        y += GROUP_GAP - ROW_GAP
        body.push(
          `<line x1="${PAD}" y1="${y - GROUP_GAP / 2}" x2="${W - PAD}" y2="${y - GROUP_GAP / 2}" stroke="${C.cardStroke}" stroke-width="1"/>`,
        )
        y += 4
      }
      body.push(text(PAD, y + seriesH / 2 + 4.5, row.group, { size: 13, weight: 600, fill: C.text1 }))
      previous = row.group
    }
    const labelFill = row.highlight ? C.text1 : C.text2
    body.push(
      text(PAD + groupW, y + seriesH / 2 + 4.5, row.label, {
        size: 13,
        weight: row.highlight ? 600 : 400,
        fill: labelFill,
      }),
    )
    row.values.forEach((value, index) => {
      const top = y + index * (BAR_H + BAR_GAP)
      if (value === undefined) {
        body.push(text(x0, top + BAR_H - 2, 'not measured', { size: 11, fill: C.muted }))
        return
      }
      const width = Math.max((value / max) * maxW, 3)
      const fill = row.highlight ? (ACCENT[index] ?? ACCENT[0]) : (SILVER[index] ?? SILVER[0])
      body.push(rect(x0, top, width, BAR_H, { fill, rx: 3 }))
      body.push(
        text(x0 + width + 8, top + BAR_H - 2, chart.format(value), {
          size: 12,
          weight: row.highlight ? 600 : 400,
          fill: row.highlight ? C.text1 : C.text3,
        }),
      )
    })
    y += seriesH + ROW_GAP
  }

  return withAccentSoft(
    svg({ h: Math.round(y + PAD - ROW_GAP + 8), title: chart.title, desc: chart.description, body }),
  )
}

/** Adds the soft accent gradient (the Bun bars of Znight) to the shared definitions. */
function withAccentSoft(document: string): string {
  const soft = [
    '<linearGradient id="zn-accent-soft" x1="0" y1="0" x2="1" y2="0">',
    '<stop offset="0" stop-color="#3E7BFA" stop-opacity="0.55"/>',
    '<stop offset="1" stop-color="#8B5CF6" stop-opacity="0.55"/>',
    '</linearGradient>',
  ].join('\n')
  return document.replace('<style>', `${soft}\n<style>`)
}

/** The headline numbers as a card (the root README shows it): one column per highlight. */
export function highlightsCard(highlights: Highlights): string {
  const width = 880
  const height = 236
  const columns = highlights.items.length
  const columnW = (width - 2 * PAD) / Math.max(columns, 1)
  const body: string[] = []
  highlights.items.forEach((item, index) => {
    const cx = PAD + columnW * index + columnW / 2
    body.push(
      `<text x="${cx}" y="104" text-anchor="middle" class="s" font-size="64" font-weight="700" letter-spacing="-1.5" fill="url(#zn-accent-line)">${esc(item.value)}</text>`,
    )
    body.push(text(cx, 140, item.label, { size: 16, weight: 600, fill: C.text1, anchor: 'middle' }))
    body.push(text(cx, 164, item.detail, { size: 13, fill: C.text3, anchor: 'middle' }))
    if (index > 0) {
      const x = PAD + columnW * index
      body.push(`<line x1="${x}" y1="56" x2="${x}" y2="172" stroke="${C.cardStroke}" stroke-width="1"/>`)
    }
  })
  body.push(text(width / 2, 210, highlights.context, { size: 12, fill: C.muted, anchor: 'middle' }))
  const description = highlights.items.map(item => `${item.value} ${item.label} (${item.detail})`).join('; ')
  return svg({ w: width, h: height, title: 'Znight benchmarks', desc: `${description}. ${highlights.context}.`, body })
}
