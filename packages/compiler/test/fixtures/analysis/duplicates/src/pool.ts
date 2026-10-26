import { Factory, Injectable, Primary, Provides } from '@znight/core'

export class Pool {}

@Factory()
export class Pools {
  @Provides()
  main(): Pool {
    return new Pool()
  }

  @Provides()
  backup(): Pool {
    return new Pool()
  }
}

export interface Notifier {
  notify(): void
}

@Injectable()
export class EmailNotifier implements Notifier {
  notify(): void {}
}

@Injectable()
export class SmsNotifier implements Notifier {
  notify(): void {}
}

export interface Store {
  save(): void
}

@Injectable()
@Primary()
export class RedisStore implements Store {
  save(): void {}
}

@Injectable()
@Primary()
export class MemoryStore implements Store {
  save(): void {}
}

@Injectable()
export class Consumer {
  constructor(
    readonly pool: Pool,
    readonly notifier: Notifier,
    readonly store: Store,
    readonly notifiers: Notifier[],
  ) {}
}
