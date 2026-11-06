import type { WsServer } from '@znight/websocket'

import { Controller, Get } from '@znight/http'

import { Public } from '../auth/access.js'

@Controller('/health')
@Public()
export class HealthController {
  constructor(private readonly ws: WsServer) {}

  @Get()
  health(): { status: 'up'; connections: number } {
    return { status: 'up', connections: this.ws.connections }
  }
}
