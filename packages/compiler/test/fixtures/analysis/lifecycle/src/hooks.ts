import { Injectable } from '@znight/core'

@Injectable()
export class StaticHook {
  static onStart(): void {}
}

@Injectable()
export class RequiredParameter {
  onStop(signal: string): void {
    void signal
  }
}

@Injectable()
export class OptionalParameter {
  onStop(signal?: string): void {
    void signal
  }
}

@Injectable({ scope: 'request' })
export class RequestHook {
  onReady(): void {}
  async [Symbol.asyncDispose](): Promise<void> {}
}

@Injectable({ scope: 'transient' })
export class TransientDispose {
  [Symbol.dispose](): void {}
}

export class BaseWithHook {
  onStart = (ready: boolean): void => {
    void ready
  }
}

@Injectable()
export class InheritsHook extends BaseWithHook {}
