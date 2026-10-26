import { Injectable } from '@znight/core'

/**
 * Generates unique identifiers.
 *
 * An abstract class rather than an interface: it is an injection type like an interface, and it also
 * exists at runtime (`app.get(IdGenerator)`, `overrides: [[IdGenerator, fake]]` in tests). It cannot
 * be a provider itself (it is abstract): its implementations are.
 */
export abstract class IdGenerator {
  /** A new identifier, never returned before. */
  abstract next(): string
}

/**
 * Default {@link IdGenerator}: random UUIDs (v4). Applications that need other identifiers declare
 * their own implementation with `@Primary()` (see `services/users-api`), which then wins everywhere,
 * including inside this library's own providers.
 */
@Injectable()
export class RandomIdGenerator extends IdGenerator {
  next(): string {
    return crypto.randomUUID()
  }
}
