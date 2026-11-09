import type { Lazy } from '@znight/core'
import type { RequestUser } from '../auth/request-user.js'
import type { MessageService } from './message.service.js'

import {
  Conn,
  Gateway,
  type GatewayChannel,
  OnConnect,
  OnDisconnect,
  OnMessage,
  Payload,
  UseHandshakeGuard,
  UseMessageGuard,
  WsException,
  type WsServer,
} from '@znight/websocket'

import { Authenticated, Roles } from '../auth/access.js'
import {
  type ChatConnection,
  type ChatEvents,
  type ChatMessage,
  JoinRoom,
  KickUser,
  SendMessage,
} from './chat.protocol.js'
import { ConnectionQuotaGuard } from './connection-quota.guard.js'
import { ModeratorGuard } from './moderator.guard.js'

/** Chat rooms a connection may join, besides its `user:<name>` room. */
export const MAX_ROOMS_PER_CONNECTION = 20

@Gateway({ path: '/chat', protocols: ['chat.v1'], rateLimit: { messages: 30, intervalMs: 1_000 } })
@Authenticated() // the handshake's access decision, enforced by the global AuthGuard
@UseHandshakeGuard(ConnectionQuotaGuard) // after the global guards: at most 5 tabs per user
export class ChatGateway {
  readonly #chat: GatewayChannel<ChatEvents>

  constructor(
    ws: WsServer,
    private readonly user: Lazy<RequestUser>,
    private readonly messages: MessageService,
  ) {
    this.#chat = ws.of<ChatEvents>(ChatGateway) // a lazy handle: usable once the plugin is bootstrapped
  }

  @OnConnect()
  connected(@Conn() conn: ChatConnection): void {
    // the guards ran in this connection's scope: RequestUser is the authenticated caller
    conn.data.user = this.user.get().principal
    conn.join(`user:${conn.data.user.name}`) // one room per user: every tab of a user
  }

  @OnMessage('room.join')
  join(@Conn() conn: ChatConnection, @Payload(JoinRoom) input: JoinRoom): { members: number } {
    if (!conn.rooms.has(input.room) && conn.rooms.size > MAX_ROOMS_PER_CONNECTION) {
      throw new WsException('FORBIDDEN', `At most ${MAX_ROOMS_PER_CONNECTION} rooms per connection`)
    }
    conn.join(input.room)
    conn.to(input.room).emit('presence.joined', { room: input.room, user: conn.data.user.name })
    return { members: this.#chat.members(input.room).size } // the reply, when the client sent an id
  }

  @OnMessage('message.send')
  send(@Conn() conn: ChatConnection, @Payload(SendMessage) input: SendMessage): ChatMessage {
    if (!conn.rooms.has(input.room)) throw new WsException('FORBIDDEN', `Join "${input.room}" first`)
    const message = this.messages.post(conn.data.user, input)
    this.#chat.to(input.room).emit('message.new', message) // encoded once, sent to every member
    return message
  }

  @OnMessage('room.kick')
  @Roles(['moderator']) // message-level decision...
  @UseMessageGuard(ModeratorGuard) // ...enforced by a message guard reading Roles.get(ctx)
  kick(@Payload(KickUser) input: KickUser): void {
    const target = this.#chat.to(`user:${input.user}`)
    target.emit('kicked', { room: input.room })
    target.leave(input.room)
  }

  @OnDisconnect()
  disconnected(@Conn() conn: ChatConnection): void {
    for (const room of conn.rooms) {
      if (!room.startsWith('user:')) this.#chat.to(room).emit('presence.left', { room, user: conn.data.user.name })
    }
  }
}
