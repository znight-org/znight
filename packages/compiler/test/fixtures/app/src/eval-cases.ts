import { DEFAULT_PORT, Logger, ROLES, tokens } from '@fixture/lib'
import { EventEmitter } from 'node:events'
import cjs from 'cjs-only'
import * as C from './config/constants.ts'
import { Color, computed, Guard, helper, Level, LIST, mutable, PORT, ROUTES } from './config/constants.ts'
import config from './defaults/expr.ts'
import type { User } from './users/user.model.ts'

export const literals = [1, 'a', true, null, undefined, 10n, -5, +3, !0, ~1, void 0, NaN, Infinity]
export const arithmetic = { add: 1 + 2, sub: 5 - 3, mul: 2 * 3, div: 7 / 2, mod: 7 % 3, pow: 2 ** 10, neg: -PORT }
export const bitwise = [1 << 4, -16 >> 2, -16 >>> 28, 6 & 3, 6 | 3, 6 ^ 3, 2n ** 64n]
export const comparisons = [PORT === 3000, PORT !== 3000, 1 < 2, 'b' >= 'a', 2n > 1, 1 == 1]
export const strings = 'a' + 1 + true + null
export const template = `${PORT}-${Level.Debug}-${10n}`
export const logical = { nullish: null ?? 'x', or: '' || 'y', and: 1 && 'z', short: false && computed }
export const conditional = PORT > 1000 ? 'big' : computed
export const access = [ROUTES.users, ROUTES['admin'].root, C.ROLES[1], C.ROLES.length, 'abc'[1], config.port, ROUTES.missing]
export const optional = (undefined as { a?: string } | undefined)?.a.b
export const enums = [Color.Red, Color.Green, Color.Blue, Level.Info, C.Color.Blue]
export const spreads = { ...ROUTES, list: [...C.ROLES, 'x'], chars: [...'ab'], ...null }
export const computedKey = { [Level.Debug]: 1, ['k' + 1]: 2, 3: 'three', 'quoted-key': 4 }
export const packageConsts = [DEFAULT_PORT, ROLES[0], tokens.TOKEN_A]
export const wrappers = [PORT!, (PORT as number), <number>PORT, { a: 1 } satisfies Record<string, number>]
export const classRef = Guard
export const functionRef = helper
export const letRef = mutable
export const callRef = computed
export const packageClassRef = Logger
export const builtinRef = EventEmitter
export const untypedRef = cjs.Thing
export const namespaceRef = C.Guard
export const listRef = LIST
export const nestedRefs = { guard: Guard, list: [Logger], value: PORT }
export const call = Math.max(1, 2)
export const arrow = () => 1
export const unknownName = notDeclared
export const typeAsValue = User
export const propertyOfRef = Guard.name
export const badBinary = PORT + 10n
export const regexp = /x/
export const hole = [1, , 2]
export const method = { m() {} }
export const proto = { __proto__: null }
export const cycle = C.CYCLE_A
export const missingExport = C.NOPE
export const nullAccess = null.x
export const divisionByZero = 1n / 0n
export const wholeNamespace = C
