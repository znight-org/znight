import { Injectable } from '@znight/core'
import { UserService as UserServiceA } from './a/user.service.js'
import { Public } from './aliased.js'
import { UserService as UserServiceB } from './b/user.service.js'
import DefaultService from './default.js'
import { Date as UserDate, URL as UserURL, ZnightMetadata as UserMetadata } from './globals.js'
import { Quoted, Thing } from './it\'s/weird.js'
import { d } from './short.js'
import { Ünïcødé } from './unicode.js'
import { UserService as UserServiceZ } from './zz/user.service.js'

@Injectable()
export class Consumer {
  readonly all: readonly object[]

  constructor(
    a: UserServiceA,
    b: UserServiceB,
    z: UserServiceZ,
    date: UserDate,
    url: UserURL,
    metadata: UserMetadata,
    short: d,
    byDefault: DefaultService,
    aliased: Public,
    unicode: Ünïcødé,
    quoted: Quoted,
    thing: Thing,
  ) {
    this.all = [a, b, z, date, url, metadata, short, byDefault, aliased, unicode, quoted, thing]
  }
}
