import { arrow, baseline, C, measure, node, rect, svg, text, V } from './lib.ts'

export function lifecycleStates(): string {
  const names = ['created', 'starting', 'ready', 'stopping', 'stopped'] as const
  const size = 13.5
  const widths = names.map(n => measure(n, size, { mono: true }) + 26)
  const gaps = [64, 44, 0, 44]
  const used = widths.reduce((a, b) => a + b, 0) + gaps.reduce((a, b) => a + b, 0)
  gaps[2] = 640 - used
  const y = 96
  const h = 40
  const cy = y + h / 2
  const xs: number[] = []
  let x = 24
  names.forEach((_, i) => {
    xs.push(x)
    x += widths[i]! + (gaps[i] ?? 0)
  })
  const cx = (i: number) => xs[i]! + widths[i]! / 2
  const right = (i: number) => xs[i]! + widths[i]!
  const variants = ['default', 'default', 'accent', 'default', 'default'] as const

  const body: string[] = []

  // entry point
  body.push(text(24, 36, '`Application.create()`', { size: 12.5, fill: C.text3 }))
  body.push(`<circle cx="${cx(0)}" cy="54" r="5" fill="${C.text3}"/>`)
  body.push(
    arrow([
      [cx(0), 60],
      [cx(0), y],
    ]),
  )

  // stop() called from a start hook: starting -> stopping, above the row
  const top = 62
  body.push(
    arrow(
      [
        [cx(1), y],
        [cx(1), top],
        [cx(3), top],
        [cx(3), y],
      ],
      { dashed: true, color: C.lineMuted, r: 12 },
    ),
  )
  body.push(
    text((cx(1) + cx(3)) / 2, top - 8, '`stop()` called from a start hook', {
      size: 12.5,
      fill: C.text3,
      anchor: 'middle',
    }),
  )

  // main row
  names.forEach((n, i) => {
    body.push(node({ x: xs[i]!, y, w: widths[i]!, h, title: n, mono: true, size, variant: variants[i] }))
  })
  // final state ring
  const ring = (i: number, color: string, yy = y) =>
    rect(xs[i]! + 3, yy + 3, widths[i]! - 6, h - 6, { stroke: color, rx: 7, sw: 1, fill: 'none' })
  body.push(ring(4, V.default.stroke))

  // transitions
  const tr = (i: number, label?: string, below?: string) => {
    const a = right(i)
    const b = xs[i + 1]!
    body.push(
      arrow([
        [a + 2, cy],
        [b - 2, cy],
      ]),
    )
    if (label) body.push(text((a + b) / 2, cy - 9, label, { size: 12.5, mono: true, fill: C.text2, anchor: 'middle' }))
    if (below) body.push(text((a + b) / 2, cy + 19, below, { size: 12, fill: C.text3, anchor: 'middle' }))
  }
  tr(0, 'start()')
  tr(1)
  tr(2, 'stop()', 'or a signal')
  tr(3)

  // failure branch
  const fy = 180
  const fw = widths[0]!
  const fx = cx(1) - fw / 2
  body.push(
    arrow(
      [
        [cx(1), y + h + 2],
        [cx(1), fy - 2],
      ],
      { color: V.err.stroke },
    ),
  )
  body.push(text(cx(1) + 10, baseline((y + h + fy) / 2, 12.5), 'a start hook fails', { size: 12.5, fill: V.err.sub }))
  body.push(node({ x: fx, y: fy, w: fw, h, title: 'failed', mono: true, size, variant: 'err' }))
  body.push(rect(fx + 3, fy + 3, fw - 6, h - 6, { stroke: V.err.stroke, rx: 7, sw: 1 }))

  // footnote
  body.push(text(664, 190, '`stopped` and `failed` are final:', { size: 12.5, fill: C.text3, anchor: 'end' }))
  body.push(
    text(664, 208, '`start()` rejects, `stop()` resolves at once', { size: 12.5, fill: C.text3, anchor: 'end' }),
  )

  return svg({
    h: 244,
    title: 'Application states',
    desc: 'State machine of app.state. Application.create() returns an application in the created state. start() moves it to starting, then to ready once every start hook ran. stop(), or a SIGINT or SIGTERM signal, moves it to stopping, then to stopped. A stop() called from a start hook goes straight from starting to stopping. A failing start hook moves it from starting to failed. stopped and failed are final.',
    body,
  })
}
