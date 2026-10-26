import { Injectable, type OnStart } from '@znight/core'

@Injectable()
export class Leaf {}

@Injectable()
export class UsedByRoot {
  constructor(readonly leaf: Leaf) {}
}

@Injectable()
export class Scheduler implements OnStart {
  constructor(readonly used: UsedByRoot) {}
  onStart(): void {}
}

@Injectable()
export class Orphan {}

@Injectable()
export class OrphanDependency {}

@Injectable()
export class OrphanParent {
  constructor(readonly dependency: OrphanDependency) {}
}

export abstract class Port {}

@Injectable()
export class PortAdapter extends Port {}

@Injectable()
export class ReferencedInMain {}
