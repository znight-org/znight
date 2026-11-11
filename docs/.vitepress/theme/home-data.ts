/**
 * Content of the home page sections rendered by components (home.ts): the three steps of "How it
 * works", the package tiles and the example cards. Kept apart from the markup so that wording
 * changes do not touch the components.
 *
 * Icons are the inner markup of a 24×24 line icon (stroke 2, round caps and joins), the style of the
 * feature icons of `docs/index.md`.
 */

/** A link of the site, absolute and without extension (`withBase` adds the base path). */
type SitePath = `/${string}`

export interface HomeStep {
  readonly title: string
  readonly text: string
  readonly icon: string
  readonly link: SitePath
  readonly linkText: string
}

export interface HomePackage {
  /** Package name without the scope: `http` for `@znight/http`, also the page `/packages/<name>`. */
  readonly name: string
  readonly text: string
  readonly tags: readonly string[]
  readonly icon: string
}

export interface HomeExample {
  /** Folder of `examples/`, also the heading anchor of `/examples`. */
  readonly name: string
  readonly text: string
  readonly tags: readonly string[]
}

export const STEPS: readonly HomeStep[] = [
  {
    title: 'Write plain classes',
    text: 'Services, controllers, consumers and jobs are classes with typed constructors. Decorators only mark them: no tokens, no modules, no reflect-metadata.',
    icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="m10 13-2 2 2 2M14 13l2 2-2 2"/>',
    link: '/guide/automatic-wiring',
    linkText: 'Automatic wiring',
  },
  {
    title: 'The compiler solves the graph',
    text: 'At build time (Vite plugin, CLI or Bun preload), it binds every parameter, checks scopes, cycles and routes, and writes container.generated.ts.',
    icon: '<circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="12" cy="18" r="3"/><path d="M9 6h6M7.5 8.6l3 6.8M16.5 8.6l-3 6.8"/>',
    link: '/guide/compiler',
    linkText: 'How the compiler works',
  },
  {
    title: 'The runtime calls factories',
    text: 'createApplication(), written by the compiler, calls the generated factories in a precomputed order. Nothing is looked up or reflected at boot.',
    icon: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/>',
    link: '/guide/lifecycle',
    linkText: 'Application lifecycle',
  },
]

/** The two packages every application uses. */
export const BASE_PACKAGES: readonly HomePackage[] = [
  {
    name: 'core',
    text: 'Container, lifecycle, plugins, hooks, AOP and the marker decorators',
    tags: [],
    icon: '<path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="m3 7 9 5 9-5M12 12v10"/>',
  },
  {
    name: 'compiler',
    text: 'Analysis, validation and code generation: Vite plugin, CLI, Bun preload',
    tags: [],
    icon: '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>',
  },
]

/** The feature packages, each a page `/packages/<name>`. */
export const PACKAGES: readonly HomePackage[] = [
  {
    name: 'http',
    text: 'Controllers, Standard Schema validation, guards, access decisions, files and streams',
    tags: ['node:http · Fastify · Express · Hono', 'cookies · SSE · uploads · CORS'],
    icon: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  },
  {
    name: 'graphql',
    text: 'A schema derived from your types or SDL files checked against your resolvers',
    tags: ['code-first · schema-first', 'loaders · SSE subscriptions', 'Yoga driver'],
    icon: '<path d="M12 2.5 20.5 7.25v9.5L12 21.5l-8.5-4.75v-9.5z"/><path d="M12 2.5 3.5 16.75h17z"/>',
  },
  {
    name: 'websocket',
    text: 'Gateways on the HTTP server: handshakes through the HTTP pipeline, validated events',
    tags: ['rooms · replies · backpressure', 'ws · Bun native'],
    icon: '<path d="M4 8h14l-3-3"/><path d="M20 16H6l3 3"/>',
  },
  {
    name: 'messaging',
    text: 'Consumers with validated payloads, retries with backoff and dead-letter queues',
    tags: ['RabbitMQ · SQS · Kafka · memory', 'retries · dead letters'],
    icon: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  },
  {
    name: 'events',
    text: 'In-process application events with listeners wired at build time',
    tags: ['@OnEvent', 'inline · detached'],
    icon: '<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/>',
  },
  {
    name: 'schedule',
    text: 'Cron, interval and timeout jobs checked at build time, drained on shutdown',
    tags: ['time zones · overlap', 'locks · virtual clock'],
    icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  },
  {
    name: 'openapi',
    text: 'An OpenAPI 3.1 document built from your controllers at compile time',
    tags: ['Scalar · Swagger UI', 'znight openapi'],
    icon: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/><path d="M9 8h7M9 12h5"/>',
  },
  {
    name: 'config',
    text: 'Typed config classes validated at boot, mapped to environment variables by name',
    tags: ['env · .env · JSON · YAML', 'Vault · AWS · GCP secrets'],
    icon: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  },
  {
    name: 'observability',
    text: 'Logs, metrics and traces on every request, message and job',
    tags: ['Pino', 'Prometheus', 'OpenTelemetry'],
    icon: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  },
  {
    name: 'testing',
    text: 'TestBed auto-mocks dependencies; TestApp runs the real application in memory',
    tags: ['TestBed · TestApp', 'Bun · Vitest · Jest'],
    icon: '<path d="M10 2v7.5a2 2 0 0 1-.2.9L4.7 20.6a1 1 0 0 0 .9 1.4h12.8a1 1 0 0 0 .9-1.4l-5.1-10.2a2 2 0 0 1-.2-.9V2"/><path d="M8.5 2h7"/><path d="M7 16h10"/>',
  },
  {
    name: 'cli',
    text: 'The znight binary: scaffold, generate, develop, build and start',
    tags: ['new · generate · dev', 'build · start · openapi'],
    icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  },
]

export const EXAMPLES: readonly HomeExample[] = [
  {
    name: 'rest-api',
    text: 'The reference HTTP service: Drizzle on PGlite, API keys, uploads and downloads, events.',
    tags: ['Fastify', 'Drizzle', 'events'],
  },
  {
    name: 'secure-api',
    text: 'JWT, API keys, cookie sessions, CSRF, rate limiting and signed webhooks: the Security guide.',
    tags: ['node:http', 'access decisions'],
  },
  {
    name: 'storefront-api',
    text: 'An OpenAPI document generated from the code, served with Scalar, and a typed client.',
    tags: ['Hono', 'OpenAPI'],
  },
  {
    name: 'uptime-monitor',
    text: 'Scheduled and dynamic jobs, one runner across instances, live results over SSE.',
    tags: ['Hono', 'schedule', 'SSE'],
  },
  {
    name: 'graphql-api',
    text: 'A schema derived from the types, loaders against N+1 queries, subscriptions over SSE.',
    tags: ['Hono', 'GraphQL'],
  },
  {
    name: 'realtime-chat',
    text: 'WebSocket gateways on the HTTP server: rooms, single-use tickets, guards, a binary feed.',
    tags: ['node:http', 'WebSocket'],
  },
  {
    name: 'microservice',
    text: 'HTTP and messaging in one service, retries, dead letters, traces from request to consumer.',
    tags: ['Hono', 'RabbitMQ', 'OpenTelemetry'],
  },
  {
    name: 'worker',
    text: 'Message consumers without HTTP, a request scope per message, draining on shutdown.',
    tags: ['messaging', 'no HTTP'],
  },
  {
    name: 'monorepo',
    text: 'Two services sharing a provider library and overriding its providers.',
    tags: ['Express', 'provider library'],
  },
]
