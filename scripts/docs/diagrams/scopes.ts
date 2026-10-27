import { arrow, baseline, C, line, rect, svg, text, V } from './lib.ts'

/** Lifetimes of singleton, request and transient instances along the application's life. */
export function scopes(): string {
  const body: string[] = []
  const t0 = 168
  const tEnd = 664
  const xCreate = 184
  const xStart = 262
  const xStop = 628

  // axis
  const ay = 46
  body.push(
    arrow(
      [
        [t0, ay],
        [tEnd - 2, ay],
      ],
      { color: C.lineMuted, width: 1.25 },
    ),
  )
  for (const [x, label] of [
    [xCreate, 'create()'],
    [xStart, 'start()'],
    [xStop, 'stop()'],
  ] as const) {
    body.push(line([x, ay - 5], [x, ay + 5], { color: C.line, width: 1.5 }))
    body.push(text(x, ay - 12, label, { size: 12.5, mono: true, fill: C.text2, anchor: 'middle' }))
  }
  body.push(
    text((xStart + xStop) / 2, ay - 12, 'requests and messages', { size: 12.5, fill: C.text3, anchor: 'middle' }),
  )

  // rows
  const rows = [
    { name: 'singleton', y: 62, h: 52, sub: ['one instance for', 'the application'] },
    { name: 'request', y: 124, h: 82, sub: ['one per request', 'scope, isolated'] },
    { name: 'transient', y: 216, h: 52, sub: ['a new instance', 'per injection'] },
  ]
  for (const r of rows) {
    body.push(rect(24, r.y, 640, r.h, { fill: '#F4F6FC', opacity: 0.03, rx: 10 }))
    const cy = r.y + r.h / 2
    body.push(text(38, cy - 12, r.name, { size: 13.5, mono: true, weight: 600 }))
    r.sub.forEach((s, i) => body.push(text(38, cy + 5 + i * 15, s, { size: 12, fill: C.text3 })))
    body.push(line([t0 - 8, r.y + 10], [t0 - 8, r.y + r.h - 10], { color: '#34407A' }))
  }

  // singleton
  const sRow = rows[0]!
  const sy = sRow.y + sRow.h / 2
  body.push(rect(xCreate, sy - 14, xStop - xCreate, 28, { fill: '#1F3A7A', stroke: '#3E7BFA', rx: 14 }))
  body.push(
    text((xCreate + xStop) / 2, baseline(sy, 12.5), 'created at startup, shared by everyone, disposed on stop()', {
      size: 12.5,
      fill: C.text1,
      anchor: 'middle',
    }),
  )

  // request scopes
  const rRow = rows[1]!
  const r1 = rRow.y + 24
  const r2 = rRow.y + rRow.h - 24
  const scopes = [
    { x0: 270, x1: 412, y: r1, label: 'HTTP request' },
    { x0: 326, x1: 470, y: r2, label: 'message delivery' },
    { x0: 440, x1: 600, y: r1, label: 'HTTP request' },
  ]
  for (const s of scopes) {
    body.push(rect(s.x0, s.y - 13, s.x1 - s.x0, 26, { fill: V.violet.fill, stroke: V.violet.stroke, rx: 13 }))
    body.push(
      text((s.x0 + s.x1) / 2, baseline(s.y, 12.5), s.label, { size: 12.5, fill: V.violet.text, anchor: 'middle' }),
    )
  }

  // transients, owned by the instance they are injected into
  const tRow = rows[2]!
  const ty = tRow.y + tRow.h / 2
  const transients = [
    { x: 200, to: sy + 14 },
    { x: 218, to: sy + 14 },
    { x: 300, to: r1 + 13 },
    { x: 366, to: r2 + 13 },
    { x: 492, to: r1 + 13 },
  ]
  for (const t of transients) {
    body.push(line([t.x, ty - 7], [t.x, t.to + 2], { color: '#B9A6FF', dash: '2 3', width: 1.25 }))
    body.push(
      `<rect x="${t.x - 6}" y="${ty - 6}" width="12" height="12" rx="3" fill="#2B2A66" stroke="#B9A6FF" stroke-width="1.25"/>`,
    )
  }
  body.push(text(650, baseline(ty, 12.5), 'owned by its consumer', { size: 12.5, fill: C.text3, anchor: 'end' }))

  return svg({
    h: 292,
    title: 'Provider scopes',
    desc: 'Lifetimes along the life of the application. A singleton is created at startup by Application.create(), shared by everyone and disposed on stop(). A request-scoped provider has one instance per request scope (an HTTP request or a message delivery); concurrent scopes are isolated. A transient provider gets a new instance for every injection, owned by the singleton or request-scoped instance it is injected into.',
    body,
  })
}
