import type { Logger } from '@znight/observability'
import type { SmtpConfig } from './smtp.config.js'

import { Factory, Provides } from '@znight/core'

import { FakeSmtpClient, type SmtpClient } from './smtp.client.js'

/**
 * Creates the SMTP client. A `@Factory` is the way to provide objects the application does not
 * construct with `new` + injection: third-party clients, connections, pools.
 */
@Factory()
export class SmtpFactory {
  /**
   * - the declared return type, `SmtpClient`, is what gets injected (`Promise<T>`: an async factory,
   *   awaited at boot, so consumers never see a client that is not connected yet);
   * - parameters are injected like constructor parameters;
   * - `dispose: 'close'`: `client.close()` is called on shutdown, after the consumers drained their
   *   in-flight messages (also when the boot fails after the client was created).
   *
   * Swap FakeSmtpClient for a real client (nodemailer, an HTTP email API...) here: nothing else changes.
   */
  @Provides({ dispose: 'close' })
  async smtpClient(config: SmtpConfig, logger: Logger): Promise<SmtpClient> {
    const client = new FakeSmtpClient(config, logger.child({ component: 'smtp' }))
    await client.connect()
    return client
  }
}
