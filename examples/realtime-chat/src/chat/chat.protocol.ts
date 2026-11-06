/** The contract of `/chat`, shared by the gateway and the tests. */
import type { WsConnection } from '@znight/websocket'
import type { Principal } from '../auth/request-user.js'

import { z } from 'zod'

export const RoomName = z.string().regex(/^[a-z0-9-]{1,32}$/)
export const JoinRoom = z.object({ room: RoomName })
export type JoinRoom = z.output<typeof JoinRoom>
export const SendMessage = z.object({ room: RoomName, text: z.string().trim().min(1).max(2000) })
export type SendMessage = z.output<typeof SendMessage>
export const KickUser = z.object({ room: RoomName, user: z.string().min(1) })
export type KickUser = z.output<typeof KickUser>

export interface ChatMessage {
  readonly id: string
  readonly room: string
  readonly author: string
  readonly text: string
  readonly at: string
}

/** Events the server sends on `/chat` (typed `emit`). */
export interface ChatEvents {
  'message.new': ChatMessage
  'presence.joined': { readonly room: string; readonly user: string }
  'presence.left': { readonly room: string; readonly user: string }
  kicked: { readonly room: string }
}

/** Per-connection data, set in `@OnConnect`. */
export interface ChatData {
  user: Principal
}

export type ChatConnection = WsConnection<ChatData, ChatEvents>
