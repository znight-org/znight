import { Config, Secret } from '@znight/config'

@Config('webhook')
export class WebhookConfig {
  /** Shared with the billing provider: it signs every delivery with it (HMAC-SHA256). */
  @Secret('WEBHOOK_SECRET')
  secret!: string
}
