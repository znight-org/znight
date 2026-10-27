import { arrow, baseline, C, chip, node, svg, text, type Variant } from './lib.ts'

/** How the compiler binds one injection point (architecture §4.7). */
export function binding(): string {
  const body: string[] = []
  const cx = 344

  body.push(
    node({
      x: cx - 160,
      y: 20,
      w: 320,
      h: 46,
      title: 'injection point',
      sub: 'type `T`, optional qualifier `@Inject(q)`',
      subSize: 12,
    }),
  )
  body.push(
    arrow([
      [cx, 68],
      [cx, 86],
    ]),
  )
  body.push(
    node({
      x: cx - 160,
      y: 88,
      w: 320,
      h: 62,
      title: 'candidates',
      sub: ['providers of `T` and of its subtypes', 'with a qualifier: only those named `q`'],
      subSize: 12,
    }),
  )
  body.push(
    arrow([
      [cx, 152],
      [cx, 170],
    ]),
  )

  const dw = 196
  const dh = 34
  const decision = (x: number, y: number, label: string) =>
    node({ x, y, w: dw, h: dh, title: label, variant: 'violet', size: 13, weight: 500, rx: dh / 2 })
  const result = (x: number, y: number, label: string, variant: Variant = 'ok', mono = false) =>
    chip(x, y + dh / 2, label, { variant, size: 12.5, h: 26, mono })[0]
  const yes = (x: number, y: number, rx: number) => {
    body.push(
      arrow([
        [x + 2, y + dh / 2],
        [rx - 3, y + dh / 2],
      ]),
    )
    body.push(text((x + rx) / 2, y + dh / 2 - 7, 'yes', { size: 12, fill: C.text3, anchor: 'middle' }))
  }
  const no = (x: number, y: number, y2: number) => {
    body.push(
      arrow([
        [x, y + 2],
        [x, y2 - 2],
      ]),
    )
    body.push(text(x - 8, baseline((y + y2) / 2, 12), 'no', { size: 12, fill: C.text3, anchor: 'end' }))
  }

  // multi
  const my = 172
  body.push(decision(cx - dw / 2, my, '`T[]` (multi)?'))
  yes(cx + dw / 2, my, cx + dw / 2 + 40)
  body.push(result(cx + dw / 2 + 40, my, 'all, ordered by token'))

  // split
  const split = my + dh + 22
  const lx = 24
  const rxl = 360
  const lc = lx + dw / 2
  const rc = rxl + dw / 2
  const top = split + 34
  body.push(
    arrow(
      [
        [cx, my + dh + 2],
        [cx, split],
        [lc, split],
        [lc, top - 2],
      ],
      { r: 10 },
    ),
  )
  body.push(
    arrow(
      [
        [cx, split],
        [rc, split],
        [rc, top - 2],
      ],
      { r: 10 },
    ),
  )
  body.push(text(lc + 9, baseline(split + 17, 12), 'none', { size: 12, fill: C.text3 }))
  body.push(text(rc + 9, baseline(split + 17, 12), 'one or more', { size: 12, fill: C.text3 }))
  body.push(text(cx + 9, baseline(my + dh + 11, 12), 'no', { size: 12, fill: C.text3 }))

  const stride = 52
  const resX = (x: number) => x + dw + 36

  // left ladder: no candidate
  const left = [
    { q: 'runtime-provided type?', r: 'external' },
    { q: 'optional?', r: '`undefined`' },
  ]
  left.forEach((s, i) => {
    const y = top + i * stride
    body.push(decision(lx, y, s.q))
    yes(lx + dw, y, resX(lx))
    body.push(result(resX(lx), y, s.r))
    no(lc, y + dh, y + stride)
  })
  const le = top + left.length * stride
  const eh = 48
  body.push(
    node({
      x: lx,
      y: le,
      w: dw,
      h: eh,
      title: '`ZNIGHT001`',
      sub: 'missing provider',
      variant: 'err',
      size: 13,
      weight: 500,
      subSize: 12,
    }),
  )

  // right ladder: at least one candidate
  const right = ['one exact candidate?', 'one `@Primary()`?', 'a single candidate?']
  right.forEach((q, i) => {
    const y = top + i * stride
    body.push(decision(rxl, y, q))
    yes(rxl + dw, y, resX(rxl))
    body.push(result(resX(rxl), y, 'bound'))
    no(rc, y + dh, y + stride)
  })
  const re = top + right.length * stride
  body.push(
    node({
      x: rxl,
      y: re,
      w: dw,
      h: eh,
      title: '`ZNIGHT004` / `ZNIGHT008`',
      sub: 'duplicate / ambiguous',
      variant: 'err',
      size: 13,
      weight: 500,
      subSize: 12,
    }),
  )

  // notes
  const ny = le + eh + 28
  body.push(text(lx, ny, 'Primitives need a qualifier (`ZNIGHT010`).', { size: 12, fill: C.text3 }))
  body.push(text(lx, ny + 18, '`Lazy<T>` binds `T` with the same rules.', { size: 12, fill: C.text3 }))

  return svg({
    h: Math.max(ny + 18, re + eh) + 24,
    title: 'How a dependency is bound',
    desc: 'For an injection point of type T with an optional qualifier, the compiler collects the candidates: providers of T and of its subtypes, only those named q with a qualifier. A T[] injection receives all of them, ordered by token. With no candidate: a runtime-provided type of a package binds to the external, an optional dependency to undefined, otherwise ZNIGHT001. With one or more: the unique exact candidate, else the unique @Primary(), else the single candidate is bound; otherwise ZNIGHT004 when they all provide the same type, ZNIGHT008 when ambiguous. Primitives need a qualifier (ZNIGHT010) and Lazy<T> binds T with the same rules.',
    body,
  })
}
