import { arrow, baseline, C, node, rect, svg, text, V } from './lib.ts'

/** The HTTP request pipeline of @znight/http. */
export function httpPipeline(): string {
  const body: string[] = []

  // entry
  const lx = 60
  const lw = 330
  const cx = lx + lw / 2
  body.push(text(cx + 10, 30, 'request, routed by the adapter', { size: 12.5, fill: C.text3 }))

  // outer: request scope
  const oy = 44
  // inner: http:request hook
  const iy = oy + 54
  const step = 58
  const nh = 42

  const r1 = iy + 54
  const r2 = r1 + step
  const r3 = r2 + step
  const r4 = r3 + step
  const ih4 = 100
  const r5 = r4 + ih4 + 16
  const innerBottom = r5 + nh + 18
  const r6 = innerBottom + 18
  const r7 = r6 + nh + 16
  const outerBottom = r7 + nh + 16

  body.push(rect(24, oy, 640, outerBottom - oy, { fill: '#F4F6FC', opacity: 0.025, stroke: C.nodeStroke, rx: 14 }))
  body.push(text(648, oy + 22, 'request scope', { size: 13, weight: 600, anchor: 'end' }))
  body.push(
    text(648, oy + 40, '`container.runInScope()` with `HttpContext`, `RequestId`', {
      size: 12,
      fill: C.text3,
      anchor: 'end',
    }),
  )
  body.push(
    rect(40, iy, 608, innerBottom - iy, {
      fill: '#F4F6FC',
      opacity: 0.03,
      stroke: 'url(#zn-accent-line)',
      rx: 12,
      sw: 1.25,
    }),
  )
  body.push(text(632, iy + 22, '`http:request` hook', { size: 13, weight: 600, anchor: 'end' }))
  body.push(text(632, iy + 40, 'wrappers log, measure and trace', { size: 12, fill: C.text3, anchor: 'end' }))

  body.push(
    arrow([
      [cx, 38],
      [cx, r1 - 2],
    ]),
  )

  // steps
  body.push(
    node({
      x: lx,
      y: r1,
      w: lw,
      h: nh,
      title: 'CORS preflight?',
      sub: 'with the `cors` option',
      size: 13.5,
      subSize: 12,
    }),
  )
  body.push(
    node({ x: lx, y: r2, w: lw, h: nh, title: 'guards', sub: 'global → controller → route', size: 13.5, subSize: 12 }),
  )
  body.push(
    node({
      x: lx,
      y: r3,
      w: lw,
      h: nh,
      title: 'body parsing',
      sub: 'routes with `@Body()` or uploads',
      size: 13.5,
      subSize: 12,
    }),
  )
  // interceptors wrap the invocation
  body.push(rect(lx, r4, lw, ih4, { fill: V.violet.fill, stroke: V.violet.stroke }))
  body.push(text(cx, r4 + 22, 'interceptors', { size: 13.5, weight: 600, anchor: 'middle', fill: V.violet.text }))
  body.push(
    text(cx, r4 + 39, 'global → controller → route, around', { size: 12, anchor: 'middle', fill: V.violet.sub }),
  )
  body.push(
    node({
      x: lx + 16,
      y: r4 + 50,
      w: lw - 32,
      h: nh,
      title: 'invoke',
      sub: 'extract → coerce → validate → handler',
      size: 13.5,
      subSize: 12,
    }),
  )
  body.push(
    node({
      x: lx,
      y: r5,
      w: lw,
      h: nh,
      title: 'serialise the result',
      sub: 'files: preconditions, ranges · event streams',
      size: 13.5,
      subSize: 12,
    }),
  )

  for (const [a, b] of [
    [r1 + nh, r2],
    [r2 + nh, r3],
    [r3 + nh, r4],
    [r4 + ih4, r5],
    [r5 + nh, r6],
    [r6 + nh, r7],
  ] as const) {
    body.push(
      arrow([
        [cx, a + 2],
        [cx, b - 2],
      ]),
    )
  }
  body.push(text(cx + 9, baseline((r1 + nh + r2) / 2, 12.5), 'no', { size: 12.5, fill: C.text3 }))

  // right column: preflight answer and error responses
  const rx = 436
  const rw = 196
  body.push(
    arrow([
      [lx + lw + 2, r1 + nh / 2],
      [rx - 2, r1 + nh / 2],
    ]),
  )
  body.push(text((lx + lw + rx) / 2, r1 + nh / 2 - 8, 'yes', { size: 12.5, fill: C.text3, anchor: 'middle' }))
  body.push(
    node({
      x: rx,
      y: r1,
      w: rw,
      h: nh,
      title: 'answered here',
      sub: '204 · 403 · 404, no guard',
      size: 13.5,
      subSize: 12,
      variant: 'ok',
    }),
  )

  const ey = r2
  const eh = r5 + nh - r2
  body.push(rect(rx, ey, rw, eh, { fill: V.err.fill, stroke: V.err.stroke }))
  const ecx = rx + rw / 2
  body.push(
    text(ecx, ey + eh / 2 - 30, 'error response', { size: 13.5, weight: 600, anchor: 'middle', fill: V.err.text }),
  )
  for (const [i, l] of [
    'guard denies: 403',
    'invalid input: 400',
    'exception mappers',
    'sets `event.status`, `.error`',
  ].entries()) {
    body.push(text(ecx, ey + eh / 2 - 8 + i * 18, l, { size: 12, anchor: 'middle', fill: V.err.sub }))
  }
  for (const yy of [r2 + nh / 2, r3 + nh / 2, r4 + 50 + nh / 2, r5 + nh / 2]) {
    body.push(
      arrow(
        [
          [lx + lw + 2, yy],
          [rx - 2, yy],
        ],
        { color: V.err.stroke, dashed: true },
      ),
    )
  }
  body.push(text((lx + lw + rx) / 2, r2 + nh / 2 - 8, 'throws', { size: 12.5, fill: V.err.sub, anchor: 'middle' }))

  // after the hook
  body.push(
    node({
      x: lx,
      y: r6,
      w: lw,
      h: nh,
      title: 'response headers',
      sub: 'cookies, request id, CORS, security',
      size: 13.5,
      subSize: 12,
    }),
  )
  for (const [i, line] of [
    'cookies appended, one line each',
    'the others only when not set yet',
    'none on raw `@Res()` replies',
  ].entries()) {
    body.push(text(rx, baseline(r6 + nh / 2, 12) + (i - 1) * 15, line, { size: 12, fill: C.text3 }))
  }
  body.push(
    node({
      x: lx,
      y: r7,
      w: lw,
      h: nh,
      title: 'body sent, scope closes',
      sub: 'request-scoped instances disposed',
      size: 13.5,
      subSize: 12,
    }),
  )

  return svg({
    h: outerBottom + 24,
    title: 'HTTP request pipeline',
    desc: 'Each request routed by the adapter runs in a request scope (container.runInScope with HttpContext and RequestId), inside the http:request hook whose wrappers log, measure and trace. A CORS preflight is answered there (204, 403 or 404) without guards. Otherwise: guards (global, controller, route), body parsing for routes with @Body or uploads, interceptors (global, controller, route) around the invocation (extract, coerce, validate, handler), then serialisation of the result. Anything thrown becomes an error response (403 for a guard, 400 for invalid input, exception mappers) and sets event.status and event.error. Then the cookies are appended to set-cookie (one line each) and the request id, CORS and security headers are added when not already set (raw @Res() replies get none), and the scope closes once the body has been sent (for an event stream, once it ends), disposing request-scoped instances.',
    body,
  })
}
