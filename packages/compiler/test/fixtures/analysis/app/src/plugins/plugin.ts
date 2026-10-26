import { Injectable } from '@znight/core'

export abstract class Plugin {
  abstract name(): string
}

@Injectable()
export class BetaPlugin extends Plugin {
  name(): string {
    return 'beta'
  }
}

@Injectable()
export class AlphaPlugin extends Plugin {
  name(): string {
    return 'alpha'
  }
}
