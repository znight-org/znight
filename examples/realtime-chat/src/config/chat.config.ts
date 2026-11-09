import { Config, Secret } from '@znight/config'

/**
 * The API keys of the clients: `name:key[:role...]` entries separated by commas
 * (`CHAT_KEYS=alice:key-a:moderator,bob:key-b`). Required, with no default: no boot without it
 * (ZNIGHT006). `@Secret` masks the value whenever the instance is logged or printed.
 */
@Config('chat')
export class ChatConfig {
  @Secret('CHAT_KEYS')
  keys!: string
}
