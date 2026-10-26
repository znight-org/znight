import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Generates the Znight brand marks (docs/public/mark.svg and docs/public/logo.svg).
 * Usage: bun scripts/brand/generate-logo.ts
 */
const OUT = join(import.meta.dir, '../../docs/public')
const f = (n: number) => Number(n.toFixed(2)).toString()
const pt = (x: number, y: number) => `${f(x)},${f(y)}`

const C = {
  bgTop: '#272F88',
  bgBot: '#0E1332',
  litA: '#FFE38F',
  litB: '#FF9F2E',
  shadeA: '#5246DA',
  shadeB: '#2F2892',
  word: '#7360FF',
  star: '',
}
Object.assign(C, JSON.parse(process.env.PALETTE ?? '{}'))
const SUFFIX = process.env.SUFFIX ?? ''

/** horizontal width w of a Z diagonal so that its perpendicular thickness equals t */
function solveW(W: number, V: number, t: number) {
  let lo = 0
  let hi = W
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2
    const th = (mid * V) / Math.hypot(W - mid, V)
    if (th < t) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

type MarkOpts = { cx: number; cy: number; r: number; Hh: number; h: number; D: number; t: number }

function moonPieces(o: MarkOpts) {
  const { cx, cy, r, Hh, h, D, t } = o
  const T = cy - Hh
  const B = cy + Hh
  const R = cx + D
  const L = cx - D
  const V = B - T - 2 * h
  const w = solveW(R - L, V, t)
  const dx = (y: number) => Math.sqrt(r * r - (y - cy) ** 2)
  const ang = (x: number, y: number) => Math.atan2(y - cy, x - cx)
  const arcCCW = (sx: number, sy: number, ex: number, ey: number) => {
    let span = ang(sx, sy) - ang(ex, ey)
    while (span < 0) span += Math.PI * 2
    const large = span > Math.PI ? 1 : 0
    return `A${f(r)} ${f(r)} 0 ${large} 0 ${pt(ex, ey)}`
  }
  // upper-right piece: top cap + right wedge
  const c1x = cx - dx(T)
  const c5x = cx + dx(B - h)
  const upper = `M${pt(c1x, T)}L${pt(R, T)}L${pt(R, T + h)}L${pt(L + w, B - h)}L${pt(c5x, B - h)}${arcCCW(c5x, B - h, c1x, T)}Z`
  // lower-left piece: left wedge + bottom cap
  const a1x = cx + dx(B)
  const a5x = cx - dx(T + h)
  const lower = `M${pt(a1x, B)}L${pt(L, B)}L${pt(L, B - h)}L${pt(R - w, T + h)}L${pt(a5x, T + h)}${arcCCW(a5x, T + h, a1x, B)}Z`
  return { upper, lower }
}

const markOpts: MarkOpts = {
  cx: 256,
  cy: 256,
  r: 180,
  Hh: 112,
  h: 48,
  D: 96,
  t: 48,
  ...JSON.parse(process.env.MARK ?? '{}'),
}

function markDefs(id: string) {
  return `
    <linearGradient id="${id}-bg" x1="0" y1="0" x2="0.6" y2="1">
      <stop offset="0" stop-color="${C.bgTop}"/>
      <stop offset="1" stop-color="${C.bgBot}"/>
    </linearGradient>
    <linearGradient id="${id}-lit" x1="0.2" y1="0" x2="0.8" y2="1">
      <stop offset="0" stop-color="${C.litA}"/>
      <stop offset="1" stop-color="${C.litB}"/>
    </linearGradient>
    <linearGradient id="${id}-shade" x1="0.2" y1="0" x2="0.8" y2="1">
      <stop offset="0" stop-color="${C.shadeA}"/>
      <stop offset="1" stop-color="${C.shadeB}"/>
    </linearGradient>`
}

function markBody(id: string) {
  const { upper, lower } = moonPieces(markOpts)
  return `
    <rect width="512" height="512" rx="116" fill="url(#${id}-bg)"/>
    <path d="${upper}" fill="url(#${id}-shade)"/>
    <path d="${lower}" fill="url(#${id}-lit)"/>${C.star ? star(C.star) : ''}`
}

function star(color: string) {
  // 4-point sparkle
  const x = 392
  const y = 112
  const R = 26
  const k = 5
  const d = `M${x},${y - R}Q${x + k},${y - k} ${x + R},${y}Q${x + k},${y + k} ${x},${y + R}Q${x - k},${y + k} ${x - R},${y}Q${x - k},${y - k} ${x},${y - R}Z`
  return `<path d="${d}" fill="${color}"/>`
}

// ---------- wordmark ----------
const S = 44 // stem
const BASE = 376
const XH = 206 // x-height top
const ASC = 136 // ascender / cap top

function zGlyph(x0: number) {
  const W = 182
  const T = ASC
  const Bt = BASE
  const h = 40
  const L = x0
  const R = x0 + W
  const V = Bt - T - 2 * h
  const w = solveW(W, V, 47)
  const d = `M${pt(L, T)}L${pt(R, T)}L${pt(R, T + h)}L${pt(L + w, Bt - h)}L${pt(R, Bt - h)}L${pt(R, Bt)}L${pt(L, Bt)}L${pt(L, Bt - h)}L${pt(R - w, T + h)}L${pt(L, T + h)}Z`
  return { svg: `<path d="${d}" stroke="none"/>`, width: W }
}

function archGlyph(x0: number, stemTop: number) {
  const r = 56
  const sx = x0 + S / 2
  const ex = sx + 2 * r
  const cy = XH + S / 2 + r - 2 // 2px overshoot
  const d = `M${pt(sx, BASE)}V${f(stemTop)}M${pt(sx, cy)}A${r} ${r} 0 0 1 ${pt(ex, cy)}V${f(BASE)}`
  return { svg: `<path d="${d}" fill="none" stroke-width="${S}"/>`, width: 2 * r + S }
}

function iGlyph(x0: number) {
  const sx = x0 + S / 2
  return {
    svg: `<path d="M${pt(sx, BASE)}V${f(XH)}" fill="none" stroke-width="${S}"/><circle cx="${f(sx)}" cy="156" r="26" stroke="none"/>`,
    width: S,
  }
}

function gGlyph(x0: number) {
  const r = 63
  const cx = x0 + r + S / 2
  const cy = XH + S / 2 + r
  const ro = r + S / 2 // outer radius of the tail
  const ri = r - S / 2 // inner radius of the tail
  const hy = Number(process.env.GHY ?? 380) // tail centre
  const c = Number(process.env.GCUT ?? 22) // vertical cut, px left of the bowl centre
  const yo = hy + Math.sqrt(ro * ro - c * c)
  const yi = hy + Math.sqrt(ri * ri - c * c)
  const tail = `M${pt(cx + ri, XH)}H${f(cx + ro)}V${f(hy)}A${ro} ${ro} 0 0 1 ${pt(cx - c, yo)}V${f(yi)}A${ri} ${ri} 0 0 0 ${pt(cx + ri, hy)}Z`
  return {
    svg: `<circle cx="${f(cx)}" cy="${f(cy)}" r="${r}" fill="none" stroke-width="${S}"/><path d="${tail}" stroke="none"/>`,
    width: 2 * r + S,
  }
}

function tGlyph(x0: number) {
  const cw = 96
  const sx = x0 + cw / 2
  return {
    svg: `<path d="M${pt(sx, 150)}V${f(BASE)}" fill="none" stroke-width="${S}"/><path d="M${pt(x0, XH + 20)}H${f(x0 + cw)}" fill="none" stroke-width="40"/>`,
    width: cw,
  }
}

function wordmark(x: number) {
  const parts: string[] = []
  let cur = x
  const add = (g: { svg: string; width: number }, after: number) => {
    parts.push(g.svg)
    cur += g.width + after
  }
  add(zGlyph(cur), 20)
  add(archGlyph(cur, XH), 34)
  add(iGlyph(cur), 28)
  add(gGlyph(cur), 32)
  add(archGlyph(cur, ASC), 22)
  add(tGlyph(cur), 0)
  return { svg: parts.join(''), end: cur }
}

// ---------- write ----------
const mark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <title>Znight</title>
  <defs>${markDefs('zm')}
  </defs>${markBody('zm')}
</svg>
`
writeFileSync(join(OUT, `mark${SUFFIX}.svg`), mark)

const gap = Number(process.env.GAP ?? 84)
const k = Number(process.env.WSCALE ?? 0.9)
const wm = wordmark(0)
const totalW = Math.ceil(512 + gap + wm.end * k + 4)
const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalW} 512" width="${totalW}" height="512">
  <title>Znight</title>
  <defs>${markDefs('zl')}
  </defs>${markBody('zl')}
  <g transform="translate(${512 + gap} ${f(256 - 256 * k)}) scale(${k})" fill="${C.word}" stroke="${C.word}" stroke-linecap="butt" stroke-linejoin="miter">${wm.svg}</g>
</svg>
`
writeFileSync(join(OUT, `logo${SUFFIX}.svg`), logo)
console.log('ok', totalW)
