/**
 * `generate` of the events extension: `metadata.extensions.events` (RFC 0011 §5.5). One entry per
 * (host provider, method, listened class), sorted by (`order`, token, method, event name), so that
 * the runtime only merges already sorted lists. A listener declared on an abstract class is emitted
 * for each concrete class provider inheriting its method (`inheritance.ts`), typed with that
 * provider's class.
 *
 * ```ts
 * {
 *   listeners: [{
 *     event: UserCreated,
 *     eventName: 'UserCreated',
 *     token: 'src/mail/welcome-mail.ts#WelcomeMail',
 *     method: 'send',
 *     order: 0,
 *     detached: true,
 *     invoke: (c: WelcomeMail, e: UserCreated) => c.send(e),
 *   }],
 * }
 * ```
 */
import type { GenerateContext, GenNode } from '@znight/compiler'
import type { EventsData, ListenerData } from './data.ts'

import { compareStrings } from './constants.ts'
import { recordedInheritors } from './inheritance.ts'

type Context = GenerateContext<EventsData>

/** One generated entry. */
interface Entry {
  readonly listener: ListenerData
  readonly token: string
  /** The class of the provider: the type of the instance in `invoke`. */
  readonly classIdentity: string
}

/** Builds the events section; `undefined` (no section) when the application has no listener. */
export function generateEvents(ctx: Context): GenNode | undefined {
  const listeners = ctx.stored.filter((data): data is ListenerData => data.kind === 'listener')
  if (listeners.length === 0) return undefined
  const entries = expand(listeners, ctx).sort(byOrder)
  if (entries.length === 0) return undefined
  const types = new Map<string, GenNode>()
  const typeOf = (identity: string): GenNode => {
    let node = types.get(identity)
    if (node === undefined) {
      node = ctx.importType(identity)
      types.set(identity, node)
    }
    return node
  }
  const values = new Map<string, GenNode>()
  const eventValue = (listener: ListenerData): GenNode => {
    let node = values.get(listener.event.identity)
    if (node === undefined) {
      node = ctx.importValue(listener.event)
      values.set(listener.event.identity, node)
    }
    return node
  }
  return ctx.obj([
    [
      'listeners',
      ctx.arr(
        entries.map(({ listener, token, classIdentity }) =>
          ctx.obj([
            ['event', eventValue(listener)],
            ['eventName', listener.event.name],
            ['token', token],
            ['method', listener.method],
            ['order', ctx.lit(listener.order)],
            ['detached', ctx.lit(listener.detached)],
            [
              'invoke',
              ctx.arrow(
                [
                  ['c', typeOf(classIdentity)],
                  ['e', eventValue(listener)],
                ],
                (c, e) => ctx.call(ctx.member(c, listener.method), [e as GenNode]),
              ),
            ],
          ]),
        ),
      ),
    ],
  ])
}

/**
 * Concrete hosts as themselves, abstract hosts as each concrete class provider inheriting the method
 * (computed by `validate`). Pruned providers are skipped.
 */
function expand(listeners: readonly ListenerData[], ctx: Context): Entry[] {
  const entries: Entry[] = []
  for (const listener of listeners) {
    if (!listener.host.abstract) {
      const token = ctx.tokenOf(listener.host)
      if (token !== undefined && ctx.provider(token) !== undefined) {
        entries.push({ listener, token, classIdentity: listener.host.identity })
      }
      continue
    }
    for (const { token, classIdentity } of recordedInheritors(listener)) {
      if (ctx.provider(token) !== undefined) entries.push({ listener, token, classIdentity })
    }
  }
  return entries
}

function byOrder(a: Entry, b: Entry): number {
  return (
    a.listener.order - b.listener.order ||
    compareStrings(a.token, b.token) ||
    compareStrings(a.listener.method, b.listener.method) ||
    compareStrings(a.listener.event.name, b.listener.event.name) ||
    compareStrings(a.listener.event.identity, b.listener.event.identity)
  )
}
