import type { CoreLogger, LogContext } from '@znight/core'
import type { Logger } from './logger.ts'

/**
 * Adapts a {@link Logger} to the `CoreLogger` interface of `@znight/core`, so the framework (core,
 * plugins) logs through pino: `app.setLogger(toCoreLogger(logger))`. `ObservabilityPlugin` does it
 * automatically (option `logging.replaceCoreLogger`).
 */
export function toCoreLogger(logger: Logger): CoreLogger {
  return Object.freeze({
    debug: (message: string, context?: LogContext) => logger.debug(message, context),
    info: (message: string, context?: LogContext) => logger.info(message, context),
    warn: (message: string, context?: LogContext) => logger.warn(message, context),
    error: (message: string, context?: LogContext) => logger.error(message, context),
  })
}
