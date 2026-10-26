import { Injectable, type Lazy } from '@znight/core'

@Injectable()
export class Chicken {
  constructor(readonly egg: Lazy<Egg>) {}
}

@Injectable()
export class Egg {
  constructor(readonly chicken: Chicken) {}
}
