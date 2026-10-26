import { Factory, Inject, Injectable, Named, Optional, Provides } from '@znight/core'

@Injectable()
export abstract class AbstractService {}

@Injectable()
export class GenericService<T> {
  constructor(readonly value: T) {}
}

@Injectable()
class HiddenService {}

@Injectable()
@Factory()
export class TwoKinds {}

@Injectable
export class NotCalled {}

@Injectable({ scope: 'weird', lazy: true })
export class BadOptions {}

@Injectable()
@Injectable()
export class Twice {}

@Inject('x')
export class WrongTarget {}

@Injectable()
export class TooManyArguments {
  constructor(@Optional(1) readonly value?: TwoKinds) {}
}

function computeName(): string {
  return 'dynamic'
}

@Injectable()
export class NonStaticQualifier {
  constructor(@Inject(computeName()) readonly value: TwoKinds) {}
}

@Injectable()
export class NotAProvidesMethod {
  @Named('x')
  method(@Inject('y') _value: string): void {}
}

@Named('lonely')
export class NotAProvider {}

@Injectable()
export class PrivateConstructor {
  private constructor() {}
}

