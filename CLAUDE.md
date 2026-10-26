# CLAUDE.md - Znight Framework

## Vision

Znight est un framework Node.js/TypeScript inspiré de NestJS et Spring Boot, avec une différence majeure : **la résolution des dépendances se fait à la compilation, pas au runtime**.

L'approche est similaire à Micronaut (Java) : un plugin Vite analyse le code TypeScript via AST, extrait toutes les métadonnées, valide le graphe de dépendances, et génère un container optimisé. Résultat : **zéro reflect-metadata, zéro overhead runtime, erreurs à la compilation**.

---

## Principes Fondamentaux

1. **Compile-time DI** - Pas de reflection au runtime, tout est résolu par le compiler
2. **Flat DI** - Pas de modules imbriqués comme NestJS, un container global avec des scopes
3. **Convention over Configuration** - Defaults intelligents, config minimale
4. **Composable** - Chaque feature est un plugin indépendant (HTTP, Messaging, etc.)
5. **Adapter-agnostic** - Choix libre entre Fastify/Express/Hono, RabbitMQ/SQS/Kafka, etc.
6. **Observable by default** - Logging, metrics, tracing intégrés
7. **Enterprise-ready** - Facile de créer des libs, microservices, workers

---

## Avantages vs NestJS/Spring Boot

| Runtime DI (NestJS/Spring)          | Compile-Time DI (Znight)       |
| ----------------------------------- | ------------------------------ |
| Reflection au runtime = lent        | Tout résolu à la compilation   |
| Erreurs DI découvertes au boot      | Erreurs DI à la compilation    |
| `reflect-metadata` = magic          | Code généré = transparent      |
| Cold start lent (serverless killer) | Cold start instantané          |
| Tree-shaking impossible             | Dead code elimination possible |
| Modules imbriqués complexes         | Flat, simple, auto-découverte  |

---

## Architecture du Monorepo (Nx + pnpm)

```
znight/
├── packages/
│   ├── compiler/                 # Plugin Vite - LE CŒUR DU FRAMEWORK
│   │   └── src/
│   │       ├── analyzer/         # Extraction métadonnées via ts-morph
│   │       ├── generator/        # Génération du container
│   │       ├── validators/       # Validation compile-time
│   │       └── utils/            # Formatage erreurs, helpers
│   │
│   ├── core/                     # Runtime minimal
│   │   └── src/
│   │       ├── container/        # Container DI ultra-léger
│   │       ├── decorators/       # Decorators markers (@Injectable, etc.)
│   │       ├── lifecycle/        # Interfaces OnStart, OnStop, OnReady
│   │       └── plugins/          # Système de plugins
│   │
│   ├── http/                     # Plugin HTTP
│   │   └── src/
│   │       ├── adapters/         # Fastify, Express, Hono
│   │       ├── decorators/       # @Controller, @Get, @Post, @Body, etc.
│   │       └── router/           # Registration des routes
│   │
│   ├── messaging/                # Plugin Messaging
│   │   └── src/
│   │       ├── drivers/          # RabbitMQ, SQS, Kafka
│   │       └── decorators/       # @Consumer, @OnMessage, @Retry
│   │
│   ├── config/                   # Plugin Configuration
│   │   └── src/
│   │       ├── decorators/       # @Config, @Env, @Secret
│   │       └── loaders/          # Env, files, remote (Vault)
│   │
│   ├── observability/            # Plugin Observability
│   │   └── src/
│   │       ├── logging/          # Logger structuré (Pino)
│   │       ├── metrics/          # Prometheus
│   │       └── tracing/          # OpenTelemetry
│   │
│   ├── testing/                  # Utilities de test
│   │   └── src/
│   │       ├── testbed/          # TestBed avec auto-mocking
│   │       └── mocks/            # Mock factories
│   │
│   └── cli/                      # CLI scaffolding
│       └── src/
│           ├── commands/         # new, generate, dev, build
│           └── templates/        # Templates de génération
│
├── apps/
│   └── example/                  # App exemple pour tester
│
├── docs/
│   └── assets/                   # Logo, images
│
└── .github/
    └── workflows/                # CI/CD
```

---

## Comment ça marche

### 1. Le développeur écrit du code classique

```typescript
// user.service.ts
@Injectable()
export class UserService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly logger: Logger,
  ) {}
}
```

### 2. Le compiler analyse et génère

Le plugin Vite (via ts-morph) parse le TypeScript, extrait les métadonnées, valide, et génère :

