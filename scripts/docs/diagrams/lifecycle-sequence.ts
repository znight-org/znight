import { arrow, C, chip, line, measure, node, rect, svg, text } from './lib.ts'

type Lane = 'plugins' | 'providers'
interface Msg {
  to: Lane
  label: string
  note?: string
}
interface Phase {
  tab: string
  state: string
  msgs: Msg[]
}

/** Order of the plugin and provider hooks during create(), start() and stop(). */
export function lifecycleSequence(): string {
  const body: string[] = []
  const xp = 132
  const xa = 344
  const xr = 556
  const hw = 180

  const phases: Phase[] = [
    {
      tab: 'Application.create()',
      state: 'created',
      msgs: [
        { to: 'plugins', label: '`register()`', note: 'supply externals' },
        { to: 'providers', label: '`container.init()`', note: 'create the singletons' },
        { to: 'plugins', label: '`onBootstrap()`', note: 'register routes, consumers' },
      ],
    },
    {
      tab: 'app.start()',
      state: 'starting → ready',
      msgs: [
        { to: 'providers', label: '`onStart()`' },
        { to: 'plugins', label: '`onStart()`', note: 'listen, subscribe' },
        { to: 'providers', label: '`onReady()`' },
        { to: 'plugins', label: '`onReady()`' },
      ],
    },
    {
      tab: 'app.stop()',
      state: 'stopping → stopped',
      msgs: [
        { to: 'plugins', label: '`onStop()`', note: 'reverse · stop ingress, drain' },
        { to: 'providers', label: '`onStop()` + dispose', note: 'reverse resolution order' },
        { to: 'plugins', label: '`onDispose()`', note: 'reverse · close, flush' },
      ],
    },
  ]

  // headers
  const hy = 20
  const hh = 48
  body.push(node({ x: xp - hw / 2, y: hy, w: hw, h: hh, title: 'Plugins', sub: 'in registration order' }))
  body.push(node({ x: xa - hw / 2, y: hy, w: hw, h: hh, title: 'Application', sub: '`app.state`', variant: 'accent' }))
  body.push(node({ x: xr - hw / 2, y: hy, w: hw, h: hh, title: 'Providers', sub: 'singletons, resolution order' }))

  const stride = 38
  const frames: string[] = []
  const tabs: string[] = []
  const msgs: string[] = []
  let y = hy + hh + 14
  for (const phase of phases) {
    const fy = y
    const first = fy + 22 + 30
    const last = first + (phase.msgs.length - 1) * stride
    const fh = last + 22 - fy
    frames.push(rect(24, fy, 640, fh, { fill: '#F4F6FC', opacity: 0.03, stroke: '#34407A', rx: 10, sw: 1 }))
    const tw = measure(phase.tab, 12.5, { mono: true }) + 20
    tabs.push(
      `<path d="M24,${fy + 22} V${fy + 10} Q24,${fy} 34,${fy} H${24 + tw} V${fy + 12} Q${24 + tw},${fy + 22} ${24 + tw - 10},${fy + 22} Z" fill="#26306A"/>`,
    )
    tabs.push(text(24 + 10, fy + 15.5, phase.tab, { size: 12.5, mono: true, weight: 600, fill: C.text1 }))
    tabs.push(chip(xa, fy + 15, phase.state, { size: 12, anchor: 'middle', variant: 'violet', h: 20, mono: true })[0])
    phase.msgs.forEach((m, i) => {
      const my = first + i * stride
      const tx = m.to === 'plugins' ? xp : xr
      const mid = (xa + tx) / 2
      msgs.push(
        arrow([
          [xa, my],
          [tx + (tx < xa ? 4 : -4), my],
        ]),
      )
      msgs.push(`<circle cx="${xa}" cy="${my}" r="3" fill="${C.line}"/>`)
      msgs.push(text(mid, my - 8, m.label, { size: 13, fill: C.text1, anchor: 'middle' }))
      if (m.note) msgs.push(text(mid, my + 17, m.note, { size: 12, fill: C.text3, anchor: 'middle' }))
    })
    y = fy + fh + 10
  }
  const bottom = y - 10

  body.push(...frames)
  for (const x of [xp, xa, xr]) body.push(line([x, hy + hh], [x, bottom], { dash: '3 4', color: C.lineMuted }))
  body.push(...tabs)
  body.push(...msgs)

  return svg({
    h: bottom + 20,
    title: 'Lifecycle hooks in order',
    desc: 'Sequence of the hooks called by the application. Application.create(): plugins register(), container.init() creates the singletons, plugins onBootstrap(). app.start(): providers onStart(), plugins onStart() (listen, subscribe), providers onReady(), plugins onReady(); the state goes from starting to ready. app.stop(): plugins onStop() in reverse order, providers onStop() then disposal in reverse resolution order, plugins onDispose() in reverse order; the state goes from stopping to stopped.',
    body,
  })
}
