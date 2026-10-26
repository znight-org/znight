import { Injectable } from '@znight/core'

@Injectable()
export class RingA {
  constructor(readonly b: RingB) {}
}

@Injectable()
export class RingB {
  constructor(readonly c: RingC) {}
}

@Injectable()
export class RingC {
  constructor(readonly a: RingA) {}
}
