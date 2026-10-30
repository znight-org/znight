import { arrow, baseline, C, chip, eyebrow, line, rect, svg, text, V } from './lib.ts'

/** Build time vs run time: how the compiler, the generated module and the runtime fit together. */
export function overview(): string {
  const body: string[] = []
  const top = 52
  const h = 124
  const gap = 36
  const b1 = { x: 24, w: 150 }
  const b3 = { x: 460, w: 204 }
  const b2 = { x: b1.x + b1.w + gap, w: 0 }
  b2.w = b3.x - gap - b2.x
  const cy = top + h / 2

  body.push(eyebrow(24, 34, 'Build time'))

  // 1. your code
  body.push(rect(b1.x, top, b1.w, h, { fill: V.default.fill, stroke: V.default.stroke }))
  let x = b1.x + 14
  body.push(text(x, top + 26, 'Your code', { size: 14, weight: 600 }))
  body.push(text(x, top + 45, 'src/**/*.ts', { size: 12.5, mono: true, fill: C.text3 }))
  ;['@Injectable()', '@Controller()', '@Consumer() ...'].forEach((s, i) => {
    body.push(text(x, top + 72 + i * 18, s, { size: 12.5, mono: true, fill: C.text2 }))
  })

  // 2. the compiler
  body.push(rect(b2.x, top, b2.w, h, { fill: V.outline.fill, stroke: V.outline.stroke, sw: 1.5 }))
  x = b2.x + 14
  body.push(text(x, top + 26, '@znight/compiler', { size: 14, weight: 600, mono: true }))
  body.push(text(x, top + 45, 'Vite plugin · CLI · Bun preload', { size: 12.5, fill: C.text3 }))
  body.push(text(x, top + 76, 'scans and analyses your code,', { size: 12.5, fill: C.text2 }))
  body.push(text(x, top + 95, 'binds and validates the graph', { size: 12.5, fill: C.text2 }))

  // 3. the generated module
  body.push(rect(b3.x, top, b3.w, h, { fill: V.file.fill, stroke: V.file.stroke }))
  x = b3.x + 14
  body.push(text(x, top + 26, 'src/.znight/', { size: 12.5, mono: true, fill: C.text3 }))
  body.push(text(x, top + 45, 'container.generated.ts', { size: 12.5, mono: true, weight: 600 }))
  const [meta] = chip(x, top + 72, '__ZNIGHT_METADATA__', { mono: true, size: 12, padX: 7, h: 22, variant: 'violet' })
  body.push(meta)
  body.push(text(x, top + 108, 'providers, deps, order', { size: 12.5, fill: C.text3 }))

  // row arrows
  body.push(
    arrow([
      [b1.x + b1.w + 4, cy],
      [b2.x - 4, cy],
    ]),
  )
  body.push(
    arrow([
      [b2.x + b2.w + 4, cy],
      [b3.x - 4, cy],
    ]),
  )

  // diagnostics
  const dy = top + h + 34
  body.push(
    arrow(
      [
        [b2.x + b2.w / 2, top + h + 2],
        [b2.x + b2.w / 2, dy - 12],
      ],
      { color: V.err.stroke },
    ),
  )
  const [diag] = chip(b2.x + b2.w / 2, dy, '`ZNIGHTxxx` errors fail the build', {
    variant: 'err',
    anchor: 'middle',
    size: 12.5,
  })
  body.push(diag)

  // separator
  const sep = dy + 30
  body.push(line([24, sep], [664, sep], { dash: '3 5', color: C.lineMuted }))
  body.push(eyebrow(24, sep + 26, 'Run time'))

  // run time
  const rt = sep + 44
  const rh = 152
  const ax = b3.x + b3.w / 2
  body.push(
    arrow([
      [ax, top + h + 2],
      [ax, rt - 2],
    ]),
  )
  body.push(
    text(ax - 10, baseline(sep - 12, 12.5), 'imported by `main.ts`', { size: 12.5, fill: C.text3, anchor: 'end' }),
  )

  body.push(rect(24, rt, 640, rh, { fill: '#F4F6FC', opacity: 0.035, stroke: C.nodeStroke, rx: 12 }))
  body.push(text(38, rt + 26, 'Application.create({ metadata, plugins })', { size: 13, mono: true, weight: 600 }))

  const iy = rt + 42
  const ih = rh - 56
  const lw = 270
  body.push(rect(38, iy, lw, ih, { fill: V.default.fill, stroke: V.default.stroke }))
  body.push(text(52, iy + 24, '@znight/core', { size: 14, weight: 600, mono: true }))
  body.push(text(52, iy + 49, 'container · scopes · lifecycle', { size: 12.5, fill: C.text2 }))
  body.push(text(52, iy + 68, 'hooks · AOP', { size: 12.5, fill: C.text2 }))
  body.push(text(52, iy + 87, 'runs the generated factories in order', { size: 12.5, fill: C.text3 }))

  const px = 38 + lw + 14
  const pw = 650 - px
  body.push(rect(px, iy, pw, ih, { fill: V.default.fill, stroke: V.default.stroke }))
  body.push(text(px + 14, iy + 24, 'Runtime plugins', { size: 14, weight: 600 }))
  const rows = [
    ['HttpPlugin', 'ConfigPlugin'],
    ['MessagingPlugin', 'ObservabilityPlugin'],
  ]
  rows.forEach((row, r) => {
    let cx = px + 14
    for (const p of row) {
      const [c, w] = chip(cx, iy + 49 + r * 28, p, { mono: true, size: 12, padX: 7, h: 22 })
      body.push(c)
      cx += w + 6
    }
  })

  return svg({
    h: rt + rh + 24,
    title: 'How Znight fits together',
    desc: 'At build time, @znight/compiler (Vite plugin, CLI or Bun preload) reads your decorated classes in src, scans, analyses, binds and validates them, and generates src/.znight/container.generated.ts exporting __ZNIGHT_METADATA__; ZNIGHT errors fail the build. At run time, main.ts imports that module and passes it to Application.create with the plugins: the @znight/core container calls the generated factories in order, and plugins such as HttpPlugin, MessagingPlugin and ConfigPlugin add the runtime features.',
    body,
  })
}
