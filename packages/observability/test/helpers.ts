import type {
  DependencyRef,
  ExternalDefinition,
  HttpRequestEvent,
  MessageDeliveryEvent,
  ProviderDefinition,
  Token,
  ZnightMetadata,
} from '@znight/core'

import { context } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'

/** One parsed log entry. */
export type Entry = Record<string, unknown> & { readonly msg?: string; readonly level?: number | string }

/** A destination stream recording every entry (parsed). */
export function capture(): { readonly stream: { write(line: string): void }; readonly entries: Entry[] } {
  const entries: Entry[] = []
  return { stream: { write: line => entries.push(JSON.parse(line) as Entry) }, entries }
}

/** Registers an AsyncLocalStorage context manager once per process (OpenTelemetry globals). */
export function enableContextManager(): void {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
}

/** A tracer provider exporting to memory. */
export function memoryTracing(): { readonly provider: BasicTracerProvider; readonly exporter: InMemorySpanExporter } {
  enableContextManager()
  const exporter = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  return { provider, exporter }
}

/** A W3C `traceparent` value. */
export const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736'
export const PARENT_SPAN_ID = '00f067aa0ba902b7'
export const TRACEPARENT = `00-${TRACE_ID}-${PARENT_SPAN_ID}-01`

/** An `http:request` event, as `@znight/http` produces it. */
export function httpEvent(overrides: Partial<HttpRequestEvent> = {}): HttpRequestEvent {
  return {
    method: 'GET',
    path: '/users/42',
    route: '/users/:id',
    requestId: 'req-1',
    headers: {},
    context: undefined,
    startTime: performance.now(),
    responseHeaders: {},
    ...overrides,
  }
}

/** A `messaging:message` event, as `@znight/messaging` produces it. */
export function messageEvent(overrides: Partial<MessageDeliveryEvent> = {}): MessageDeliveryEvent {
  return {
    queue: 'orders',
    type: 'order.created',
    messageId: 'msg-1',
    attempt: 1,
    headers: {},
    consumer: 'OrderConsumer',
    handler: 'onCreated',
    message: undefined,
    startTime: performance.now(),
    ...overrides,
  }
}

/** Token of a test provider declared in `src/app.ts`. */
export function t(name: string): Token {
  return `src/app.ts#${name}`
}

/** A provider definition with a custom factory. */
export function factoryDef(
  factory: (deps: unknown[]) => unknown,
  deps: readonly DependencyRef[] = [],
  extra: Partial<ProviderDefinition> = {},
): ProviderDefinition {
  return { scope: 'singleton', deps, factory, ...extra }
}

/** Hand-written metadata, shaped like the compiler output (providers given in resolution order). */
export function meta(
  providers: Readonly<Record<Token, ProviderDefinition>>,
  externals: readonly ExternalDefinition[] = [],
): ZnightMetadata {
  return { version: 1, compiler: '0.1.0', providers, resolutionOrder: Object.keys(providers), externals }
}

/** Captures the error thrown by `fn` (sync or async). Fails when nothing is thrown. */
export async function caught(fn: () => unknown): Promise<unknown> {
  try {
    await fn()
  } catch (error) {
    return error
  }
  throw new Error('Expected an error to be thrown')
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
