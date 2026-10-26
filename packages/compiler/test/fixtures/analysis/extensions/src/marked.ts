import { Mark as Acme } from '@acme/ext'
import { Mark as ArrayMark } from '@znight/array-ext'
import '@znight/bad-version'
import '@znight/broken-ext'
import '@znight/conditional-ext'
import { Mark as DupA } from '@znight/dup-a'
import { Mark as DupB } from '@znight/dup-b'
import '@znight/invalid-ext'
import '@znight/missing-ext'
import { Mark as Boom } from '@znight/throwing-ext'

@Acme()
export class AcmeMarked {}

@ArrayMark()
export class ArrayMarked {}

@DupA()
export class DupAMarked {}

@DupB()
export class DupBMarked {}

@Boom()
export class BoomMarked {}
