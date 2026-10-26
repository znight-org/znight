export const Settings = { debug: false }
export type Settings = { debug: boolean }

export interface Clock {
  now(): number
}
export class Clock {}
