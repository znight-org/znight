import { Factory, Injectable, Provides } from '@znight/core'

export class Thing {}

@Injectable()
export class NotAFactory {
  @Provides()
  thing(): Thing {
    return new Thing()
  }
}

@Factory()
export class BadFactory {
  @Provides()
  static make(): Thing {
    return new Thing()
  }

  @Provides()
  private hidden(): Thing {
    return new Thing()
  }

  @Provides()
  untyped() {
    return new Thing()
  }

  @Provides()
  nothing(): void {}

  @Provides()
  count(): number {
    return 1
  }

  @Provides({ dispose: 1 })
  disposable(): Thing {
    return new Thing()
  }
}
