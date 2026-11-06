import { Injectable } from '@znight/core'

export interface Tick {
  readonly symbol: string
  readonly price: number
  readonly sequence: number
}

/** A deterministic price feed: one tick every `intervalMs` (tests set it low). */
@Injectable()
export class PriceFeed {
  readonly symbols: ReadonlySet<string> = new Set(['ACME', 'ZNGT'])
  intervalMs = Number(process.env['TICK_INTERVAL_MS'] ?? 500)

  has(symbol: string): boolean {
    return this.symbols.has(symbol)
  }

  async *ticks(symbol: string, signal: AbortSignal): AsyncGenerator<Tick> {
    let sequence = 0
    while (!signal.aborted) {
      sequence++
      yield { symbol, price: 100 + Math.round(Math.sin(sequence) * 1000) / 100, sequence }
      await new Promise(resolve => setTimeout(resolve, this.intervalMs))
    }
  }
}

/** A tick as 12 bytes: sequence (uint32) and price (float64), big-endian. */
export function encodeTick(tick: Tick): Uint8Array {
  const bytes = new Uint8Array(12)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, tick.sequence)
  view.setFloat64(4, tick.price)
  return bytes
}

export function decodeTick(bytes: Uint8Array): { sequence: number; price: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { sequence: view.getUint32(0), price: view.getFloat64(4) }
}
