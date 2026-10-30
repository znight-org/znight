import { arrow, baseline, C, chip, eyebrow, rect, svg, text, V, type Variant } from './lib.ts'

/** The three parts of a feature package (@znight/http as the example). */
export function featurePackage(): string {
  const body: string[] = []
  const w = 196
  const g = 26
  const top = 50
  const h = 112
  const xs = [24, 24 + w + g, 24 + 2 * (w + g)]
  const cols: { eyebrow: string; title: string; code: string; lines: string[]; variant: Variant }[] = [
    {
      eyebrow: 'In your code',
      title: 'Decorators',
      code: '@Controller @Get @Body',
      lines: ['markers, no-ops at run time', 'stripped from the bundle'],
      variant: 'default',
    },
    {
      eyebrow: 'At build time',
      title: 'Compiler extension',
      code: '@znight/http/compiler',
      lines: ['found through the manifest', 'analyses the controllers'],
      variant: 'outline',
    },
    {
      eyebrow: 'At run time',
      title: 'Runtime plugin',
      code: 'HttpPlugin.configure()',
      lines: ['added to the application', 'serves the requests'],
      variant: 'default',
    },
  ]
  cols.forEach((c, i) => {
    const x = xs[i]!
    const v = V[c.variant]
    body.push(eyebrow(x, 34, c.eyebrow))
    body.push(rect(x, top, w, h, { fill: v.fill, stroke: v.stroke, sw: c.variant === 'outline' ? 1.5 : 1.25 }))
    body.push(text(x + 14, top + 26, c.title, { size: 14, weight: 600 }))
    body.push(text(x + 14, top + 47, c.code, { size: 12, mono: true, fill: C.text2 }))
    for (const [j, l] of c.lines.entries()) body.push(text(x + 14, top + 74 + j * 19, l, { size: 12.5, fill: C.text3 }))
    if (i < 2)
      body.push(
        arrow([
          [x + w + 3, top + h / 2],
          [xs[i + 1]! - 3, top + h / 2],
        ]),
      )
  })

  // metadata hand-off: compiler extension -> generated metadata -> runtime plugin
  const cy = top + h + 52
  const mid = (xs[1]! + w / 2 + xs[2]! + w / 2) / 2
  const [meta] = chip(mid, cy, '__ZNIGHT_METADATA__.extensions.http', {
    mono: true,
    size: 12,
    anchor: 'middle',
    variant: 'violet',
    h: 26,
  })
  body.push(meta)
  const down = xs[1]! + w / 2
  const up = xs[2]! + w / 2
  body.push(
    arrow([
      [down, top + h + 2],
      [down, cy - 15],
    ]),
  )
  body.push(text(down + 9, baseline((top + h + cy - 13) / 2, 12.5), 'emits', { size: 12.5, fill: C.text3 }))
  body.push(
    arrow([
      [up, cy - 15],
      [up, top + h + 2],
    ]),
  )
  body.push(text(up + 9, baseline((top + h + cy - 13) / 2, 12.5), 'reads', { size: 12.5, fill: C.text3 }))

  return svg({
    h: cy + 13 + 24,
    title: 'Anatomy of a feature package',
    desc: 'A feature package such as @znight/http has three parts. Decorators (@Controller, @Get, @Body) live in your code: markers that do nothing at run time and are stripped from the bundle. The compiler extension (@znight/http/compiler), found through the package manifest, analyses the controllers at build time and emits extensions.http in __ZNIGHT_METADATA__. The runtime plugin (HttpPlugin.configure()), added to the application, reads extensions.http and serves the requests.',
    body,
  })
}
