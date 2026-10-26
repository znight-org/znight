import { Factory, Provides } from '@znight/core'

export class Connection {}

@Factory()
export class ConnectionFactory {
  constructor(readonly connections: Connection[]) {}

  @Provides()
  connection(): Connection {
    return new Connection()
  }
}
