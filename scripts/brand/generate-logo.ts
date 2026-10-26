// Generator for the "knight" concept: writes mark.svg and logo.svg next to this file.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Generates the Znight brand marks (docs/public/mark.svg and docs/public/logo.svg).
 * Usage: bun scripts/brand/generate-logo.ts
 */
const dir = join(import.meta.dir, '../../docs/public')
const WORD_MODE = process.env.WORD ?? 'gradient' // 'gradient' | 'split'
const MOON = process.env.MOON === '1'

// ---- palette ----
const NAVY_TOP = '#1A2350'
const NAVY_BOT = '#0B1020'
const SHADES = {
  L: '#F4F6FC', // lit facets
  M: '#D6DCEE',
  D: '#A9B4D6',
  X: '#7F8CB8', // deepest shadow
}
const ACC_A = '#3E7BFA'
const ACC_B = '#8B5CF6'
const SLATE = '#6B7AA6'

type P = [number, number]
const fmt = (ps: P[]) => ps.map(([x, y]) => `${x},${y}`).join(' ')

// ---- knight silhouette (facing left), clockwise from the ear tip ----
const pts: Record<string, P> = {
  a: [288, 72], // ear tip
  u: [308, 120], // ear back / notch
  p: [322, 112], // mane top
  o: [354, 146], // back upper
  n: [382, 208], // back
  m: [388, 294], // back
  l: [362, 372], // back base
  k: [176, 372], // chest base
  j: [196, 320], // chest
  i: [240, 262], // throat
  h: [208, 288], // chin
  g: [176, 270], // mouth notch
  f: [136, 280], // lip bottom
  e: [116, 250], // nose front
  d: [134, 210], // nose bridge
  c: [198, 148], // brow
  b: [256, 124], // ear front base
  // interior
  r: [298, 172],
  q: [236, 196],
  t: [196, 232],
  s: [292, 300],
  w: [308, 240],
}
const silhouetteOrder = 'aupnmlkjihgfedcb'

const facets: [string, keyof typeof SHADES][] = [
  ['aub', 'M'],
  ['bur', 'L'],
  ['upr', 'M'],
  ['por', 'M'],
  ['bcr', 'L'],
  ['crq', 'M'],
  ['cqd', 'L'],
  ['dqt', 'M'],
  ['dte', 'L'],
  ['etf', 'M'],
  ['tgf', 'D'],
  ['qri', 'M'],
  ['tqi', 'D'],
  ['tih', 'X'],
  ['thg', 'D'],
  ['ron', 'D'],
  ['rnw', 'M'],
  ['rwi', 'L'],
  ['iws', 'L'],
  ['isj', 'M'],
  ['jsk', 'L'],
  ['ksl', 'M'],
  ['wnm', 'D'],
  ['wms', 'D'],
  ['sml', 'X'],
]

// mane teeth (accent): base on the back edge, apex hanging down into the neck
const mane: P[][] = [
  [pts.p!, pts.o!, [314, 176]],
  [pts.o!, pts.n!, [338, 240]],
  [pts.n!, pts.m!, [354, 322]],
]
const eye: P[] = [
  [230, 176],
  [258, 178],
  [240, 190],
]

const poly = (names: string) => fmt(names.split('').map(n => pts[n]!))

function markInner(idp: string) {
  const tri = facets.map(([n, s]) => `<polygon points="${poly(n)}" fill="${SHADES[s]}"/>`).join('\n    ')
  const moon = MOON
    ? `<path d="M 150 92 A 34 34 0 1 0 186 140 A 27 27 0 1 1 150 92 Z" fill="${SHADES.M}" opacity="0.9"/>`
    : ''
  return `<rect x="24" y="24" width="464" height="464" rx="112" fill="url(#${idp}tile)"/>
  <rect x="26" y="26" width="460" height="460" rx="110" fill="none" stroke="url(#${idp}rim)" stroke-width="4"/>
  ${moon}
  <g>
    <polygon points="${poly(silhouetteOrder)}" fill="${SHADES.D}"/>
    ${tri}
    ${mane.map(t => `<polygon points="${fmt(t)}" fill="url(#${idp}mane)"/>`).join('\n    ')}
    <polygon points="${fmt(eye)}" fill="${NAVY_BOT}"/>
  </g>
  <rect x="166" y="384" width="206" height="20" rx="3" fill="${SHADES.M}"/>
  <rect x="146" y="414" width="246" height="26" rx="3" fill="url(#${idp}base)"/>`
}

