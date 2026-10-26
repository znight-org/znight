import type { InboundMessage } from '@znight/messaging'

/** A parsed log entry (pino JSON line). */
export interface LogEntry {
  readonly msg: string
  readonly level: number
  readonly [field: string]: unknown
}

/** Collects the log entries of an `ObservabilityPlugin` (`logging: { destination }`). */
export function captureLogs(): { readonly entries: LogEntry[]; readonly destination: { write(line: string): void } } {
  const entries: LogEntry[] = []
  return { entries, destination: { write: line => entries.push(JSON.parse(line) as LogEntry) } }
}

/** An `InboundMessage` as MessagingPlugin would build it, for unit tests. */
export function inboundMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'message-1',
    queue: 'test-queue',
    type: undefined,
    payload: undefined,
    headers: {},
    key: undefined,
    attempt: 1,
    maxAttempts: 3,
    redelivered: false,
    timestamp: undefined,
    receivedAt: Date.now(),
    contentType: 'application/json',
    body: '',
    driver: 'memory',
    raw: undefined,
    signal: new AbortController().signal,
    ...overrides,
  }
}
