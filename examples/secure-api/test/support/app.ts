import type { HttpPlugin } from '@znight/http'

import { ConfigPlugin, inline } from '@znight/config'
import { ObservabilityPlugin } from '@znight/observability'
import { TestApp, type TestAppOptions } from '@znight/testing'

import { __ZNIGHT_METADATA__ as metadata } from '../../src/.znight/container.generated.js'
import { httpPlugin } from '../../src/http.js'
import {
  BROWSER_ORIGIN,
  EXPORT_KEY,
  LOCAL_ACCOUNTS,
  NEXT_EXPORT_KEY,
  SESSION_SECRET,
  WEBHOOK_SECRET,
} from './fixtures.js'
import { type JwksServer, startJwksServer } from './jwks-server.js'
import { AUDIENCE, ISSUER, jwks } from './tokens.js'

/** A JSON log line of the application. */
export interface LogEntry {
  readonly level: number
  readonly msg: string
  readonly [field: string]: unknown
}

export interface TestAppSetup extends Omit<TestAppOptions, 'metadata' | 'plugins'> {
  /** Configuration values, over the test defaults. */
  readonly env?: Readonly<Record<string, string>>
  /** The HTTP plugin. Default: the one of `main.ts` (`src/http.ts`), guards included. */
  readonly http?: HttpPlugin
  /** Receives the JSON log lines (`info` and above); the logs are silent otherwise. */
  readonly logs?: LogEntry[]
}

let identityProvider: Promise<JwksServer> | undefined

/** The identity provider of the tests, shared by every test file of the process. */
export function testJwksServer(): Promise<JwksServer> {
  identityProvider ??= startJwksServer(jwks)
  return identityProvider
}

/**
 * The application as `src/main.ts` wires it (the same `httpPlugin()`: guards, CORS, security headers,
 * trusted proxies and cookie secrets), configured with `inline()` instead of `.env` files and the
 * environment. The real `AuthGuard` runs and fetches the real key set over HTTP from a local server:
 * the tests cover the token checks too.
 *
 * `app.inject()` requests come from 127.0.0.1, a trusted proxy here (`TRUSTED_PROXIES=loopback`), so
 * a test sets the client address with `x-forwarded-for`.
 */
export async function createTestApp({ env = {}, http = httpPlugin(), logs, ...options }: TestAppSetup = {}) {
  const idp = await testJwksServer()
  return await TestApp.create({
    metadata,
    plugins: [
      ObservabilityPlugin.configure({
        logging:
          logs === undefined
            ? { level: 'silent' }
            : { level: 'info', destination: { write: line => void logs.push(JSON.parse(line) as LogEntry) } },
        metrics: false,
      }),
      ConfigPlugin.configure({
        loaders: [
          inline({
            AUTH_ISSUER: ISSUER,
            AUTH_AUDIENCE: AUDIENCE,
            AUTH_JWKS_URL: idp.jwksUrl,
            EXPORT_API_KEYS: `${EXPORT_KEY},${NEXT_EXPORT_KEY}`,
            SESSION_SECRETS: SESSION_SECRET,
            LOCAL_ACCOUNTS: JSON.stringify(LOCAL_ACCOUNTS),
            WEBHOOK_SECRET,
            CORS_ORIGINS: BROWSER_ORIGIN,
            TRUSTED_PROXIES: 'loopback',
            PORT: '0', // app.inject() needs no port; a free one when the server listens
            ...env,
          }),
        ],
      }),
      http,
    ],
    ...options,
  })
}

/** `{ authorization: 'Bearer <token>' }` */
export const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })
