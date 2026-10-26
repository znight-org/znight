import { Factory, Inject, Injectable, type Lazy, Provides } from '@znight/core'
import type { Missing } from './does-not-exist.ts'

export class Service {}

export function Mixin<T extends abstract new (...args: never[]) => object>(base: T): T {
  return base
}

export class Base {
  constructor(readonly service: Service) {}
}

@Factory()
export class Values {
  @Provides({ name: 'port' })
  port(): number {
    return 3000
  }

  @Provides({ name: 'request', scope: 'request' })
  async perRequest(): Promise<Service> {
    return new Service()
  }
}

@Injectable()
export class Unresolvable {
  constructor(
    // biome-ignore lint: fixture
    readonly untyped,
    readonly primitive: string,
    readonly literal: { readonly a: number },
    readonly unknownImport: Missing,
    readonly promise: Promise<Service>,
    readonly lazyMulti: Lazy<Service[]>,
    @Inject('port') readonly wrongKind: string,
    readonly union: Service | Base,
    ...rest: Service[]
  ) {
    void rest
  }
}

@Injectable()
export class FromMixin extends Mixin(Base) {}

@Injectable()
export class ValueInjection {
  constructor(@Inject('port') readonly port: number, @Inject('port') readonly anything: unknown) {}
}
