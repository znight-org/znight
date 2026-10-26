/**
 * `@znight-examples/shared`: providers and contracts shared by the services of the monorepo.
 *
 * A **source provider library**: its `package.json` declares `"znight": { "library": "source" }`, so
 * the compiler of every application depending on it scans these sources, registers the providers
 * (`SystemClock`, `RandomIdGenerator`, `UserDirectory`) and imports them in the generated container
 * through this public entry (`import { UserDirectory } from '@znight-examples/shared'`). Nothing has
 * to be registered by hand: depending on the package is enough.
 *
 * Every provider (and every value a decorator references) must be exported here: the generated
 * code never imports a path inside the package.
 */
export { USER_EVENTS_QUEUE, UserDeleted, UserEventType, UserRegistered } from './events/user-events.js'
export { IdGenerator, RandomIdGenerator } from './ids/id-generator.js'
export { CLOCK, type Clock, SystemClock } from './time/clock.js'
export {
  CreateUserInput,
  EmailAlreadyUsedError,
  UpdateUserInput,
  User,
  UserNotFoundError,
} from './users/user.js'
export { type ListUsersOptions, UserDirectory, type UserPage } from './users/user-directory.js'
export {
  email,
  type Field,
  type Issue,
  object,
  optional,
  type Schema,
  type TextOptions,
  text,
  timestamp,
  type ValidationResult,
} from './validation/schema.js'