```typescript
// .znight/container.generated.ts (auto-généré)
export const __ZNIGHT_METADATA__ = {
  providers: {
    UserService: {
      class: UserService,
      scope: 'singleton',
      dependencies: ['DatabaseClient', 'Logger'],
      factory: deps => new UserService(deps.DatabaseClient, deps.Logger),
    },
    // ...
  },
  resolutionOrder: ['Logger', 'DatabaseConfig', 'DatabaseClient', 'UserService'],
  // ...
}
```

### 3. Le runtime est minimal

```typescript
// Le container utilise le code pré-généré
for (const name of metadata.resolutionOrder) {
  const provider = metadata.providers[name]
  const deps = this.resolveDependencies(provider.dependencies)
  this.instances.set(name, provider.factory(deps))
}
```

### 4. Erreurs à la compilation

```bash
$ vite build

✗ ZNIGHT001: Missing provider 'EmailService' required by NotificationService
  --> src/notification/notification.service.ts:12:5

✗ ZNIGHT002: Circular dependency: OrderService -> PaymentService -> OrderService
  --> src/order/order.service.ts:8:3

Build failed with 2 errors.
```

---

## Stack Technique

| Composant     | Choix            | Raison                                  |
| ------------- | ---------------- | --------------------------------------- |
| Monorepo      | Nx + pnpm        | Scalable, cache, affected               |
| AST Analysis  | ts-morph         | API haut niveau sur TypeScript compiler |
| Build         | Vite             | Rapide, plugin system                   |
| HTTP (perf)   | Fastify          | Performance                             |
| HTTP (compat) | Express, Hono    | Options                                 |
| Validation    | Zod              | Type inference                          |
| Logging       | Pino             | Performance                             |
| Metrics       | prom-client      | Standard                                |
| Tracing       | @opentelemetry/* | Standard                                |
| Testing       | Vitest           | Rapide, TS natif                        |
| Package build | tsdown           | Rapide, moderne, simple                 |

---

## TODO List

### Phase 1 - Compiler Foundation (Priorité HAUTE)

- [ ] Package `@znight/compiler`
  - [ ] Plugin Vite de base (hook buildStart, handleHotUpdate)
  - [ ] Analyzer: extraction @Injectable (nom, scope, dependencies, lifecycle)
  - [ ] Analyzer: extraction @Controller (basePath, routes, params)
  - [ ] Analyzer: extraction @Consumer (queue, handler, retry)
  - [ ] Validator: dépendances manquantes (ZNIGHT001)
  - [ ] Validator: cycles détectés (ZNIGHT002)
  - [ ] Validator: scope mismatch - singleton dépend de request (ZNIGHT003)
  - [ ] Validator: duplicate providers (ZNIGHT004)
  - [ ] Generator: génération du container.generated.ts
  - [ ] Generator: topological sort pour resolutionOrder
  - [ ] Utils: formatage des erreurs (picocolors)
  - [ ] Tests unitaires pour chaque analyzer/validator

### Phase 2 - Core Runtime

- [ ] Package `@znight/core`
  - [ ] Decorators markers: @Injectable, @Inject, @Optional
  - [ ] Interfaces lifecycle: OnStart, OnStop, OnReady
  - [ ] Container runtime minimal
  - [ ] Gestion des scopes (singleton, request, transient)
  - [ ] Plugin system (interface Plugin, onBootstrap, onStart, onStop)
  - [ ] Application.create() bootstrap
  - [ ] Graceful shutdown (SIGTERM, SIGINT)
  - [ ] Tests unitaires

### Phase 3 - HTTP Plugin

- [ ] Package `@znight/http`
  - [ ] Decorators: @Controller, @Get, @Post, @Put, @Delete, @Patch
  - [ ] Decorators params: @Param, @Query, @Body, @Headers, @Req, @Res
  - [ ] Decorators middleware: @UseGuard, @UseInterceptor
  - [ ] Decorator validation: @Validate (intégration Zod)
  - [ ] Adapter interface
  - [ ] FastifyAdapter
  - [ ] ExpressAdapter
  - [ ] HonoAdapter
  - [ ] Router: registration automatique depuis metadata
  - [ ] Guard interface & execution pipeline
  - [ ] Interceptor interface & execution pipeline
  - [ ] HttpPlugin.configure()
  - [ ] Tests e2e

### Phase 4 - Advanced Compiler Features

- [ ] Source maps pour les erreurs (pointer vers le bon fichier/ligne)
- [ ] Watch mode optimisé (incremental analysis)
- [ ] Validation des interfaces sans implémentation (ZNIGHT008)
- [ ] Validation des signatures lifecycle (ZNIGHT009)
- [ ] Support des génériques dans les providers
- [ ] Support @Inject avec interface token

### Phase 5 - Config Plugin

- [ ] Package `@znight/config`
  - [ ] Decorators: @Config, @Env, @Default, @Secret
  - [ ] Loader: environment variables
  - [ ] Loader: .env files (dotenv)
  - [ ] Loader: JSON/YAML files
  - [ ] Loader: remote (Vault, AWS Secrets Manager)
  - [ ] Validation au boot (required configs)
  - [ ] Type-safe config classes
  - [ ] ConfigPlugin.configure()

### Phase 6 - Observability Plugin

- [ ] Package `@znight/observability`
  - [ ] Logging
    - [ ] Logger injectable avec contexte auto (requestId, traceId)
    - [ ] Pino integration
    - [ ] Transports: Console, Datadog, CloudWatch
    - [ ] Decorator @Logged pour log auto des méthodes
  - [ ] Metrics
    - [ ] Prometheus integration (prom-client)
    - [ ] Decorator @Metric pour counters auto
    - [ ] HTTP metrics automatiques
    - [ ] Custom metrics API
  - [ ] Tracing
    - [ ] OpenTelemetry integration
    - [ ] Decorator @Traced
    - [ ] Auto-instrumentation HTTP
    - [ ] Context propagation
  - [ ] ObservabilityPlugin.configure()

### Phase 7 - Messaging Plugin

- [ ] Package `@znight/messaging`
  - [ ] Decorators: @Consumer, @OnMessage, @OnError, @Retry
  - [ ] MessageBroker interface injectable
  - [ ] Driver interface
  - [ ] RabbitMQDriver
  - [ ] SQSDriver
  - [ ] KafkaDriver
  - [ ] Retry avec backoff (fixed, exponential)
  - [ ] Dead Letter Queue support
  - [ ] MessagingPlugin.configure()
  - [ ] Tests avec testcontainers

### Phase 8 - Testing Utilities

- [ ] Package `@znight/testing`
  - [ ] TestBed.create() avec auto-mocking des dépendances
  - [ ] Mock factories
  - [ ] TestApp pour tests e2e HTTP
  - [ ] app.inject() pour requêtes sans network
  - [ ] Helpers pour messaging (fake consumers)
  - [ ] Integration vitest

### Phase 9 - CLI

- [ ] Package `@znight/cli`
  - [ ] Command: `znight new <project-name>`
  - [ ] Command: `znight generate service <name>`
  - [ ] Command: `znight generate controller <name>`
  - [ ] Command: `znight generate consumer <name>`
  - [ ] Command: `znight dev` (vite dev avec hot reload)
  - [ ] Command: `znight build` (vite build)
  - [ ] Command: `znight start` (run production)
  - [ ] Templates pour génération

### Phase 10 - Documentation & Examples

- [ ] README.md complet
- [ ] Documentation site (VitePress?)
- [ ] Example: Simple REST API
- [ ] Example: Microservice avec messaging
- [ ] Example: Worker/Consumer
- [ ] Example: Monorepo multi-services
- [ ] Contributing guide
- [ ] Logo & branding

---

## Codes d'Erreur Compiler

| Code      | Description                                             |
| --------- | ------------------------------------------------------- |
| ZNIGHT001 | Missing provider - dépendance requise non trouvée       |
| ZNIGHT002 | Circular dependency - cycle détecté dans le graphe      |
| ZNIGHT003 | Scope mismatch - singleton dépend de request/transient  |
| ZNIGHT004 | Duplicate provider - même nom sans @Primary             |
| ZNIGHT005 | Invalid decorator usage                                 |
| ZNIGHT006 | Missing required config                                 |
| ZNIGHT007 | Invalid route definition                                |
| ZNIGHT008 | Ambiguous injection - multiple candidates sans @Primary |
| ZNIGHT009 | Invalid lifecycle hook signature                        |

---

## API Cible (DX)

### Bootstrap minimal

```typescript
// main.ts
import { Application } from '@znight/core'
import { HttpPlugin } from '@znight/http'
import { __ZNIGHT_METADATA__ } from './.znight/container.generated'

const app = await Application.create({
  metadata: __ZNIGHT_METADATA__,
  plugins: [HttpPlugin.configure({ port: 3000 })],
})

await app.start()
```

### Service simple

```typescript
@Injectable()
export class UserService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly logger: Logger,
  ) {}

  async findById(id: string): Promise<User> {
    this.logger.info('Finding user', { id })
    return this.db.query('SELECT * FROM users WHERE id = $1', [id])
  }
}
```

### Controller

```typescript
@Controller('/users')
export class UserController {
  constructor(private users: UserService) {}

  @Get('/:id')
  @UseGuard(AuthGuard)
  async getUser(@Param('id') id: string): Promise<User> {
    return this.users.findById(id);
  }

  @Post('/')
  @Validate(CreateUserDto)
  async createUser(@Body() dto: CreateUserDto): Promise<User> {
    return this.users.create(dto);
  }
}
```

### Consumer

```typescript
@Consumer('orders')
export class OrderConsumer {
  constructor(private orders: OrderService) {}

  @OnMessage()
  @Retry({ attempts: 3, backoff: 'exponential' })
  async handleOrder(@Message() msg: OrderCreatedEvent) {
    await this.orders.process(msg);
  }
}
```

### Config typée

```typescript
@Config('database')
export class DatabaseConfig {
  @Env('DB_HOST')
  @Default('localhost')
  host: string

  @Env('DB_PORT')
  @Default(5432)
  port: number

  @Secret('DB_PASSWORD')
  password: string
}
```

### Tests

```typescript
describe('UserService', () => {
  it('should create user', async () => {
    const { service, mocks } = await TestBed.create(UserService)

    mocks.get(DatabaseClient).findOne.mockResolvedValue(null)

    const user = await service.create({ email: 'test@test.com' })

    expect(user).toBeDefined()
    expect(mocks.get(DatabaseClient).save).toHaveBeenCalled()
  })
})
```

---

## Comparaison avec NestJS

```typescript
// ❌ NestJS - Verbose avec modules
@Module({
  imports: [TypeOrmModule.forRoot(dbConfig), TypeOrmModule.forFeature([User]), ConfigModule.forRoot(), LoggerModule],
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
  metadata: __ZNIGHT_METADATA__,
  plugins: [HttpPlugin, DatabasePlugin],
})
```

---

## Notes Techniques

### Pourquoi ts-morph ?

ts-morph offre une API haut niveau au-dessus du TypeScript compiler. C'est plus simple que d'utiliser directement `typescript` pour :
- Parser les decorators
- Extraire les types des paramètres de constructeur
- Naviguer dans l'AST
- Obtenir les informations de position (file, line, column)

### Pourquoi pas reflect-metadata ?

1. **Performance** - La reflection au runtime a un coût
2. **Cold start** - Critique pour serverless/edge
3. **Tree-shaking** - Impossible avec metadata runtime
4. **Debugging** - Le code généré est lisible et debuggable
5. **Validation** - Erreurs à la compilation, pas au boot

### Gestion des scopes

- **singleton** - Une instance pour toute l'app (default)
- **request** - Une instance par requête HTTP (via AsyncLocalStorage)
- **transient** - Nouvelle instance à chaque injection

Règle : un scope plus stable ne peut pas dépendre d'un scope moins stable.
- ✅ request peut dépendre de singleton
- ❌ singleton ne peut PAS dépendre de request

---

## Ressources & Inspiration

- [Micronaut](https://micronaut.io/) - Compile-time DI en Java
- [Dagger 2](https://dagger.dev/) - Compile-time DI pour Android
- [NestJS](https://nestjs.com/) - API et DX à suivre
- [Spring Boot](https://spring.io/projects/spring-boot) - Conventions et patterns
- [ts-morph](https://ts-morph.com/) - AST manipulation
- [Fastify](https://www.fastify.io/) - HTTP performance

---

## Commandes de Développement

```bash
# Install
pnpm install

# Build all packages
pnpm build

# Test all packages
pnpm test

# Dev mode (example app)
pnpm dev

# Lint
pnpm lint

# Build specific package
nx build @znight/compiler

# Test specific package
nx test @znight/core
```

---

## Prochaines Étapes Immédiates

1. **Créer le repo GitHub** avec la description fournie
2. **Initialiser le monorepo** avec Nx + pnpm
3. **Implémenter `@znight/compiler`** - C'est le cœur, la partie la plus challengante
4. **Écrire des tests** pour valider l'analyse AST
5. **Créer une app example** pour tester en conditions réelles
6. **Itérer** sur le compiler avant de passer aux autres packages

---

_Last updated: Conversation du jour_
