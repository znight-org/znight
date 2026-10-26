import { Injectable } from '@znight/core'

@Injectable()
export class SelfDependent {
  constructor(readonly self?: SelfDependent) {}
}
