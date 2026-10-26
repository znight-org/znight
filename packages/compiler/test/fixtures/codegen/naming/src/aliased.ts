import { Injectable } from '@znight/core'

@Injectable()
class Internal {
  readonly kind = 'internal'
}

export { Internal as Public }
