import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { Injectable } from '@znight/core'

interface Params {
  readonly ln: number // log2 of the cost N
  readonly r: number
  readonly p: number
}

const CURRENT: Params = { ln: 17, r: 8, p: 1 } // N = 2^17: 128 MiB and ~100-300 ms per hash
const KEY_LENGTH = 32
const MAX_MEMORY = 256 * 1024 * 1024 // stored parameters asking for more (128 * N * r bytes) are refused
const MAX_CONCURRENT = 4 // the libuv thread pool size: 4 hashes at once use 512 MiB
const PHC = /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64').replace(/=+$/, '')

@Injectable()
export class PasswordHasher {
  #running = 0
  readonly #waiting: (() => void)[] = []

  /** `$scrypt$ln=17,r=8,p=1$<salt>$<hash>` (PHC string format, base64 without padding). */
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16)
    const key = await this.#derive(password, salt, CURRENT)
    return `$scrypt$ln=${CURRENT.ln},r=${CURRENT.r},p=${CURRENT.p}$${b64(salt)}$${b64(key)}`
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const parsed = parse(stored)
    if (parsed === undefined) return false
    const key = await this.#derive(password, parsed.salt, parsed.params)
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

  #derive(password: string, salt: Uint8Array, { ln, r, p }: Params): Promise<Buffer> {
    return this.#limit(
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

  /** Bounds the hashes running at once: each one holds 128 MiB and a thread of the pool. */
  async #limit<T>(task: () => Promise<T>): Promise<T> {
    if (this.#running < MAX_CONCURRENT) this.#running++
    else await new Promise<void>(resolve => this.#waiting.push(resolve)) // the slot is handed over
    try {
      return await task()
    } finally {
      const next = this.#waiting.shift()
      if (next === undefined) this.#running--
      else next()
    }
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
