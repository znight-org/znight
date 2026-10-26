import { HttpPlugin } from '@znight/http'
import { expressAdapter } from '@znight/http/express'
import express from 'express'

import { ApiConfig } from './api.config.js'
import { UserErrorMapper } from './users/user-error.mapper.js'

/** Options of {@link usersHttpPlugin}. */
export interface UsersHttpOptions {
  /** Port to listen on. Default: `ApiConfig.port` (PORT). Tests pass `0`. */
  readonly port?: number
}

/**
 * The HTTP plugin of users-api, shared by `main.ts` and the tests (TestApp), so that both run the
 * same pipeline: Express adapter and domain error mapping.
 *
 * The options are a function of the container, evaluated at bootstrap: they read `ApiConfig`, a
 * provider validated by ConfigPlugin.
 */
export function usersHttpPlugin(options: UsersHttpOptions = {}): HttpPlugin {
  return HttpPlugin.configure(container => {
    const config = container.get(ApiConfig)
    // A regular Express application: middleware added here runs before the Znight routes
    // (do not add body parsers for them: Znight reads and validates the bodies itself).
    const app = express().disable('x-powered-by')
    return {
      adapter: expressAdapter({ app }),
      port: options.port ?? config.port,
      exposeErrors: config.exposeErrors,
      exceptionMappers: [UserErrorMapper],
    }
  })
}
