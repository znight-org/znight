---
description: Upload and download files with @znight/http, stream responses with backpressure, receive large files, serve content from a database lazily, and push Server-Sent Events, with their lifecycle, shutdown and tests.
---

# Files and streaming

`@znight/http` handles uploads, downloads, streamed responses and Server-Sent Events itself, with
the same behaviour on the built-in server, Fastify, Express and Hono, on Node.js and Bun: no
`multer`, no `@fastify/multipart`, no SSE library. This page shows how to use them; the
[package reference](/packages/http) lists the options and limits.

## Files {#files}

### Uploads {#uploads}

Declare the files a route accepts with `@UploadedFile()` (one file) or `@UploadedFiles()` (several),
with their limits. The text fields of the form arrive through `@Body()`:

```ts
import { Body, Controller, Post, UploadedFile, UploadedFiles } from '@znight/http'
import { z } from 'zod'

export const AvatarForm = z.object({ title: z.string().min(1) })

@Controller('/profile')
export class ProfileController {
  @Post('/avatar')
  avatar(
    @UploadedFile('avatar', { maxSize: '2mb', mimeTypes: ['image/png', 'image/jpeg'] }) avatar: File,
    @Body(AvatarForm) form: z.output<typeof AvatarForm>, // the text fields of the form
  ) {
    return { size: avatar.size, type: avatar.type, title: form.title }
  }

  @Post('/documents')
  add(
    @UploadedFiles('documents', { maxFiles: 5, maxSize: '20mb' }) documents: File[],
    @UploadedFile('cover') cover?: File, // optional: undefined when absent
  ) {}
}
```

- Uploaded files are standard `File` objects (`name`, `type`, `size`, `arrayBuffer()`, `text()`,
  `stream()`), held in memory.
- The multipart body is parsed **as it arrives**, with Znight's own RFC 7578 parser: an invalid
  upload (a file too large, a refused type, a file in an undeclared field) is rejected as soon as
  the offending part shows up, with a `400`, `413` or `415`, before the rest of the body is read.
- Limits apply per parameter (`maxSize`, `maxFiles`, `mimeTypes`, `required`) and plugin-wide
  (`uploads: { maxFileSize, maxFiles, maxParts, maxFieldSize }`): see the
  [upload options and statuses](/packages/http#uploads).

### Downloads {#downloads}

Return `HttpResponse.file()` to send a file from the disk:

```ts
@Get('/reports/*')
download(@Param('*') name: string) {
  return HttpResponse.file(name, { root: REPORTS_DIR }) // '../../etc/passwd' → 404
}

@Get('/invoices/:id')
async invoice(@Param('id') id: string) {
  return HttpResponse.file(await this.invoices.pathOf(id), { filename: `Facture ${id}.pdf` }) // attachment
}
```

The file is streamed with its `Content-Type` (from the extension), `Content-Length`,
`Last-Modified`, `ETag` and `Accept-Ranges`. Conditional requests answer `304` or `412`, single byte
ranges `206`, and `filename` sets a `Content-Disposition` with a UTF-8 `filename*` for non-ASCII
names. With `root`, a path leaving the directory (`..`, an absolute path, a symbolic link) or naming
a dotfile (`.env`, `.git/`) answers `404`: **always pass `root` when the path comes from the
request**.

### Content stored elsewhere: lazy files {#lazy-files}

A file kept in a database or an object storage is passed as a **lazy file**: its metadata up front,
its bytes behind `load()`. Preconditions and ranges are evaluated from the metadata, so `load()`
runs only when a body is sent, never for a `304`, a `412` or a `HEAD` request:

```ts
@Get('/books/:id/cover')
async cover(@Param('id') id: number) {
  const cover = await this.covers.info(id) // type, size and date, without the bytes
  return HttpResponse.file({
    size: cover.size,
    lastModified: cover.updatedAt, // or etag: '"v42"'
    type: cover.contentType,
    load: () => this.covers.bytes(id, cover.updatedAt), // Uint8Array, Blob or stream: the whole content
  })
}
```

An error of `load()` goes through the [exception mappers](./http#exception-mappers) like an error of
the handler. The content must have the declared `size`, and `load()` should read the version the
metadata describes: it runs later, and a concurrent update may have changed the bytes (the
`rest-api` example answers `503` with `retry-after` in that case). The
[package README](../../packages/http/README.md#lazy-files) has the details.

### Streaming responses {#streaming-responses}

Return `HttpResponse.stream()` to send data as it is produced: an export, a report, a proxied
download.

```ts
@Get('/export.csv')
export() {
  async function* lines(users: UserService) {
    yield 'id,email\n'
    for await (const user of users.iterate()) yield `${user.id},${user.email}\n`
  }
  return HttpResponse.stream(lines(this.users), { filename: 'users.csv' })
}
```

The source (a Web `ReadableStream`, a Node.js `Readable` or an async iterable of `Uint8Array` /
`string` chunks) is read as fast as the client receives the data (backpressure) and cancelled when
the client disconnects. It runs in the request scope: request-scoped instances are disposed only
after the stream has been sent or cancelled, and the graceful shutdown waits for streamed responses.

### Large files {#large-files}

::: tip Recommended
For large files, let clients upload **directly to object storage** with presigned URLs (S3, GCS,
R2...): the API authorises the upload and returns the URL, your servers never carry the bytes.
:::

To receive a large file through the API, send it as the raw request body and stream it with
`ctx.bodyStream()`: nothing is buffered, backpressure applies, and the route limit still applies.

```ts
@Put('/files/:id')
@BodyLimit('5gb')
async store(@Param('id', FileId) id: string, @Ctx() ctx: HttpContext) {
  await pipeline(Readable.fromWeb(ctx.bodyStream()), createWriteStream(join(UPLOADS_DIR, id)))
}
```

### Security {#file-security}

::: warning Never trust what the client sends

- `File.name` is chosen by the client: never use it as a path. Store files under generated
  identifiers and keep the name as metadata.
- `File.type` and `mimeTypes` rely on the type the client declares: check the content (magic
  numbers) when it matters.
- Always pass `root` to `HttpResponse.file()` when the path comes from the request.
- Store uploads outside of the web root, and serve user content as an `attachment` (or from another
  domain): an uploaded HTML or SVG file served inline runs scripts in your origin. The default
  [security headers](/packages/http#security-headers) (`nosniff` and a `default-src 'none'` CSP)
  are a second line of defence: keep them on.
- Keep limits tight (`maxSize`, `maxFiles`, `@BodyLimit`, plugin `uploads`): uploaded files live in
  memory.

:::

### Testing uploads and downloads {#testing-files}

`inject()` accepts a `FormData` body and returns binary responses in `bytes`; the upload rules of
the route apply exactly as over the network:

```ts
const form = new FormData()
form.append('title', 'Me')
form.append('avatar', new File([await readFile('test/fixtures/me.png')], 'me.png', { type: 'image/png' }))
const res = await app.inject({ method: 'POST', url: '/profile/avatar', body: form })
expect(res.status).toBe(201)

const range = await app.inject({ url: '/reports/q1.pdf', headers: { range: 'bytes=0-99' } })
expect(range.status).toBe(206)
expect(range.bytes.byteLength).toBe(100)
```

More cases in the [Testing guide](./testing#uploads-and-downloads).

## Server-Sent Events {#server-sent-events}

`@Sse(path?, options?)` declares a `GET` route serving an event stream: no dependency, identical on
every adapter, Node.js and Bun. Browsers read it with `EventSource`, which reconnects by itself.

```ts
import {
  Controller,
  Ctx,
  Headers,
  type HttpContext,
  HttpResponse,
  NotFoundException,
  Param,
  Sse,
  type SseEvent,
} from '@znight/http'

@Controller('/orders')
export class OrderEventsController {
  constructor(
    private readonly orders: OrderService,
    private readonly hub: OrderHub,
  ) {}

  /** An async method checks first, then returns the source of events. */
  @Sse('/:id/events', { retry: 5_000, maxDuration: 30 * 60_000 })
  async events(
    @Param('id') id: string,
    @Headers('last-event-id') lastEventId: string | undefined, // sent by EventSource when it reconnects
    @Ctx() ctx: HttpContext,
  ): Promise<AsyncIterable<SseEvent<OrderEvent>> | HttpResponse> {
    const order = await this.orders.find(id)
    if (order === undefined) throw new NotFoundException(`Order ${id} not found`) // EventSource stops
    if (order.closed) return HttpResponse.noContent() // 204: EventSource stops reconnecting
    return this.hub.subscribe(id, { after: lastEventId, signal: ctx.signal })
  }
}
```

- The handler returns an `AsyncIterable`, an `Iterable` or a `ReadableStream` of `SseEvent`
  (`{ data, event, id, retry, comment }`). Non-string `data` is sent as JSON, and user content can
  never inject fields.
- **Check first, then stream.** Prefer an `async` method returning the source over an `async *`
  generator: the body of a generator only runs once the `200` is sent, too late to answer `404` or
  `204`.
- **Resume.** Give events an `id`: `EventSource` sends the last one back in `last-event-id` when it
  reconnects, and the source resumes after it.
- **Push sources.** `EventChannel` bridges a bus or an `EventEmitter` to a stream, with a bounded
  buffer per client (`capacity`, and `overflow`: `'drop-oldest'`, `'drop-newest'` or `'close'`).
- `HttpResponse.sse(source)` serves an event stream from any route and method (`POST` streaming for
  `fetch()` clients).

The `heartbeat`, `retry` and `maxDuration` options, and their plugin-wide defaults, are in the
[reference](/packages/http#server-sent-events).

### Stream lifecycle {#stream-lifecycle}

- **Open**: the status, the headers and a first chunk are sent at once, on every adapter. Guards
  run before, once: use `maxDuration` to force re-authentication of long streams.
- **Backpressure**: events are pulled one at a time, nothing is read ahead.
- **Client disconnect**: `ctx.signal` aborts and the source is stopped. Pass `ctx.signal` to the
  source: the request scope waits for it to stop (5 s at most, with a warning).
- **Errors**: a source that throws ends the stream cleanly, logged; the client reconnects.
- **`maxDuration` and shutdown**: `ctx.signal` aborts, the source gets `sse.shutdownGraceMs` to send
  final events, then the client receives a jittered `retry` and reconnects, to another instance
  during a rolling deployment. Keep `sse.shutdownGraceMs` below the plugin's `drainTimeoutMs`.
- **Authentication**: `EventSource` cannot send an `Authorization` header: authenticate browser
  streams with a cookie ([Cookies](./http#cookies)).

Proxies and load balancers need nothing special: see
[event streams behind a proxy](./deployment#event-streams-behind-a-proxy).

### Testing event streams {#testing-event-streams}

`inject()` rejects an event stream instead of waiting for its end. `injectSse()` (on the plugin and
on [`TestApp`](./testing#server-sent-events)) reads it in memory like `EventSource`;
`injectStream()` gives the raw `ReadableStream`:

```ts
await using stream = await app.injectSse({ url: '/orders/o-1/events' })
expect(stream.status).toBe(200)

hub.publish({ orderId: 'o-1', sequence: 42, type: 'status', status: 'paid' })
const event = await stream.next() // rejects after 2 000 ms by default
expect(event).toMatchObject({ event: 'status', id: '42' })
expect(event.json()).toMatchObject({ status: 'paid' })

const resumed = await stream.reconnect() // sends last-event-id: 42, like EventSource
```

Events are read only when asked for (`next()`, `take(n)`, `for await`), so the test sets the pace of
the client; `close()` (or the end of the `await using` block) is a client disconnect. Opening never
hangs a test: `injectSse()` resolves at the first chunk of the stream, or after 2 000 ms for a
stream that sends nothing yet, and rejects, naming the request, when the response headers do not
arrive within 2 000 ms.

## Other real-time options {#other-real-time}

Server-Sent Events push from the server to the client over plain HTTP. For two-way messages, use
[WebSocket gateways](./websockets); for GraphQL subscriptions, the [GraphQL guide](./graphql) serves
them over SSE.
