import { Injectable } from '@znight/core'

export function Service(): ClassDecorator {
  return Injectable() as ClassDecorator
}

export const Repository = () => Injectable()

@Service()
export class ComposedService {}

@Repository()
export class ComposedRepository {}
