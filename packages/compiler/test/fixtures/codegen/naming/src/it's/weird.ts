import { Factory, Injectable, Provides } from '@znight/core'

export class Thing {
  readonly kind = 'thing'
}

@Injectable()
export class Quoted {
  readonly kind = "it's"
}

@Factory()
export class ThingFactory {
  @Provides()
  'make-thing'(): Thing {
    return new Thing()
  }
}
