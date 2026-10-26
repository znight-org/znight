import type { TypedToken } from '@znight/core'
import type { ConfigSource } from './source.ts'

import { token } from '@znight/core'

import { CONFIG_SOURCE_TOKEN } from './conventions.ts'

/** Tokens under which `@znight/config` exposes its objects to the container. */
export const ConfigTokens: {
  /** The {@link ConfigSource} built by `ConfigPlugin` (external declared in the package manifest). */
  readonly Source: TypedToken<ConfigSource>
} = Object.freeze({
  Source: token<ConfigSource>(CONFIG_SOURCE_TOKEN),
})
