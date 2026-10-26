/**
 * Web stream helpers shared by the pipeline and the adapters (internal): conversion of handler
 * stream sources (`ReadableStream`, Node.js `Readable`, async iterables) to byte streams, tracking of
 * response streams (request scope lifetime) and small constructors.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * A stream source accepted by `HttpResponse.stream()`: a Web `ReadableStream`, a Node.js `Readable`
 * or any async iterable (async generator...) of `Uint8Array` / `string` chunks (strings are encoded
 * as UTF-8).
 */
export type StreamSource = ReadableStream<Uint8Array | string> | AsyncIterable<Uint8Array | string>

/** Runs a function in a captured async context (`AsyncLocalStorage.snapshot()`). */
export type ContextRunner = <R>(fn: () => R) => R

const ENCODER = new TextEncoder()

/** The current async context, to run stream reads in it later (the request scope of a response). */
export function captureContext(): ContextRunner {
  const snapshot = (AsyncLocalStorage as { snapshot?: () => ContextRunner }).snapshot
  return typeof snapshot === 'function' ? snapshot() : run => run()
}

/** Whether `value` is a stream source (Web stream, Node.js readable or async iterable). */
export function isStreamSource(value: unknown): value is StreamSource {
  return (
    value instanceof ReadableStream ||
    (value !== null &&
      typeof value === 'object' &&
      typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function')
  )
}

/** Byte streams created by {@link toByteStream} (already normalised: not wrapped again). */
const BYTE_STREAMS = new WeakSet<ReadableStream<Uint8Array>>()

/** Whether `stream` was created by {@link toByteStream}. */
export function isByteStream(stream: ReadableStream<unknown>): boolean {
  return BYTE_STREAMS.has(stream as ReadableStream<Uint8Array>)
}

/**
 * Converts a stream source to a pull-based byte stream: the source is read only when the consumer
 * reads (backpressure), strings are encoded as UTF-8, `ArrayBuffer`s and views are converted, empty
 * chunks are skipped and cancelling the stream cancels the source (`iterator.return()`, which
 * destroys a Node.js `Readable`; a `Readable` that was never read is destroyed directly).
 *
 * @throws TypeError (as a stream error) for chunks that are neither bytes nor strings.
 */
export function toByteStream(source: StreamSource): ReadableStream<Uint8Array> {
  let iterator: AsyncIterator<unknown> | undefined
  let reader: ChunkReader | undefined
  const next = (): Promise<IteratorResult<unknown>> => {
    if (source instanceof ReadableStream) {
      const current: ChunkReader = reader ?? source.getReader()
      reader = current
      return current.read() as Promise<IteratorResult<unknown>>
    }
    iterator ??= source[Symbol.asyncIterator]()
    return iterator.next()
  }
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        for (;;) {
          const result = await next()
          if (result.done === true) {
            controller.close()
            return
          }
          const chunk = toChunk(result.value)
          if (chunk.byteLength > 0) {
            controller.enqueue(chunk)
            return
          }
        }
      },
      async cancel(reason) {
        if (reader !== undefined) await reader.cancel(reason)
        else if (source instanceof ReadableStream) await source.cancel(reason)
        else if (iterator === undefined) {
          // never read: an async generator has nothing to clean up, a Node.js `Readable` holds its resource
          const destroyable = source as { destroy?: unknown }
          if (typeof destroyable.destroy === 'function') destroyable.destroy()
        } else await iterator.return?.(reason)
      },
    },
    { highWaterMark: 0 },
  )
  BYTE_STREAMS.add(stream)
  return stream
}

/** The part of a stream reader used here (Node.js and Bun declare different reader types). */
interface ChunkReader {
  read(): Promise<{ readonly done?: boolean; readonly value?: unknown }>
  cancel(reason?: unknown): Promise<void>
}

function toChunk(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (typeof value === 'string') return ENCODER.encode(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  throw new TypeError(
    `Invalid stream chunk: expected a Uint8Array or a string, received ${value === null ? 'null' : typeof value}`,
  )
}

/** The part of a byte stream reader used by {@link trackStream}. */
interface ByteReader {
  read(): Promise<{ readonly done?: boolean; readonly value?: Uint8Array | undefined }>
  cancel(reason?: unknown): Promise<void>
}

/** A response stream whose completion is observed. */
export interface TrackedStream {
  readonly stream: ReadableStream<Uint8Array>
  /**
   * Resolves once the source was fully read (`undefined`), cancelled by the consumer (`undefined`:
   * client disconnected, HEAD...) or failed (the error). Never rejects.
   */
  readonly done: Promise<unknown>
}

/**
 * Wraps a response body so that the pipeline knows when it has been fully sent (or abandoned) and
 * reads the source in `run` (the async context of the request scope, so that stream producers can
 * use request-scoped providers). The wrapper is pull-based (no read-ahead): backpressure is the
 * consumer's. A `Blob` is read through `blob.stream()`, opened on the first read only.
 */
export function trackStream(body: ReadableStream<Uint8Array> | Blob, run: ContextRunner): TrackedStream {
  let reader: ByteReader | undefined = body instanceof Blob ? undefined : body.getReader()
  let settle: (error: unknown) => void = () => undefined
  const done = new Promise<unknown>(resolve => {
    settle = resolve
  })
  let finished = false
  const finish = (error?: unknown): void => {
    if (finished) return
    finished = true
    settle(error)
  }
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let result: Awaited<ReturnType<ByteReader['read']>>
        try {
          result = await run(() => {
            reader ??= (body as Blob).stream().getReader()
            return reader.read()
          })
        } catch (error) {
          finish(error)
          throw error
        }
        if (result.done === true) {
          controller.close()
          finish()
          return
        }
        controller.enqueue(result.value as Uint8Array)
      },
      async cancel(reason) {
        try {
          const current = reader
          if (current !== undefined) await run(() => current.cancel(reason))
        } catch {
          // the source failed while being cancelled: nothing left to send anyway
        } finally {
          finish()
        }
      },
    },
    { highWaterMark: 0 },
  )
  return { stream, done }
}

/** A stream failing with `error` on first read. */
export function failedStream(error: unknown): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(error)
    },
  })
}

/** Cancels a stream, ignoring failures (unconsumed response bodies). */
export function discardStream(stream: ReadableStream<Uint8Array> | null | undefined): void {
  if (stream instanceof ReadableStream && !stream.locked) stream.cancel().catch(() => undefined)
}
