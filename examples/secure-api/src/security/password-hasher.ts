import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { Injectable } from '@znight/core'
import { ServiceUnavailableException } from '@znight/http'

interface Params {
  readonly ln: number // log2 of the cost N
  readonly r: number
  readonly p: number
}

const CURRENT: Params = { ln: 17, r: 8, p: 1 } // N = 2^17: 128 MiB and ~100-300 ms per hash
const KEY_LENGTH = 32
const MAX_MEMORY = 256 * 1024 * 1024 // stored parameters asking for more (128 * N * r bytes) are refused
export const MAX_CONCURRENT = 4 // the libuv thread pool size: 4 hashes at once use 512 MiB
export const MAX_WAITING = 16 // beyond, a flood of sign-ins gets 503 at once instead of minutes of queue
const PHC = /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64').replace(/=+$/, '')

@Injectable()
export class PasswordHasher {
  #running = 0
  readonly #waiting: (() => void)[] = []

  /**
   * `$scrypt$ln=17,r=8,p=1$<salt>$<hash>` (PHC string format, base64 without padding). `signal`: the
   * caller gave up (`ctx.signal`), drop the hash if it still waits for a slot.
   */
  async hash(password: string, signal?: AbortSignal): Promise<string> {
    const salt = randomBytes(16)
    const key = await this.#derive(password, salt, CURRENT, signal)
    return `$scrypt$ln=${CURRENT.ln},r=${CURRENT.r},p=${CURRENT.p}$${b64(salt)}$${b64(key)}`
  }

  async verify(password: string, stored: string, signal?: AbortSignal): Promise<boolean> {
    const parsed = parse(stored)
    if (parsed === undefined) return false
    const key = await this.#derive(password, parsed.salt, parsed.params, signal)
    return timingSafeEqual(key, parsed.hash)
  }

  /** True when the stored hash uses older parameters: hash the password again after a successful sign-in. */
  needsRehash(stored: string): boolean {
    const params = parse(stored)?.params
    return params === undefined || params.ln < CURRENT.ln || params.r !== CURRENT.r || params.p !== CURRENT.p
  }

  /** Hashes running and waiting for a slot (exposed by `GET /status/details`). */
  get stats(): { readonly running: number; readonly waiting: number } {
    return { running: this.#running, waiting: this.#waiting.length }
  }

  #derive(password: string, salt: Uint8Array, { ln, r, p }: Params, signal?: AbortSignal): Promise<Buffer> {
    return this.#limit(
      signal,
      () =>
        new Promise<Buffer>((resolve, reject) => {
          const N = 2 ** ln
          // maxmem: scrypt needs 128 * N * r bytes; the default (32 MiB) is too small for N = 2^17
          const options = { N, r, p, maxmem: 2 * 128 * N * r }
          scrypt(password.normalize('NFC'), salt, KEY_LENGTH, options, (error, key) =>
            error ? reject(error) : resolve(key),
          )
        }),
    )
  }

  /**
   * Bounds the hashes running at once (each one holds 128 MiB and a thread of the pool) and the
   * hashes waiting for a slot; a waiting hash whose caller gave up leaves the queue.
   */
  async #limit<T>(signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
    signal?.throwIfAborted()
    if (this.#running < MAX_CONCURRENT) this.#running++
    else await this.#wait(signal) // the slot is handed over
    try {
      return await task()
    } finally {
      const next = this.#waiting.shift()
      if (next === undefined) this.#running--
      else next()
    }
  }

  #wait(signal: AbortSignal | undefined): Promise<void> {
    if (this.#waiting.length >= MAX_WAITING) {
      throw new ServiceUnavailableException('Too many sign-ins in progress', undefined, {
        headers: { 'retry-after': '1' },
      })
    }
    return new Promise<void>((resolve, reject) => {
      const granted = (): void => {
        signal?.removeEventListener('abort', abandoned)
        resolve()
      }
      const abandoned = (): void => {
        this.#waiting.splice(this.#waiting.indexOf(granted), 1)
        reject(signal?.reason)
      }
      signal?.addEventListener('abort', abandoned, { once: true })
      this.#waiting.push(granted)
    })
  }
}

/** The parts of a PHC string, or `undefined` when it is malformed or asks for absurd parameters. */
function parse(stored: string): { params: Params; salt: Buffer; hash: Buffer } | undefined {
  const match = PHC.exec(stored)
  if (match === null) return undefined
  const [, ln, r, p, salt, hash] = match
  const params = { ln: Number(ln), r: Number(r), p: Number(p) }
  const expected = Buffer.from(hash as string, 'base64')
  const memory = 128 * 2 ** params.ln * params.r
  if (params.ln < 1 || params.r < 1 || params.p < 1 || params.p > 16 || memory > MAX_MEMORY) return undefined
  if (expected.length !== KEY_LENGTH) return undefined
  return { params, salt: Buffer.from(salt as string, 'base64'), hash: expected }
}
