import { Config, Secret } from '@znight/config'

/**
 * API keys. `@Secret` values are masked (`[REDACTED]`) whenever the instance is logged, serialised or
 * printed in an error message; the properties themselves keep the real values. Both are required: no
 * boot without them (ZNIGHT006, every missing variable listed).
 */
@Config('auth')
export class AuthConfig {
  /** Key of the editors: they add books (and read, review, subscribe like readers). */
  @Secret('EDITOR_API_KEY')
  editorApiKey!: string

  /** Key of the readers: `me`, reviews and subscriptions. */
  @Secret('READER_API_KEY')
  readerApiKey!: string
}
