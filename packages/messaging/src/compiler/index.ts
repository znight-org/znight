/**
 * `@znight/messaging/compiler`: the compiler extension of `@znight/messaging` (spec §5, §6.5, §9.2).
 *
 * Loaded by `@znight/compiler` through the package manifest (`package.json#znight.compiler`). It reads
 * `@Consumer` classes and their `@OnMessage` / `@Retry` / `@OnError` methods and `@Message` /
 * `@Headers` / `@Ctx` parameters, registers consumers as providers, reports invalid consumers at build
 * time and generates `metadata.extensions.messaging`.
 *
 * This entry only `import type`s from `@znight/compiler` and never loads the messaging runtime.
 */
import type { CompilerExtension, DecoratorSpec } from '@znight/compiler'
import type { MessagingData } from './data.ts'

import { analyzeMessagingClass } from './analyze.ts'
import { EXTENSION_NAME, MessagingDecorator } from './constants.ts'
import { generateMessaging } from './generate.ts'
import { validateMessaging } from './validate.ts'

export type {
  ConsumerData,
  HandlerData,
  HandlerParamData,
  MemberClassData,
  MessagingData,
  RetryPolicyData,
} from './data.ts'

/**
 * Decorators owned by the extension. `static` arguments must be statically evaluable (queue names,
 * types, retry options, header names); the `@Message` schema is a `value` (an exported binding).
 */
const decorators: Readonly<Record<string, DecoratorSpec>> = Object.freeze({
  [MessagingDecorator.Consumer]: { targets: ['class'], params: ['static'] },
  [MessagingDecorator.OnMessage]: { targets: ['method'], params: ['static'] },
  [MessagingDecorator.Retry]: { targets: ['method'], params: ['static'] },
  [MessagingDecorator.OnError]: { targets: ['method'], params: [] },
  [MessagingDecorator.Message]: { targets: ['parameter'], params: ['value'] },
  [MessagingDecorator.Headers]: { targets: ['parameter'], params: ['static'] },
  [MessagingDecorator.Ctx]: { targets: ['parameter'], params: [] },
} satisfies Record<string, DecoratorSpec>)

/** The `@znight/messaging` compiler extension. */
export const messagingCompilerExtension: CompilerExtension<MessagingData> = Object.freeze({
  apiVersion: 1,
  name: EXTENSION_NAME,
  decorators,
  analyzeClass: analyzeMessagingClass,
  validate: validateMessaging,
  generate: generateMessaging,
})

export default messagingCompilerExtension
