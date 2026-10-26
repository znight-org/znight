import type { Logger } from '@fixture/web'

/** Not decorated: auto-registered through resolveClassRef. */
export class AdminGuard {
  readonly logger: Logger

  constructor(logger: Logger) {
    this.logger = logger
  }

  allows(): boolean {
    return true
  }
}
