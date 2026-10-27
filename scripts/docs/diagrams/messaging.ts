import { arrow, baseline, C, node, svg, text, V } from './lib.ts'

/** What happens to one message delivery: ack, retry or dead-letter. */
export function messagingDelivery(): string {
  const body: string[] = []

  // row 1: the delivery pipeline
  const y1 = 28
  const h1 = 54
  const w1 = 116
  const g1 = 15
  const x1 = (i: number) => 24 + i * (w1 + g1)
  const steps = [
    { title: 'receive', sub: 'from the broker' },
    { title: 'request scope', sub: '`InboundMessage`' },
    { title: 'decode', sub: 'body → payload' },
    { title: 'select handler', sub: 'by `type`' },
    { title: 'invoke', sub: 'validate → handler' },
  ]
  steps.forEach((s, i) => {
    body.push(node({ x: x1(i), y: y1, w: w1, h: h1, title: s.title, sub: s.sub, size: 13.5, subSize: 12 }))
    if (i < steps.length - 1)
      body.push(
        arrow([
          [x1(i) + w1 + 3, y1 + h1 / 2],
          [x1(i + 1) - 3, y1 + h1 / 2],
        ]),
      )
  })

  // row 2: outcomes of the handler
  const bus = y1 + h1 + 34
  const y2 = bus + 32
  const h2 = 50
  const retry = { x: 24, w: 214 }
  const onError = { x: 272, w: 148 }
  const ack = { x: x1(4), w: w1 }
  const inv = x1(4) + w1 / 2
  const retryDrop = retry.x + retry.w - 30
  const errDrop = onError.x + onError.w / 2

  body.push(
    arrow([
      [inv, y1 + h1 + 2],
      [inv, y2 - 2],
    ]),
  )
  body.push(text(inv + 9, baseline((y1 + h1 + y2) / 2 + 10, 12.5), 'success', { size: 12.5, fill: V.ok.sub }))
  body.push(
    arrow(
      [
        [inv, bus],
        [retryDrop, bus],
        [retryDrop, y2 - 2],
      ],
      { r: 10 },
    ),
  )
  body.push(text(retryDrop + 9, baseline(bus + 16, 12.5), 'attempts left', { size: 12.5, fill: V.warn.sub }))
  body.push(
    arrow([
      [errDrop, bus],
      [errDrop, y2 - 2],
    ]),
  )
  body.push(text(errDrop + 9, baseline(bus + 16, 12.5), 'terminal failure *', { size: 12.5, fill: V.violet.sub }))

  body.push(node({ x: ack.x, y: y2, w: ack.w, h: h2, title: 'ack', sub: 'handled', variant: 'ok', subSize: 12 }))
  body.push(
    node({
      x: retry.x,
      y: y2,
      w: retry.w,
      h: h2,
      title: 'retry',
      sub: 'wait in process, or broker delay',
      variant: 'warn',
      subSize: 12,
    }),
  )
  body.push(
    node({
      x: onError.x,
      y: y2,
      w: onError.w,
      h: h2,
      title: '@OnError()',
      mono: true,
      sub: 'if declared',
      variant: 'violet',
      subSize: 12,
    }),
  )

  // retry loop back to receive
  const loop = 52
  body.push(
    arrow(
      [
        [loop, y2 - 2],
        [loop, y1 + h1 + 2],
      ],
      { color: V.warn.stroke, dashed: true },
    ),
  )
  body.push(text(loop + 9, baseline(bus - 12, 12.5), 'redelivered, `attempt + 1`', { size: 12.5, fill: V.warn.sub }))

  // row 3: @OnError result
  const bus2 = y2 + h2 + 26
  const y3 = bus2 + 30
  const h3 = 62
  const ack2 = { x: 236, w: 92 }
  const dl = { x: 392, w: 272 }
  const ackDrop = ack2.x + ack2.w / 2
  const dlDrop = dl.x + 60
  body.push(
    arrow(
      [
        [errDrop, y2 + h2 + 2],
        [errDrop, bus2],
        [ackDrop, bus2],
        [ackDrop, y3 - 2],
      ],
      { r: 10 },
    ),
  )
  body.push(
    text(ackDrop - 9, baseline(bus2 + 16, 12.5), "returns 'ack'", { size: 12.5, fill: V.ok.sub, anchor: 'end' }),
  )
  body.push(
    arrow(
      [
        [errDrop, bus2],
        [dlDrop, bus2],
        [dlDrop, y3 - 2],
      ],
      { r: 10 },
    ),
  )
  body.push(text(dlDrop + 9, baseline(bus2 + 16, 12.5), 'otherwise, or no hook', { size: 12.5, fill: V.err.sub }))
  body.push(node({ x: ack2.x, y: y3, w: ack2.w, h: h3, title: 'ack', sub: 'dropped', variant: 'ok', subSize: 12 }))
  body.push(
    node({
      x: dl.x,
      y: y3,
      w: dl.w,
      h: h3,
      title: 'dead-letter',
      sub: ['copy published (confirmed), then ack', 'publish failed: released, redelivered'],
      variant: 'err',
      subSize: 12,
    }),
  )

  // footnote
  const fy = y3 + h3 + 30
  body.push(
    text(24, fy, '* last attempt, `NonRetryableError`, invalid payload, undecodable body or no matching handler', {
      size: 12,
      fill: C.text3,
    }),
  )

  return svg({
    h: fy + 20,
    title: 'Message delivery',
    desc: 'Each delivery is received from the broker, runs in a request scope seeded with the InboundMessage, is decoded, routed to a handler by type and invoked (payload validation, then the handler). Success acknowledges it. A failure with attempts left is retried: it waits in process or is delayed by the broker, then is redelivered. A terminal failure (last attempt, NonRetryableError, invalid payload, undecodable body or no matching handler) calls the @OnError hook if declared: returning ack drops the message, otherwise it is dead-lettered: the copy is published and confirmed, then the original is acknowledged; if the publish fails the message is released and redelivered.',
    body,
  })
}
