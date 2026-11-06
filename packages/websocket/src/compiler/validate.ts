/**
 * `validate` of the websocket extension (RFC 0003 §6.2): what needs every gateway. Duplicate path
 * shapes (ZNIGHT007), decorators on a class that is neither a gateway nor one of its bases
 * (ZNIGHT005), and the required route decorator groups of RFC 0001 on handshakes (ZNIGHT023).
 */
import type { ValidateContext } from '@znight/compiler'
import type { MetaEntry } from '@znight/http/compiler'
import type { GatewayData, WebSocketData } from './data.ts'

import { requiredRouteGroups } from '@znight/http/compiler'
import { parseRoutePath } from '@znight/http/path'

import { compareStrings, INVALID_DECORATOR, INVALID_ROUTE, MISSING_ROUTE_DECISION } from './constants.ts'

/** Validates the gateways of the application. */
export function validateWebSocket(ctx: ValidateContext<WebSocketData>): void {
  const gateways = ctx.stored
    .filter((data): data is GatewayData => data.kind === 'gateway')
    .sort((a, b) => compareStrings(a.token, b.token))

  const byShape = new Map<string, GatewayData>()
  for (const gateway of gateways) {
    if (gateway.path === undefined) continue
    const shape = parseRoutePath(gateway.path).shape
    const first = byShape.get(shape)
    if (first === undefined) {
      byShape.set(shape, gateway)
      continue
    }
    ctx.report({
      code: INVALID_ROUTE,
      severity: 'error',
      message: `${first.displayName} (${first.path}) and ${gateway.displayName} (${gateway.path}) serve the same path`,
      location: gateway.location,
      hints: ['Two gateways cannot match the same handshake: change one of the paths'],
      related: [{ message: `${first.displayName} serves ${first.path}`, location: first.location }],
    })
  }

  const bases = new Set(gateways.flatMap(gateway => gateway.chain))
  for (const data of ctx.stored) {
    if (data.kind !== 'members' || data.abstract || bases.has(data.identity)) continue
    for (const decorator of data.decorators) {
      ctx.report({
        code: INVALID_DECORATOR,
        severity: 'error',
        message: `@${decorator.name} has no effect: ${data.displayName} is not a @Gateway`,
        location: decorator.location,
        hints: [
          `Add @Gateway('/path') to ${data.displayName}, or extend it from a @Gateway class`,
          'Base classes holding shared handlers should be abstract',
        ],
      })
    }
  }

  const applied: MetaEntry[] = []
  for (const gateway of gateways) {
    applied.push(...gateway.meta)
    for (const handler of gateway.handlers) applied.push(...handler.meta)
  }
  const required = requiredRouteGroups(ctx, applied)
  if (required.length === 0) return
  for (const gateway of gateways) {
    const decided = new Set(gateway.meta.map(entry => entry.group))
    for (const group of required) {
      if (decided.has(group.group)) continue
      const definition = group.decorators[0] as { readonly definition?: GatewayData['location'] } | undefined
      ctx.report({
        code: MISSING_ROUTE_DECISION,
        severity: 'error',
        message: `Gateway ${gateway.displayName} (${gateway.path ?? '?'}) has no "${group.group}" decision`,
        location: gateway.location,
        hints: [`Add ${group.suggestion} to ${gateway.displayName}: the handshake is an HTTP request`],
        ...(definition?.definition === undefined
          ? {}
          : { related: [{ message: `The "${group.group}" group is required`, location: definition.definition }] }),
      })
    }
  }
}
