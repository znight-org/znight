import { arrow, badge, C, chip, node, rect, svg, text, V } from './lib.ts'

/** The compiler pipeline: scan → parse → resolve → analyse → bind → validate → emit. */
export function compilerPipeline(): string {
  const body: string[] = []
  const h = 62

  // row 1
  const y1 = 76
  const w1 = 139
  const g1 = 28
  const row1 = [
    { n: 1, title: 'scan', sub: ['include / exclude', '+ provider libraries'] },
    { n: 2, title: 'parse', sub: ['oxc · per-file facts'] },
    { n: 3, title: 'resolve identities', sub: ['canonical ids'] },
    { n: 4, title: 'analyse classes', sub: ['core + extensions'] },
  ]
  const x1 = (i: number) => 24 + i * (w1 + g1)

  // input
  const [input] = chip(x1(0) + w1 / 2, 34, 'src/**/*.ts', {
    mono: true,
    size: 12,
    anchor: 'middle',
    variant: 'file',
    h: 24,
  })
  body.push(input)
  body.push(
    arrow([
      [x1(0) + w1 / 2, 47],
      [x1(0) + w1 / 2, y1 - 2],
    ]),
  )

  // cache group around step 2
  body.push(rect(x1(1) - 8, y1 - 10, w1 + 16, h + 20, { stroke: C.lineMuted, dash: '4 4', rx: 14 }))
  body.push(text(x1(1) + w1 / 2, 40, 'cached per file', { size: 12.5, fill: C.text3, anchor: 'middle' }))
  body.push(text(x1(1) + w1 / 2, 57, '(content hash)', { size: 12.5, fill: C.text3, anchor: 'middle' }))

  row1.forEach((s, i) => {
    body.push(node({ x: x1(i), y: y1, w: w1, h, title: s.title, sub: s.sub, size: 13.5, subSize: 12 }))
    body.push(badge(x1(i) + 2, y1 + 2, s.n))
    if (i < row1.length - 1)
      body.push(
        arrow([
          [x1(i) + w1 + 3, y1 + h / 2],
          [x1(i + 1) - 3, y1 + h / 2],
        ]),
      )
  })

  // row 2
  const y2 = y1 + h + 64
  const w2 = 120
  const g2 = 28
  const x2 = (i: number) => 24 + i * (w2 + g2)
  const row2 = [
    { n: 5, title: 'bind', sub: ['injection points'] },
    { n: 6, title: 'validate', sub: ['the whole graph'] },
    { n: 7, title: 'emit', sub: ['re-parse check'] },
  ]

  // wrap connector: analyse classes -> bind
  const wy = y1 + h + 32
  body.push(
    arrow(
      [
        [x1(3) + w1 / 2, y1 + h + 2],
        [x1(3) + w1 / 2, wy],
        [x2(0) + w2 / 2, wy],
        [x2(0) + w2 / 2, y2 - 2],
      ],
      { r: 12 },
    ),
  )

  row2.forEach((s, i) => {
    body.push(node({ x: x2(i), y: y2, w: w2, h, title: s.title, sub: s.sub, size: 13.5, subSize: 12 }))
    body.push(badge(x2(i) + 2, y2 + 2, s.n))
    if (i < row2.length - 1)
      body.push(
        arrow([
          [x2(i) + w2 + 3, y2 + h / 2],
          [x2(i + 1) - 3, y2 + h / 2],
        ]),
      )
  })

  // output
  const ox = x2(3)
  const ow = 664 - ox
  body.push(
    arrow([
      [x2(2) + w2 + 3, y2 + h / 2],
      [ox - 3, y2 + h / 2],
    ]),
  )
  body.push(rect(ox, y2, ow, h, { fill: V.file.fill, stroke: 'url(#zn-accent-line)', sw: 1.5 }))
  body.push(
    text(ox + ow / 2, y2 + 25, 'container.generated.ts', { size: 12.5, mono: true, weight: 600, anchor: 'middle' }),
  )
  body.push(text(ox + ow / 2, y2 + 44, 'written if its content changed', { size: 12, fill: C.text3, anchor: 'middle' }))

  // diagnostics
  const dy = y2 + h + 40
  const dx = x2(1) + w2 / 2
  body.push(
    arrow(
      [
        [dx, y2 + h + 2],
        [dx, dy - 13],
      ],
      { color: V.err.stroke },
    ),
  )
  const [diag] = chip(dx, dy, '`ZNIGHT001`, `002`, `003`... with code frames', {
    variant: 'err',
    anchor: 'middle',
    size: 12,
  })
  body.push(diag)

  return svg({
    h: dy + 36,
    title: 'Compiler pipeline',
    desc: 'The seven steps of the Znight compiler. 1 scan the files matched by include and exclude, plus provider libraries. 2 parse them with oxc and extract per-file facts, both cached per file by content hash. 3 resolve canonical identities. 4 analyse classes with the core and the compiler extensions. 5 bind every injection point. 6 validate the whole graph, reporting ZNIGHT diagnostics with code frames. 7 emit the module, re-parse it as a check, and write container.generated.ts only if its content changed.',
    body,
  })
}
