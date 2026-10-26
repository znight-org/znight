import type { Logger } from '@fixture/lib'
import legacy = require('legacy-ns')
import pg, { type Pool } from 'pg'
import type { Missing } from './does-not-exist.ts'
import type { Box, Json, Maybe, Pair, Repository, Store, UserRepo } from './generics.ts'
import type { Models } from './ns.ts'
import type { User } from './users/user.model.ts'

export type TKeywords = [string, number, boolean, bigint, symbol, null, undefined, void, any, unknown, never, object]
export type TLiterals = ['a', 1, -2, true, 10n, -3n, `tpl`]
export type TArrays = [Array<User>, ReadonlyArray<User>, readonly User[], User[][], Array<User | Logger>]
export type TTuple = [a: string, b?: number, ...rest: boolean[]]
export type TUnion = User | undefined | null | User
export type TBooleanUnion = true | false | 'x'
export type TAbsorbed = string | 'a' | 1
export type TIntersection = Logger & User
export type TPromise = Promise<Repository<User>>
export type TDefaults = Repository<User>
export type TStore = Store
export type TAlias = UserRepo
export type TMaybe = Maybe<User>
export type TPair = Pair<User>
export type TJson = Json
export type TFunction = (x: string) => void
export type TConstructor = new () => User
export type TObject = { a: string }
export type TTypeof = typeof pg
export type TImport = import('./generics.ts').Repository<User>
export type TKeyof = keyof User
export type TIndexed = User['id']
export type TMapped = { [K in keyof User]: User[K] }
export type TConditional = User extends object ? 1 : 2
export type TTemplate = `user-${string}`
export type TGlobal = Date
export type TGlobalGeneric = Map<string, User>
export type TNamespace = Models.Inner
export type TNamespaceNested = Models.Deep.Leaf
export type TPgDefault = pg.Pool
export type TPool = Pool
export type TLegacy = legacy.Client
export type TMissing = Missing
export type TUndeclared = NotDeclaredAnywhere
export type TBox = Box
export type TParenthesized = (User | Logger)[]
export type TNotAType = typeof legacy