function markDefs(idp: string) {
  return `<linearGradient id="${idp}tile" x1="256" y1="24" x2="256" y2="488" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${NAVY_TOP}"/>
      <stop offset="1" stop-color="${NAVY_BOT}"/>
    </linearGradient>
    <linearGradient id="${idp}rim" x1="256" y1="24" x2="256" y2="488" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#5B6BB8" stop-opacity="0.4"/>
      <stop offset="0.5" stop-color="#5B6BB8" stop-opacity="0.12"/>
      <stop offset="1" stop-color="#5B6BB8" stop-opacity="0.05"/>
    </linearGradient>
    <linearGradient id="${idp}mane" x1="330" y1="110" x2="370" y2="330" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${ACC_A}"/>
      <stop offset="1" stop-color="${ACC_B}"/>
    </linearGradient>
    <linearGradient id="${idp}base" x1="146" y1="0" x2="392" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${ACC_A}"/>
      <stop offset="1" stop-color="${ACC_B}"/>
    </linearGradient>`
}

const mark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <title>Znight</title>
  <defs>
    ${markDefs('zn-')}
  </defs>
  ${markInner('zn-')}
</svg>
`
writeFileSync(join(dir, 'mark.svg'), mark)

// ---- wordmark (units: baseline at y=0, x-height 52, cap 72, stroke 14) ----
const Z = `<polygon points="0,-72 52,-72 52,-58 18,-14 52,-14 52,0 0,0 0,-14 34,-58 0,-58"/>`
const strokes = [
  // n
  'M71,-52 V0',
  'M71,-26 A19,19 0 0 1 109,-26 V0',
  // i
  'M136,-52 V0',
  // g
  'M201,-26 A19,19 0 1 1 163,-26 A19,19 0 1 1 201,-26',
  'M201,-52 V4 A19,19 0 0 1 162,8',
  // h
  'M228,-72 V0',
  'M228,-26 A19,19 0 0 1 266,-26 V0',
  // t
  'M296,-66 V0',
  'M280,-45 H312',
].join(' ')
const iDot = `<polygon points="136,-76 145,-67 136,-58 127,-67"/>`
const WORD_W = 312

function wordmark(idp: string) {
  const zFill = `url(#${idp}word)`
  const restFill = WORD_MODE === 'split' ? SLATE : `url(#${idp}word)`
  return `<g fill="${zFill}">${Z}</g>
    <path d="${strokes}" fill="none" stroke="${restFill}" stroke-width="14" stroke-linecap="butt"/>
    <g fill="${restFill}">${iDot}</g>`
}

// lockup geometry
const TILE = 240
const PAD = 20
const s = TILE / 464
const markX = PAD - 24 * s
const markY = PAD - 24 * s
const ws = 1.3
const wordX = PAD + TILE + 0.2 * TILE
const center = PAD + TILE / 2
const baseline = center + (72 * ws) / 2
const W = Math.round(wordX + WORD_W * ws + PAD)
const H = TILE + PAD * 2

const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <title>Znight</title>
  <defs>
    ${markDefs('zl-')}
    <linearGradient id="zl-word" x1="0" y1="0" x2="${WORD_W}" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${ACC_A}"/>
      <stop offset="1" stop-color="${ACC_B}"/>
    </linearGradient>
  </defs>
  <g transform="translate(${markX.toFixed(3)} ${markY.toFixed(3)}) scale(${s.toFixed(5)})">
  ${markInner('zl-')}
  </g>
  <g transform="translate(${wordX.toFixed(2)} ${baseline.toFixed(2)}) scale(${ws})">
    ${wordmark('zl-')}
  </g>
</svg>
`
writeFileSync(join(dir, 'logo.svg'), logo)
console.log('wrote mark.svg + logo.svg', { W, H })
