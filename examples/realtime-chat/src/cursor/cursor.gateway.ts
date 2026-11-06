import type { RequestUser } from '../auth/request-user.js'

import { Gateway, OnConnect, OnMessage, Payload, type WsConnection } from '@znight/websocket'
import { z } from 'zod'

import { Authenticated } from '../auth/access.js'

export const CursorMove = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
export type CursorMove = z.output<typeof CursorMove>

/** Cursor positions of a room, sent to its other members. */
export interface CursorEvents {
  cursor: { readonly user: string; readonly x: number; readonly y: number }
}

/**
 * One gateway instance **per connection** (`scope: 'request'`): the constructor injects the
 * connection and the request-scoped caller directly, and fields hold per-connection state. Cursor
 * updates are lossy: a slow client loses some (`onLimit: 'drop'`) instead of being disconnected.
 */
@Gateway({ path: '/rooms/:room/cursor', scope: 'request', backpressure: { limit: '64kb', onLimit: 'drop' } })
@Authenticated()
export class CursorGateway {
  #moves = 0

  constructor(
    private readonly conn: WsConnection<Record<string, unknown>, CursorEvents>,
    private readonly user: RequestUser,
  ) {}

  @OnConnect()
  open(): void {
    this.conn.join(this.conn.params['room'] ?? '')
  }

  @OnMessage('move')
  move(@Payload(CursorMove) input: CursorMove): void {
    this.#moves++
    const room = this.conn.params['room'] ?? ''
    this.conn.to(room).emit('cursor', { user: this.user.principal.name, x: input.x, y: input.y })
  }

  /** The moves of this connection: a field of this connection's own instance. */
  @OnMessage('stats')
  stats(): { moves: number } {
    return { moves: this.#moves }
  }
}
