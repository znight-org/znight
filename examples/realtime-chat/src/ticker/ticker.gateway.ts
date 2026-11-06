import { Conn, Gateway, OnConnect, type WsConnection, WsException } from '@znight/websocket'

import { Public } from '../auth/access.js'
import { encodeTick, type PriceFeed } from './price-feed.js'

/** A raw gateway: binary ticks at the client's pace (`drained()`), a `4404` close for an unknown symbol. */
@Gateway({ path: '/ticker/:symbol', protocol: 'raw', backpressure: { limit: '64kb' } })
@Public()
export class TickerGateway {
  constructor(private readonly prices: PriceFeed) {}

  @OnConnect()
  start(@Conn() conn: WsConnection): void {
    const symbol = conn.params['symbol'] ?? ''
    if (!this.prices.has(symbol)) {
      throw new WsException('NOT_FOUND', `Unknown symbol ${symbol}`, undefined, { close: 4404 })
    }
    // not awaited: @OnConnect must return for the connection to receive messages
    this.#pump(conn, symbol).catch(() => conn.close(1011, 'Feed failed'))
  }

  async #pump(conn: WsConnection, symbol: string): Promise<void> {
    for await (const tick of this.prices.ticks(symbol, conn.signal)) {
      if (conn.send(encodeTick(tick)) === 'queued') await conn.drained()
    }
  }
}
