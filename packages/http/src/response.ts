import type { HeaderValue } from './exceptions.ts'

import { isValidStatus } from './status.ts'

/** Options of {@link HttpResponse}. */
export interface HttpResponseInit {
  /** Status code. Default: the route default (`@HttpCode`, 201 for POST, 204 without body, 200). */
  readonly status?: number
  /** Response headers (names are case-insensitive; arrays send the header several times). */
  readonly headers?: Readonly<Record<string, HeaderValue>>
}

/** Redirect statuses accepted by {@link HttpResponse.redirect}. */
export type RedirectStatus = 301 | 302 | 303 | 307 | 308

/**
 * A handler result carrying a status and headers next to the body. The body is serialised with the
 * usual rules (objects → JSON, strings → text, bytes and streams → octet-stream).
 *
 * ```ts
 * @Post('/')
 * async create(@Body(CreateUser) input: CreateUser): Promise<HttpResponse<User>> {
 *   const user = await this.users.create(input)
 *   return HttpResponse.created(user, `/users/${user.id}`)
 * }
 * ```
 *
 * Status precedence: `@HttpCode` > `HttpResponse.status` > route default.
 */
export class HttpResponse<T = unknown> {
  readonly body: T
  readonly status: number | undefined
  readonly headers: Readonly<Record<string, HeaderValue>>

  constructor(body: T, init: HttpResponseInit = {}) {
    if (init.status !== undefined && !isValidStatus(init.status)) {
      throw new RangeError(`Invalid HTTP status ${String(init.status)} (expected an integer between 100 and 599)`)
    }
    this.body = body
    this.status = init.status
    this.headers = init.headers ?? {}
  }

  /** `200 OK` with `body`. */
  static ok<T>(body: T, headers?: Readonly<Record<string, HeaderValue>>): HttpResponse<T> {
    return new HttpResponse(body, headers === undefined ? { status: 200 } : { status: 200, headers })
  }

  /** `201 Created`, with a `location` header when given. */
  static created<T = undefined>(body?: T, location?: string): HttpResponse<T | undefined> {
    return new HttpResponse(body, location === undefined ? { status: 201 } : { status: 201, headers: { location } })
  }

  /** `202 Accepted`. */
  static accepted<T = undefined>(body?: T): HttpResponse<T | undefined> {
    return new HttpResponse(body, { status: 202 })
  }

  /** `204 No Content`. */
  static noContent(): HttpResponse<undefined> {
    return new HttpResponse(undefined, { status: 204 })
  }

  /** A redirect (`302 Found` by default) to `location`. */
  static redirect(location: string, status: RedirectStatus = 302): HttpResponse<undefined> {
    return new HttpResponse(undefined, { status, headers: { location } })
  }

  /** A copy of this response with `name` set to `value`. */
  withHeader(name: string, value: HeaderValue): HttpResponse<T> {
    return new HttpResponse(this.body, {
      ...(this.status === undefined ? {} : { status: this.status }),
      headers: { ...this.headers, [name.toLowerCase()]: value },
    })
  }

  /** A copy of this response with another status. */
  withStatus(status: number): HttpResponse<T> {
    return new HttpResponse(this.body, { status, headers: this.headers })
  }
}

/** Whether `value` is an {@link HttpResponse} (also across duplicated package copies). */
export function isHttpResponse(value: unknown): value is HttpResponse {
  return (
    value instanceof HttpResponse ||
    (value !== null &&
      typeof value === 'object' &&
      (value as { constructor?: { name?: unknown } }).constructor?.name === 'HttpResponse' &&
      'body' in value &&
      'headers' in value)
  )
}
