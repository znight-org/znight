<p align="center">
  <img src="./docs/assets/logo.png" alt="Znight Logo" width="200" />
</p>

<h1 align="center">Znight</h1>

<p align="center">
  <strong>Compile-time dependency injection framework for TypeScript</strong>
</p>

<p align="center">
  Zero reflect-metadata • Zero runtime overhead • Errors at build time
</p>

<p align="center">
  <a href="#installation">Installation</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#documentation">Documentation</a> •
  <a href="#packages">Packages</a> •
  <a href="#contributing">Contributing</a>
</p>

---

## Why Znight?

Modern TypeScript frameworks like NestJS rely on runtime reflection (`reflect-metadata`) to resolve dependencies. This approach has significant drawbacks:

| Runtime DI (NestJS, etc.) | Compile-time DI (Znight) |
|---------------------------|--------------------------|
| 🐌 Reflection at runtime | ⚡ Everything resolved at build |
| 💥 DI errors at boot time | ✅ DI errors at compilation |
| 📦 `reflect-metadata` magic | 🔍 Generated code, fully transparent |
| 🥶 Slow cold starts (serverless pain) | 🚀 Instant cold starts |
| 🌳 No tree-shaking possible | ✂️ Full dead code elimination |

Znight takes inspiration from [Micronaut](https://micronaut.io/) (Java) and brings **compile-time DI** to the TypeScript ecosystem through a powerful Vite plugin.

## Features

- **🔌 Compile-time DI** — Dependencies resolved during build via AST analysis
- **🎯 Type-safe** — Full TypeScript support with compile-time validation
- **🧩 Composable** — Pick your HTTP adapter (Fastify, Express, Hono), messaging driver, etc.
- **📊 Observable** — Logging, metrics, and tracing built-in
- **🏢 Enterprise-ready** — Build microservices, workers, APIs with consistent patterns
- **🧪 Testable** — First-class testing utilities with auto-mocking
- **⚡ Fast** — Minimal runtime, instant bootstrap, optimized for serverless

## Installation

```bash
# Create a new project
npx @znight/cli new my-service

# Or add to existing project
npm install @znight/core @znight/compiler
```

## Quick Start

### 1. Configure Vite

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import { znight } from '@znight/compiler';

export default defineConfig({
  plugins: [znight()]
});
```

### 2. Create a Service

```typescript
// src/services/user.service.ts
import { Injectable } from '@znight/core';
import { Logger } from '@znight/logging';

@Injectable()
export class UserService {
  constructor(private logger: Logger) {}

  async findById(id: string): Promise<User> {
    this.logger.info('Finding user', { id });
    // ...
  }
}
```

### 3. Create a Controller

```typescript
// src/controllers/user.controller.ts
import { Controller, Get, Param } from '@znight/http';
import { UserService } from '../services/user.service';

@Controller('/users')
export class UserController {
  constructor(private users: UserService) {}

  @Get('/:id')
  async getUser(@Param('id') id: string) {
    return this.users.findById(id);
  }
}
```

### 4. Bootstrap

```typescript
// src/main.ts
import { Application } from '@znight/core';
import { HttpPlugin } from '@znight/http';

const app = await Application.create({
  plugins: [
    HttpPlugin.configure({ port: 3000 })
  ]
});

await app.start();
```

### 5. Build & Run

```bash
# Development with hot reload
npm run dev

# Build for production
npm run build

# Start production server
npm run start
```

**That's it!** No modules to configure, no metadata to emit. The compiler handles everything.

## Compile-Time Magic

When you build your project, Znight's compiler:

1. **Analyzes** your TypeScript code via AST parsing
2. **Validates** the dependency graph (missing deps, cycles, scope issues)
3. **Generates** an optimized container with pre-resolved dependencies
4. **Reports** errors at build time with precise locations

```bash
$ npm run build

✗ ZNIGHT001: Missing provider 'EmailService' required by NotificationService
  --> src/services/notification.service.ts:12:5

✗ ZNIGHT002: Circular dependency: OrderService -> PaymentService -> OrderService  
  --> src/services/order.service.ts:8:3

Build failed with 2 errors.
```

## Packages

| Package | Description | Status |
|---------|-------------|--------|
| `@znight/core` | Core runtime, decorators, lifecycle | 🚧 In Progress |
| `@znight/compiler` | Vite plugin, AST analysis, code generation | 🚧 In Progress |
| `@znight/http` | HTTP controllers (Fastify/Express/Hono adapters) | 📋 Planned |
| `@znight/messaging` | Message consumers (RabbitMQ/SQS/Kafka) | 📋 Planned |
| `@znight/config` | Type-safe configuration management | 📋 Planned |
| `@znight/logging` | Structured logging with context | 📋 Planned |
| `@znight/metrics` | Prometheus metrics | 📋 Planned |
| `@znight/tracing` | OpenTelemetry integration | 📋 Planned |
| `@znight/testing` | Test utilities, auto-mocking | 📋 Planned |
| `@znight/cli` | Project scaffolding, generators | 📋 Planned |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Your Application                         │
├─────────────────────────────────────────────────────────────────┤
│  @znight/http  │  @znight/messaging  │  @znight/scheduling     │
├─────────────────────────────────────────────────────────────────┤
│  @znight/logging   │   @znight/metrics   │   @znight/tracing   │
├─────────────────────────────────────────────────────────────────┤
│                         @znight/core                            │
│              (DI Container, Lifecycle, Plugins)                 │
├─────────────────────────────────────────────────────────────────┤
│                       @znight/compiler                          │
│           (Vite Plugin, AST Analysis, Validation)               │
└─────────────────────────────────────────────────────────────────┘
```

## Adapters

Znight is adapter-agnostic. Choose what fits your needs:

### HTTP Adapters

```typescript
import { HttpPlugin, FastifyAdapter } from '@znight/http';
// or ExpressAdapter, HonoAdapter

HttpPlugin.configure({
  adapter: new FastifyAdapter(),
  port: 3000
})
```

### Messaging Drivers

```typescript
import { MessagingPlugin, RabbitMQDriver } from '@znight/messaging';
// or SQSDriver, KafkaDriver

MessagingPlugin.configure({
  driver: new RabbitMQDriver({ url: 'amqp://localhost' })
})
```

## Comparison with NestJS

```typescript
// ❌ NestJS - Verbose module configuration
@Module({
  imports: [
    TypeOrmModule.forRoot(dbConfig),
    TypeOrmModule.forFeature([User]),
    ConfigModule.forRoot(),
    LoggerModule,
  ],
  controllers: [UserController],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}

@Module({
  imports: [UserModule, OrderModule, PaymentModule],
})
export class AppModule {}
```

```typescript
// ✅ Znight - Flat, simple, auto-discovered
const app = await Application.create({
  plugins: [HttpPlugin, DatabasePlugin],
  scan: ['./src/**/*.ts']  // Auto-discovery
});
```

## Roadmap

- [x] Project setup & architecture
- [ ] **Phase 1**: Compiler foundation (AST analysis, basic generation)
- [ ] **Phase 2**: Core runtime (container, lifecycle, plugins)
- [ ] **Phase 3**: HTTP plugin with adapters
- [ ] **Phase 4**: Advanced compiler features (cycles, scopes, source maps)
- [ ] **Phase 5**: Messaging, config, observability plugins
- [ ] **Phase 6**: CLI & documentation

## Contributing

We welcome contributions! Please see our [Contributing Guide](./CONTRIBUTING.md) for details.

```bash
# Clone the repo
git clone https://github.com/your-org/znight.git

# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test

# Run example app
pnpm dev --filter=example-app
```

## License

MIT © Znight Contributors

---

<p align="center">
  <sub>Built with ❤️ for the TypeScript community</sub>
</p>
