# @znight/compiler

Compile-time dependency injection compiler for the Znight framework.

## Overview

`@znight/compiler` is a Vite plugin that analyzes your TypeScript code at build time to extract dependency injection metadata and generate an optimized container. Unlike runtime-based DI frameworks, all dependency resolution happens during compilation, resulting in:

- ✅ Zero runtime overhead
- ✅ Compile-time error detection
- ✅ Better tree-shaking
- ✅ Instant cold starts (perfect for serverless)

## Installation

```bash
pnpm add -D @znight/compiler
```

## Usage

Add the plugin to your `vite.config.ts`:

```typescript
import { defineConfig } from 'vite';
import { znightPlugin } from '@znight/compiler';

export default defineConfig({
  plugins: [
    znightPlugin({
      // Optional configuration
      root: process.cwd(),
      outputPath: '.znight/container.generated.ts',
      tsconfig: 'tsconfig.json',
    }),
  ],
});
```

## How It Works

1. **Analysis Phase**: The plugin scans your TypeScript files for classes decorated with `@Injectable()`
2. **Validation Phase**: Validates the dependency graph for common errors (missing deps, circular deps, scope mismatches)
3. **Generation Phase**: Generates a container file with all metadata and resolution order

## Error Codes

| Code | Description |
|------|-------------|
| ZNIGHT001 | Missing provider - required dependency not found |
| ZNIGHT002 | Circular dependency detected |
| ZNIGHT003 | Scope mismatch - singleton depends on request/transient |
| ZNIGHT004 | Duplicate provider without @Primary |

## Example

```typescript
// user.service.ts
import { Injectable } from '@znight/core';

@Injectable()
export class UserService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly logger: Logger
  ) {}
}
```

The compiler will generate:

```typescript
// .znight/container.generated.ts
import { UserService } from './user.service.js';
import { DatabaseClient } from './database.client.js';
import { Logger } from './logger.js';

export const __ZNIGHT_METADATA__ = {
  providers: {
    UserService: {
      class: UserService,
      scope: 'singleton',
      dependencies: ['DatabaseClient', 'Logger'],
      factory: (deps) => new UserService(deps['DatabaseClient'], deps['Logger']),
    },
    // ...
  },
  resolutionOrder: ['Logger', 'DatabaseClient', 'UserService'],
};
```

## License

MIT
