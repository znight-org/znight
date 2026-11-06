import type { WsServer } from '@znight/websocket'
import type { MessageService } from './message.service.js'

import { Controller, Get, Param } from '@znight/http'

import { Authenticated } from '../auth/access.js'
import { ChatGateway } from './chat.gateway.js'
import { type ChatMessage, RoomName } from './chat.protocol.js'

/** HTTP reads of the chat: live member counts from `WsServer`, and the history of a room. */
@Controller('/rooms')
@Authenticated()
export class RoomController {
  constructor(
    private readonly ws: WsServer,
    private readonly messages: MessageService,
  ) {}

  @Get()
  rooms(): { room: string; members: number }[] {
    return [...this.ws.of(ChatGateway).rooms()]
      .filter(([room]) => !room.startsWith('user:'))
      .map(([room, members]) => ({ room, members }))
  }

  @Get('/:room/messages')
  history(@Param('room', RoomName) room: string): readonly ChatMessage[] {
    return this.messages.history(room)
  }
}
