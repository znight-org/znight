# @znight-examples/shared

The provider library of the [monorepo example](../../README.md): providers and contracts shared by
`users-api` and `notifications-worker`.

| Export                                                                | Kind                                                                     |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `Clock`, `CLOCK`, `SystemClock`                                       | interface, its typed runtime key, its provider                           |
| `IdGenerator`, `RandomIdGenerator`                                    | abstract class, its default provider (applications may add a `@Primary`) |
| `UserDirectory`                                                       | provider (injects `Clock` and `IdGenerator`)                             |
| `User`, `CreateUserInput`, `UpdateUserInput`                          | DTO types + [Standard Schema](https://standardschema.dev) validators     |
| `UserNotFoundError`, `EmailAlreadyUsedError`                          | domain errors (each service maps them)                                   |
| `USER_EVENTS_QUEUE`, `UserEventType`, `UserRegistered`, `UserDeleted` | messaging contract                                                       |

It is a **source provider library**: `"znight": { "library": "source" }` in `package.json` makes the
compiler of every package depending on it scan `src/` and register its providers. Nothing to build,
nothing to register.

```sh
bun run test        # plain unit tests: providers are classes
bun run typecheck
bun run build       # JavaScript + declarations in dist/ (compiled-library flow only)
```

See [How it works](../../README.md#how-it-works) and
[Compiled libraries](../../README.md#compiled-libraries).
