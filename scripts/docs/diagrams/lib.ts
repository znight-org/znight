// Tiny SVG toolkit for the Znight documentation diagrams (night card style).

export const W = 688

export const SANS = `ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`
export const MONO = `ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace`

export const C = {
  text1: '#F4F6FC',
  text2: '#D6DCEE',
  text3: '#A9B4D6',
  muted: '#8E9AC4',
  line: '#A9B4D6',
  lineMuted: '#7381B3',
  nodeFill: '#1E2858',
  nodeStroke: '#4A5AA6',
  laneFill: '#F4F6FC',
  cardStroke: '#2C3660',
  blue: '#3E7BFA',
  violet: '#8B5CF6',
}

export type Variant = 'default' | 'accent' | 'outline' | 'ok' | 'warn' | 'err' | 'violet' | 'ghost' | 'file'

export const V: Record<Variant, { fill: string; stroke: string; text: string; sub: string; dash?: string }> = {
  default: { fill: C.nodeFill, stroke: C.nodeStroke, text: C.text1, sub: C.text3 },
  accent: { fill: 'url(#zn-accent)', stroke: 'none', text: '#FFFFFF', sub: '#FFFFFF' },
  outline: { fill: '#1B2457', stroke: 'url(#zn-accent-line)', text: C.text1, sub: C.text3 },
  ok: { fill: '#0F3036', stroke: '#34D399', text: '#D1FAE5', sub: '#A7F3D0' },
  warn: { fill: '#33290F', stroke: '#FBBF24', text: '#FEF3C7', sub: '#FDE68A' },
  err: { fill: '#3A1A2E', stroke: '#FB7185', text: '#FFE4E6', sub: '#FECDD3' },
  violet: { fill: '#251E5C', stroke: '#A78BFA', text: '#EDE9FE', sub: '#C4B5FD' },
  ghost: { fill: 'none', stroke: C.lineMuted, text: C.text2, sub: C.text3, dash: '4 4' },
  file: { fill: '#141C44', stroke: C.nodeStroke, text: C.text1, sub: C.text3 },
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const r1 = (n: number) => Math.round(n * 10) / 10

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

export interface TextOpts {
  size?: number
  weight?: number
  fill?: string
  anchor?: 'start' | 'middle' | 'end'
  mono?: boolean
  ls?: number
}

/** Segments of a string where `code` spans are monospace. */
function segments(s: string): { t: string; mono: boolean }[] {
  const out: { t: string; mono: boolean }[] = []
  const parts = s.split('`')
  parts.forEach((t, i) => {
    if (t !== '') out.push({ t, mono: i % 2 === 1 })
  })
  return out
}

/** Approximate advance width (px) of a string (code spans in backticks are monospace). */
export function measure(s: string, size = 13, opts: { mono?: boolean; weight?: number } = {}): number {
  let w = 0
  for (const seg of opts.mono ? [{ t: s.replace(/`/g, ''), mono: true }] : segments(s)) {
    if (seg.mono) {
      w += seg.t.length * 0.6 * size
      continue
    }
    for (const ch of seg.t) {
      let f = 0.53
      if (/[ilj.,:;'|!()[\]{} ]/.test(ch)) f = 0.29
      else if (/[ftr]/.test(ch)) f = 0.36
      else if (/[mw]/.test(ch)) f = 0.8
      else if (/[A-Z]/.test(ch)) f = 0.66
      else if (/[0-9]/.test(ch)) f = 0.56
      w += f * size
    }
  }
  return w * ((opts.weight ?? 400) >= 600 ? 1.05 : 1)
}

/** A line of text; backtick spans are rendered in monospace (unless `mono` is set for the whole line). */
export function text(x: number, y: number, s: string, o: TextOpts = {}): string {
  const attrs = [`x="${r1(x)}"`, `y="${r1(y)}"`]
  if (o.anchor && o.anchor !== 'start') attrs.push(`text-anchor="${o.anchor}"`)
  attrs.push(`class="${o.mono ? 'm' : 's'}"`)
  attrs.push(`font-size="${o.size ?? 13}"`)
  if (o.weight && o.weight !== 400) attrs.push(`font-weight="${o.weight}"`)
  attrs.push(`fill="${o.fill ?? C.text1}"`)
  if (o.ls) attrs.push(`letter-spacing="${o.ls}"`)
  let body: string
  if (o.mono || !s.includes('`')) body = esc(s.replace(/`/g, ''))
  else
    body = segments(s)
      .map(seg => (seg.mono ? `<tspan class="m">${esc(seg.t)}</tspan>` : esc(seg.t)))
      .join('')
  return `<text ${attrs.join(' ')}>${body}</text>`
}

/** Baseline for a line of text visually centred on `cy`. */
export const baseline = (cy: number, size: number) => cy + size * 0.35

// ---------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------

export interface NodeOpts {
  x: number
  y: number
  w: number
  h: number
  title: string
  sub?: string | string[]
  variant?: Variant
  mono?: boolean
  size?: number
  subSize?: number
  subMono?: boolean
  rx?: number
  weight?: number
  align?: 'middle' | 'start'
}

export function rect(
  x: number,
  y: number,
  w: number,
  h: number,
  o: { fill?: string; stroke?: string; rx?: number; dash?: string; sw?: number; opacity?: number } = {},
): string {
  const a = [`x="${r1(x)}"`, `y="${r1(y)}"`, `width="${r1(w)}"`, `height="${r1(h)}"`, `rx="${o.rx ?? 10}"`]
  a.push(`fill="${o.fill ?? 'none'}"`)
  if (o.opacity !== undefined) a.push(`fill-opacity="${o.opacity}"`)
  if (o.stroke && o.stroke !== 'none') {
    a.push(`stroke="${o.stroke}"`)
    a.push(`stroke-width="${o.sw ?? 1.25}"`)
  }
  if (o.dash) a.push(`stroke-dasharray="${o.dash}"`)
  return `<rect ${a.join(' ')}/>`
}

export function node(o: NodeOpts): string {
  const v = V[o.variant ?? 'default']
  const size = o.size ?? 14
  const subSize = o.subSize ?? 12.5
  const subs = o.sub === undefined ? [] : ([] as string[]).concat(o.sub)
  const out = [rect(o.x, o.y, o.w, o.h, { fill: v.fill, stroke: v.stroke, rx: o.rx ?? 10, dash: v.dash, sw: 1.25 })]
  const gap = 5
  const lineH = subSize + 4
  const total = size + (subs.length > 0 ? gap + subs.length * lineH - 4 : 0)
  const top = o.y + (o.h - total) / 2
  const anchor = o.align ?? 'middle'
  const tx = anchor === 'middle' ? o.x + o.w / 2 : o.x + 14
  out.push(
    text(tx, baseline(top + size / 2, size), o.title, {
      size,
      weight: o.weight ?? (o.mono ? 500 : 600),
      fill: v.text,
      anchor,
      mono: o.mono,
    }),
  )
  subs.forEach((s, i) => {
    const cy = top + size + gap + i * lineH + subSize / 2
    out.push(text(tx, baseline(cy, subSize), s, { size: subSize, fill: v.sub, anchor, mono: o.subMono }))
  })
  return out.join('\n')
}

/** A small rounded label (chip). Returns [svg, width]. */
export function chip(
  x: number,
  cy: number,
  label: string,
  o: {
    mono?: boolean
    size?: number
    variant?: Variant
    anchor?: 'start' | 'middle' | 'end'
    padX?: number
    h?: number
  } = {},
): [string, number] {
  const size = o.size ?? 12.5
  const w = measure(label, size, { mono: o.mono }) * 1.04 + 2 * (o.padX ?? 10)
  const h = o.h ?? size + 11
  const shift = { middle: w / 2, end: w, start: 0 } as const
  const x0 = x - shift[o.anchor ?? 'start']
  const v = V[o.variant ?? 'default']
  return [
    [
      rect(x0, cy - h / 2, w, h, { fill: v.fill, stroke: v.stroke, rx: h / 2, sw: 1, dash: v.dash }),
      text(x0 + w / 2, baseline(cy, size), label, { size, fill: v.text, anchor: 'middle', mono: o.mono }),
    ].join('\n'),
    w,
  ]
}

/** A small numbered badge. */
export function badge(cx: number, cy: number, n: string | number, variant: Variant = 'accent'): string {
  const v = V[variant]
  return [
    `<circle cx="${r1(cx)}" cy="${r1(cy)}" r="10" fill="${v.fill}"${v.stroke === 'none' ? '' : ` stroke="${v.stroke}" stroke-width="1.25"`}/>`,
    text(cx, baseline(cy, 11.5), String(n), { size: 11.5, weight: 700, fill: v.text, anchor: 'middle' }),
  ].join('\n')
}

// ---------------------------------------------------------------------------------------------
// Arrows
// ---------------------------------------------------------------------------------------------

export type P = [number, number]

function roundedPath(pts: P[], r: number): string {
  const f = (p: P) => `${r1(p[0])},${r1(p[1])}`
  let d = `M${f(pts[0]!)}`
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1]!
    const p1 = pts[i]!
    const p2 = pts[i + 1]!
    const l1 = Math.hypot(p1[0] - p0[0], p1[1] - p0[1])
    const l2 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1])
    const rr = Math.min(r, l1 / 2, l2 / 2)
    const a: P = [p1[0] - ((p1[0] - p0[0]) / l1) * rr, p1[1] - ((p1[1] - p0[1]) / l1) * rr]
    const b: P = [p1[0] + ((p2[0] - p1[0]) / l2) * rr, p1[1] + ((p2[1] - p1[1]) / l2) * rr]
    d += ` L${f(a)} Q${f(p1)} ${f(b)}`
  }
  d += ` L${f(pts[pts.length - 1]!)}`
  return d
}

export interface ArrowOpts {
  color?: string
  dashed?: boolean
  width?: number
  r?: number
  head?: boolean
  curve?: boolean
}

/** A polyline with rounded corners and a solid arrowhead at its last point. */
export function arrow(pts: P[], o: ArrowOpts = {}): string {
  const color = o.color ?? C.line
  const width = o.width ?? 1.5
  const L = 8.5
  const H = 4.6
  const end = pts[pts.length - 1]!
  const prev = pts[pts.length - 2]!
  const len = Math.hypot(end[0] - prev[0], end[1] - prev[1])
  const ux = (end[0] - prev[0]) / len
  const uy = (end[1] - prev[1]) / len
  const head = o.head ?? true
  const line = [...pts]
  if (head) line[line.length - 1] = [end[0] - ux * (L - 1), end[1] - uy * (L - 1)]
  const d = roundedPath(line, o.r ?? 8)
  const parts = [
    `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"${o.dashed ? ' stroke-dasharray="5 4"' : ''}/>`,
  ]
  if (head) {
    const bx = end[0] - ux * L
    const by = end[1] - uy * L
    const p1: P = [bx - uy * H, by + ux * H]
    const p2: P = [bx + uy * H, by - ux * H]
    parts.push(
      `<path d="M${r1(end[0])},${r1(end[1])} L${r1(p1[0])},${r1(p1[1])} L${r1(p2[0])},${r1(p2[1])} Z" fill="${color}"/>`,
    )
  }
  return parts.join('\n')
}

/** A cubic curve arrow from a to b with control points c1, c2. */
export function curveArrow(a: P, c1: P, c2: P, b: P, o: ArrowOpts = {}): string {
  const color = o.color ?? C.line
  const width = o.width ?? 1.5
  const L = 8.5
  const H = 4.6
  const len = Math.hypot(b[0] - c2[0], b[1] - c2[1])
  const ux = (b[0] - c2[0]) / len
  const uy = (b[1] - c2[1]) / len
  const tip: P = [b[0] - ux * (L - 1), b[1] - uy * (L - 1)]
  const bx = b[0] - ux * L
  const by = b[1] - uy * L
  const p1: P = [bx - uy * H, by + ux * H]
  const p2: P = [bx + uy * H, by - ux * H]
  return [
    `<path d="M${r1(a[0])},${r1(a[1])} C${r1(c1[0])},${r1(c1[1])} ${r1(c2[0])},${r1(c2[1])} ${r1(tip[0])},${r1(tip[1])}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round"${o.dashed ? ' stroke-dasharray="5 4"' : ''}/>`,
    `<path d="M${r1(b[0])},${r1(b[1])} L${r1(p1[0])},${r1(p1[1])} L${r1(p2[0])},${r1(p2[1])} Z" fill="${color}"/>`,
  ].join('\n')
}

export function line(a: P, b: P, o: { color?: string; dash?: string; width?: number } = {}): string {
  return `<line x1="${r1(a[0])}" y1="${r1(a[1])}" x2="${r1(b[0])}" y2="${r1(b[1])}" stroke="${o.color ?? C.lineMuted}" stroke-width="${o.width ?? 1}"${o.dash ? ` stroke-dasharray="${o.dash}"` : ''}/>`
}

/** Small caps section label. */
export function eyebrow(
  x: number,
  y: number,
  s: string,
  o: { anchor?: 'start' | 'middle' | 'end'; fill?: string } = {},
): string {
  return text(x, y, s.toUpperCase(), { size: 12, weight: 700, fill: o.fill ?? C.muted, ls: 1.2, anchor: o.anchor })
}

// ---------------------------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------------------------

export function svg(o: { h: number; w?: number; title: string; desc: string; body: string[] }): string {
  const w = o.w ?? W
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${o.h}" width="${w}" height="${o.h}" role="img" aria-labelledby="title desc">
<title id="title">${esc(o.title)}</title>
<desc id="desc">${esc(o.desc)}</desc>
<defs>
<linearGradient id="zn-card" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#1A2350"/>
<stop offset="1" stop-color="#0B1020"/>
</linearGradient>
<linearGradient id="zn-accent" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#2F6AE8"/>
<stop offset="1" stop-color="#7C4DEF"/>
</linearGradient>
<linearGradient id="zn-accent-line" x1="0" y1="0" x2="1" y2="0">
<stop offset="0" stop-color="#3E7BFA"/>
<stop offset="1" stop-color="#8B5CF6"/>
</linearGradient>
<style>.s{font-family:${SANS}}.m{font-family:${MONO}}</style>
</defs>
<rect x="0.5" y="0.5" width="${w - 1}" height="${o.h - 1}" rx="16" fill="url(#zn-card)" stroke="${C.cardStroke}"/>
${o.body.join('\n')}
</svg>
`
}
