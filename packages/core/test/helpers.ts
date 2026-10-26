import type {
  CoreLogger,
  DependencyRef,
  ExternalDefinition,
  LogContext,
  ProviderClass,
  ProviderDefinition,
  Token,
  ZnightMetadata,
} from '../src/index.ts'

/** Token of a test provider declared in `src/app.ts`. */
export function t(name: string): Token {
  return `src/app.ts#${name}`
}

type Ctor = new (...args: never[]) => unknown

/** A provider definition for a class: `factory: d => new cls(...d)`. */
export function classDef<C extends Ctor>(
  cls: C,
  deps: readonly DependencyRef[] = [],
  extra: Partial<ProviderDefinition> = {},
): ProviderDefinition {
  return {
    scope: 'singleton',
    class: cls as unknown as ProviderClass,
    deps,
    factory: (resolved: unknown[]) => new cls(...(resolved as never[])),
    ...extra,
  }
}

/** A provider definition with a custom factory. */
export function factoryDef(
  factory: (deps: unknown[]) => unknown,
  deps: readonly DependencyRef[] = [],
  extra: Partial<ProviderDefinition> = {},
): ProviderDefinition {
  return { scope: 'singleton', deps, factory, ...extra }
}

function hardDeps(definition: ProviderDefinition): Token[] {
  const tokens: Token[] = []
  for (const ref of definition.deps) {
    if (typeof ref === 'string') tokens.push(ref)
    else if ('multi' in ref) tokens.push(...ref.multi)
    else if ('token' in ref) tokens.push(ref.token)
  }
  return tokens
}

/** Deterministic topological order (dependencies first), like the compiler's `resolutionOrder`. */
export function topologicalOrder(providers: Readonly<Record<Token, ProviderDefinition>>): Token[] {
  const order: Token[] = []
  const state = new Map<Token, number>()
  const visit = (token: Token): void => {
    if (state.get(token) === 2 || !Object.hasOwn(providers, token)) return
    if (state.get(token) === 1) return // cycles are left to the runtime to report
    state.set(token, 1)
    for (const dep of hardDeps(providers[token] as ProviderDefinition)) visit(dep)
    state.set(token, 2)
    order.push(token)
  }
  for (const token of Object.keys(providers).sort()) visit(token)
  return order
}

export interface MetadataOptions {
  readonly order?: readonly Token[]
  readonly aliases?: Readonly<Record<Token, Token>>
  readonly externals?: readonly ExternalDefinition[]
  readonly version?: number
}

/** Hand-written metadata, shaped like the compiler output. */
export function meta(
  providers: Readonly<Record<Token, ProviderDefinition>>,
  options: MetadataOptions = {},
): ZnightMetadata {
  return {
    version: options.version ?? 1,
    compiler: '0.1.0',
    providers,
    resolutionOrder: options.order ?? topologicalOrder(providers),
    ...(options.aliases === undefined ? {} : { aliases: options.aliases }),
    ...(options.externals === undefined ? {} : { externals: options.externals }),
  }
}

export interface LogEntry {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly context: LogContext | undefined
}

/** A logger recording every entry. */
export function memoryLogger(): CoreLogger & { readonly entries: LogEntry[] } {
  const entries: LogEntry[] = []
  return {
    entries,
    debug: (message, context) => entries.push({ level: 'debug', message, context }),
    info: (message, context) => entries.push({ level: 'info', message, context }),
    warn: (message, context) => entries.push({ level: 'warn', message, context }),
    error: (message, context) => entries.push({ level: 'error', message, context }),
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Resolves with `value` after `ms` milliseconds. */
export function later<T>(ms: number, value: T | (() => T)): Promise<T> {
  return sleep(ms).then(() => (typeof value === 'function' ? (value as () => T)() : value))
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

/** Synchronous variant of {@link caught}. */
export function caughtSync(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('Expected an error to be thrown')
}
