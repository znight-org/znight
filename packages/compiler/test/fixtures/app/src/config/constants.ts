export const PORT = 3000
export const HOST = 'localhost'
export const BASE = '/api'
export const URL = `http://${HOST}:${PORT}${BASE}`
export const ROUTES = { users: `${BASE}/users`, admin: { root: `${BASE}/admin` } } as const
export const ROLES = ['admin', 'user'] as const
export const ALL_ROLES = [...ROLES, 'guest'] satisfies readonly string[]
export const FLAGS = (1 << 3) | 1
export const BIG = 10n ** 3n
export const TIMEOUT = (PORT * 2) as number
export const MAYBE: string | undefined = undefined
export const FALLBACK = MAYBE ?? 'default'
export const SPREAD = { ...ROUTES, extra: true }
export enum Color {
  Red,
  Green = 5,
  Blue,
}
export enum Level {
  Debug = 'debug',
  Info = 'info',
}
export let mutable = 1
export const computed = Math.max(1, 2)
export function helper(): void {}
export class Guard {}
export const CYCLE_A: number = CYCLE_B
export const CYCLE_B: number = CYCLE_A
const PRIVATE = 'secret'
export const USES_PRIVATE = `${PRIVATE}!`
export const LIST = [Guard]
