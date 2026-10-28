/**
 * Event streams that send nothing when they open (a hand-written stream, a proxied upstream that
 * is quiet): `injectSse()` must open them after a bounded wait instead of hanging, then read what
 * they send later. Booted by `fixtures/inject-sse-check.ts`, which `inject-sse.test.ts` runs with
 * Node.js and Bun.
 */
import type { ZnightMetadata } from '@znight/core'
import type { HttpPlugin } from '../src/index.ts'

import { HttpResponse } from '../src/index.ts'
import { controller, metadata, provider, route, t } from './helpers.ts'

const ENCODER = new TextEncoder()

/** A quiet application: its streams and the controllers of the open ones. */
export interface QuietApp {
  readonly metadata: ZnightMetadata
  /** Controllers of the `/late` streams, in opening order. */
  readonly upstreams: ReadableStreamDefaultController<Uint8Array>[]
}

export function quietSseApp(): QuietApp {
  const upstreams: ReadableStreamDefaultController<Uint8Array>[] = []
  class QuietController {
    /** What `return fetch(upstream)` gives for a quiet upstream event stream. */
    late(): Response {
      const body = new ReadableStream<Uint8Array>({
        start: upstream => {
          upstreams.push(upstream)
        },
      })
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    }

    /** A hand-written event stream that never sends anything. */
    silent(): HttpResponse<ReadableStream<Uint8Array>> {
      return HttpResponse.stream(new ReadableStream<Uint8Array>({ start: () => undefined }), {
        contentType: 'text/event-stream',
      })
    }
  }
  return {
    upstreams,
    metadata: metadata({ [t('QuietController')]: provider(QuietController) }, [
      controller(t('QuietController'), '/quiet', [
        route('late', '/late', (c: QuietController) => c.late()),
        route('silent', '/silent', (c: QuietController) => c.silent()),
      ]),
    ]),
  }
}

/** Resolves with `value`, or with `fallback` after `ms` (a hang is reported, not awaited forever). */
function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>(resolve => {
    timer = setTimeout(() => resolve(fallback), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function settled(http: HttpPlugin): Promise<number> {
  const started = Date.now()
  while (http.inflight !== 0 && Date.now() - started < 1_000) await new Promise(resolve => setTimeout(resolve, 10))
  return http.inflight
}

/** Opens the quiet streams with `injectSse()` and reports what a test sees (no timing in the result). */
export async function checkQuietStreams(http: HttpPlugin, app: QuietApp): Promise<unknown> {
  const outcome = async (url: string, write?: () => void): Promise<Record<string, unknown>> => {
    const started = Date.now()
    const stream = await within(
      http.injectSse({ url }).catch((error: unknown) => (error as Error).message),
      5_000,
      'injectSse() pending',
    )
    if (typeof stream === 'string') return { opened: stream }
    const waited = Date.now() - started
    const early = await stream.next({ timeoutMs: 50 }).then(
      event => event.data,
      (error: unknown) => (error as Error).message,
    )
    write?.()
    const late =
      write === undefined
        ? undefined
        : await stream.next().then(
            event => event.data,
            (error: unknown) => (error as Error).message,
          )
    const closed = await within(
      stream.close().then(() => 'closed'),
      1_000,
      'close() pending',
    )
    return {
      opened: 'opened',
      // the bound (2 000 ms), not a hang nor an immediate answer
      bounded: waited >= 1_900 && waited < 3_500,
      status: stream.status,
      contentType: stream.headers['content-type'],
      retry: stream.retry ?? null,
      comments: stream.comments,
      early,
      ...(late === undefined ? {} : { late }),
      closed,
    }
  }
  const [late, silent] = await Promise.all([
    outcome('/quiet/late', () => app.upstreams.at(-1)?.enqueue(ENCODER.encode('data: late\n\n'))),
    outcome('/quiet/silent'),
  ])
  return { late, silent, inflight: await settled(http) }
}
